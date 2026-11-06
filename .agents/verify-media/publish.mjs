#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { STEP, sha256, tokenShaped } from "./capture.mjs";

const USAGE = `usage: publish.mjs --pr <n> [--title <text>] [--note <text>] [--ready-timeout <seconds>] <run dir>
  Publishes one capture.mjs run to a pull request of liminal-ai/long-horizon-context. Checks that every head capture
  ran at the PR's current head and every base capture at its merge base with the PR's base branch, none with
  uncommitted changes, with the same steps on both sides and no token-shaped text. Each PNG or MP4 and its text must
  match the hashes capture.mjs recorded and sit inside the run dir, and each side's captures must carry one run id, so
  the files belong together.
  Checks the state of the gh user's PR comment marked <!-- lhc-captures --> before any upload. Uploads each PNG to
  Cloudflare Images under lhc/<random uuid>/, unsigned, through the cf CLI, and checks that its public URL serves a
  PNG of the same size. Uploads each MP4 to Cloudflare Stream through a one-time direct upload URL, unsigned and
  deleted after 90 days, waits up to --ready-timeout seconds (default 300) for it to be ready to stream, and checks
  that its thumbnail, HLS manifest and watch page serve. Records each upload in published.json as it lands, so a
  second publish of the same run uploads nothing.
  Then adds or updates that comment, never another author's: one section per run for the PR's head, each step's base
  and head side by side. A run on a new head replaces the old head's runs.
  Reads CLOUDFLARE_ACCOUNT_ID, defaulting to the Liminal.builder account. Needs gh and cf, logged in.`;

const MARKER = "<!-- lhc-captures -->";
const STATE = /<!-- lhc-captures-state (\{.*\}) -->/;
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || "e8e382d5bf8ec24ee2125188819b995c";
const SIDES = ["base", "head"];
const STREAM_KEEP_DAYS = 90;

function fail(message) {
  console.error(`publish FAILED: ${message}`);
  process.exit(1);
}

function gh(args, input) {
  const r = spawnSync("gh", args, { input, encoding: "utf8" });
  if (r.status !== 0) fail(`gh ${args.slice(0, 3).join(" ")} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

function cf(args) {
  const r = spawnSync("cf", args, { encoding: "utf8", env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT } });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {}
  return { status: r.status, json, said: (r.stderr || r.stdout).trim().slice(0, 400) };
}

function pngSize(bytes) {
  const signature = "89504e470d0a1a0a";
  if (bytes.length < 24 || bytes.subarray(0, 8).toString("hex") !== signature) return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function readRun(dir) {
  const root = realpathSync(dir);
  const sides = {};
  for (const side of SIDES) {
    const sideDir = join(dir, side);
    if (!existsSync(sideDir)) fail(`${dir} has no ${side}/ captures`);
    const media = readdirSync(sideDir)
      .map((f) => /^(.*)\.(png|mp4)$/.exec(f))
      .filter(Boolean)
      .map(([, step, kind]) => ({ step, kind }))
      .sort((a, b) => (a.step < b.step ? -1 : a.step > b.step ? 1 : 0));
    if (media.length === 0) fail(`${sideDir} has no captures`);
    const captures = media.map(({ step, kind }, i) => {
      const file = join(sideDir, `${step}.${kind}`);
      if (!STEP.test(step)) fail(`${file} is not a capture.mjs step name`);
      if (media[i + 1]?.step === step) fail(`${sideDir} has both ${step}.png and ${step}.mp4; keep one per step`);
      const meta = join(sideDir, `${step}.json`);
      const text = join(sideDir, `${step}.txt`);
      if (!existsSync(meta) || !existsSync(text)) fail(`${file} has no ${step}.json or ${step}.txt`);
      for (const f of [file, meta, text]) {
        const real = realpathSync(f);
        if (!real.startsWith(root + sep)) fail(`${f} resolves to ${real}, outside the run dir ${root}; recapture into it`);
      }
      const textBytes = readFileSync(text);
      const token = tokenShaped(textBytes.toString("utf8"));
      if (token) fail(`${sideDir}/${step}.txt holds a token-shaped string (${token.slice(0, 6)}…); never publish it`);
      const bytes = readFileSync(file);
      const size = kind === "png" ? pngSize(bytes) : null;
      if (kind === "png" && !size) fail(`${file} is not a PNG`);
      if (kind === "mp4" && bytes.subarray(4, 8).toString("latin1") !== "ftyp") fail(`${file} is not an MP4`);
      const m = JSON.parse(readFileSync(meta, "utf8"));
      if (m.step !== step || m.side !== side || typeof m.run !== "string" || !m.run)
        fail(`${meta} is not capture.mjs metadata for ${side} ${step}; recapture`);
      if (m[kind] !== sha256(bytes) || m.text !== sha256(textBytes))
        fail(`${file} or ${step}.txt is not the pair capture.mjs wrote; recapture`);
      return { step, kind, bytes, size, file, run: m.run, sha: m.sha, dirty: m.dirty };
    });
    const runs = [...new Set(captures.map((c) => c.run))];
    if (runs.length !== 1) fail(`${side} captures come from more than one run: ${runs.join(", ")}; recapture into one run dir`);
    const dirty = captures.find((c) => c.dirty);
    if (dirty) fail(`${side} ${dirty.step} ran at ${dirty.sha} with uncommitted changes; commit, push and recapture`);
    const shas = [...new Set(captures.map((c) => c.sha))];
    if (shas.length !== 1) fail(`${side} captures ran at more than one commit: ${shas.join(", ")}`);
    sides[side] = { sha: shas[0], captures };
  }
  const steps = (side) => sides[side].captures.map((c) => `${c.step}.${c.kind}`).join(",");
  if (steps("base") !== steps("head")) fail(`base steps [${steps("base")}] differ from head steps [${steps("head")}]`);
  return sides;
}

/** Fails unless the public URL serves a PNG with the uploaded size. Images re-encodes, so bytes are not compared. */
async function readBack(url, size) {
  const r = await fetch(url, { headers: { accept: "image/png" } });
  const type = r.headers.get("content-type") ?? "";
  const got = pngSize(Buffer.from(await r.arrayBuffer()));
  if (!r.ok || !type.startsWith("image/png") || got?.width !== size.width || got?.height !== size.height)
    fail(
      `${url} reads back ${r.status} ${type || "no content type"} ${got ? `${got.width}x${got.height}` : "not a PNG"}, not a ${size.width}x${size.height} PNG`,
    );
}

async function uploadImage(capture, id) {
  const r = cf(["images", "create", "--file", capture.file, "--id", id, "--require-signed-urls=false"]);
  const image = r.json;
  // The account's `full` variant only scales down past 4000x12000, so a capture reads back at its own size; `public` fits 1366x768.
  const url =
    image?.variants?.find((v) => v.endsWith("/full")) ??
    image?.variants?.find((v) => v.endsWith("/public"))?.replace(/\/public$/, "/full");
  if (r.status !== 0 || image?.id !== id || !url)
    fail(`upload of ${capture.file} exited ${r.status}: ${r.said}`);
  await readBack(url, capture.size);
  return url;
}

/** Posts the MP4 to a one-time Stream upload URL, so no API token leaves the cf CLI, and returns the video's uid. */
async function uploadVideo(capture, name) {
  const deletion = new Date(Date.now() + STREAM_KEEP_DAYS * 86_400_000).toISOString().replace(/\.\d+Z$/, "Z");
  const r = cf([
    ...["stream", "videos", "direct-upload", "create", "--max-duration-seconds", "300", "--require-signed-urls=false"],
    ...["--scheduled-deletion", deletion, "--meta", JSON.stringify({ name })],
  ]);
  const { uid, uploadURL } = r.json ?? {};
  if (r.status !== 0 || typeof uid !== "string" || !/^[0-9a-f]{32}$/.test(uid) || typeof uploadURL !== "string")
    fail(`upload of ${capture.file} exited ${r.status}: ${r.said}`);
  const form = new FormData();
  form.append("file", new Blob([capture.bytes], { type: "video/mp4" }), basename(capture.file));
  const posted = await fetch(uploadURL, { method: "POST", body: form }).catch((e) => ({ ok: false, status: e.message }));
  if (!posted.ok) fail(`upload of ${capture.file} to Stream video ${uid} returned ${posted.status}`);
  return uid;
}

/** Fails unless the video becomes ready to stream with a duration in time, and its thumbnail, HLS manifest and watch page serve. */
async function readyVideo(capture, uid, timeoutSeconds) {
  const end = Date.now() + timeoutSeconds * 1000;
  let video;
  for (;;) {
    const r = cf(["stream", "videos", "get", uid]);
    video = r.json;
    if (r.status !== 0 || video?.uid !== uid) fail(`reading Stream video ${uid} exited ${r.status}: ${r.said}`);
    if (video.readyToStream && video.duration > 0) break;
    const state = `${video.status?.state ?? "no state"}${video.status?.errorReasonText ? `: ${video.status.errorReasonText}` : ""}`;
    if (video.status?.state === "error") fail(`Stream video ${uid} (${capture.file}) failed processing, ${state}`);
    if (Date.now() > end) fail(`Stream video ${uid} (${capture.file}) is not ready to stream after ${timeoutSeconds} s, ${state}`);
    await new Promise((done) => setTimeout(done, 3000));
  }
  if (video.requireSignedURLs !== false) fail(`Stream video ${uid} requires signed URLs, which expire inside GitHub`);
  const urls = [video.thumbnail, video.preview, video.playback?.hls];
  if (!urls.every((u) => typeof u === "string")) fail(`Stream video ${uid} reports no thumbnail, watch page and HLS manifest`);
  // The last frame shows where the recording ended up, which is the change; Stream's default is the first frame.
  const thumbnail = `${video.thumbnail}?time=${Math.max(0, video.duration - 0.5).toFixed(1)}s`;
  for (const url of [thumbnail, video.playback.hls, video.preview]) {
    const got = await fetch(url).catch((e) => ({ ok: false, status: e.message }));
    if (!got.ok) fail(`Stream video ${uid}: ${url} reads back ${got.status}`);
  }
  return { uid, duration: video.duration, thumbnail, watch: video.preview, hls: video.playback.hls };
}

function digestOf(sides) {
  const h = createHash("sha256");
  for (const side of SIDES)
    for (const c of sides[side].captures) h.update(`${side}/${c.step}\0${c.sha}\0`).update(c.bytes);
  return h.digest("hex");
}

/** The runs a marked comment holds. Fails, before anything uploads, on a state block publish.mjs could not have written. */
function stateOf(comment) {
  const bad = (why) => fail(`comment ${comment.id} is marked ${MARKER} but its state ${why}; fix or delete it by hand`);
  const raw = STATE.exec(comment.body)?.[1];
  if (!raw) bad("block is missing");
  let state;
  try {
    state = JSON.parse(raw);
  } catch {
    bad("is not JSON");
  }
  const sha = (v) => typeof v === "string" && /^[0-9a-f]{40}$/.test(v);
  const url = (v) => typeof v === "string" && v.startsWith("https://");
  const ok =
    sha(state?.head) &&
    Array.isArray(state.runs) &&
    state.runs.every(
      (r) =>
        typeof r?.id === "string" &&
        typeof r.title === "string" &&
        typeof r.note === "string" &&
        sha(r.base) &&
        sha(r.head) &&
        Array.isArray(r.steps) &&
        r.steps.every(
          (s) =>
            typeof s?.step === "string" &&
            STEP.test(s.step) &&
            url(s.base) &&
            url(s.head) &&
            (s.watch === undefined || (url(s.watch?.base) && url(s.watch?.head))),
        ),
    );
  if (!ok) bad("does not hold a head commit and its runs");
  return state;
}

const text = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;");

function render(state) {
  const json = JSON.stringify(state).replace(/--/g, "-\\u002d");
  const lines = [
    MARKER,
    `## Before and after for ${state.head.slice(0, 7)}`,
    "",
    "Screens captured by the project's verify skill from throwaway homes, base against head, and published to Cloudflare Images and Stream by `.agents/verify-media/publish.mjs`. A video shows its last frame; open it to play.",
    "",
  ];
  for (const run of state.runs) {
    lines.push(`### ${text(run.title)}`, "");
    if (run.note) lines.push(text(run.note), "");
    lines.push(`Base is \`${run.base}\`, the merge base. Head is \`${run.head}\`.`, "");
    for (const s of run.steps) {
      const img = (side) => `<a href="${s.watch?.[side] ?? s[side]}"><img src="${s[side]}" width="420"></a>`;
      const play = (side) => (s.watch ? `<br><a href="${s.watch[side]}">▶ Play ${side} video</a>` : "");
      lines.push(
        `**${s.step}**${s.watch ? " (video)" : ""}`,
        "",
        `| Base \`${run.base.slice(0, 7)}\` | Head \`${run.head.slice(0, 7)}\` |`,
        "| --- | --- |",
        `| ${img("base")}${play("base")} | ${img("head")}${play("head")} |`,
        "",
      );
    }
  }
  lines.push(`<!-- lhc-captures-state ${json} -->`, "");
  return lines.join("\n");
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      pr: { type: "string" },
      title: { type: "string" },
      note: { type: "string" },
      "ready-timeout": { type: "string", default: "300" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const readyTimeout = Number(values["ready-timeout"]);
  if (values.help || !values.pr || positionals.length !== 1 || !(readyTimeout > 0)) {
    console.error(USAGE);
    process.exit(values.help ? 0 : 2);
  }
  const dir = resolve(positionals[0]);
  const repo = "liminal-ai/long-horizon-context";
  const pr = JSON.parse(gh(["pr", "view", values.pr, "--repo", repo, "--json", "headRefOid,baseRefName"]));
  const mergeBase = gh([
    "api",
    `repos/${repo}/compare/${pr.baseRefName}...${pr.headRefOid}`,
    "--jq",
    ".merge_base_commit.sha",
  ]).trim();

  const sides = readRun(dir);
  if (sides.head.sha !== pr.headRefOid)
    fail(`head captures ran at ${sides.head.sha}, not PR ${values.pr}'s head ${pr.headRefOid}`);
  if (sides.base.sha !== mergeBase)
    fail(`base captures ran at ${sides.base.sha}, not the merge base ${mergeBase} with ${pr.baseRefName}`);

  const me = gh(["api", "user", "--jq", ".login"]).trim();
  const found = gh([
    "api",
    "--paginate",
    `repos/${repo}/issues/${values.pr}/comments`,
    "--jq",
    `.[] | {id, login: .user.login, body}`,
  ])
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const existing = found.find((c) => c.login === me && c.body.startsWith(MARKER)) ?? null;
  const prev = existing ? stateOf(existing) : null;

  const digest = digestOf(sides);
  const done = join(dir, "published.json");
  const cached = existsSync(done) ? JSON.parse(readFileSync(done, "utf8")) : null;
  let run;
  if (cached?.digest === digest && cached.run) {
    run = { ...cached.run, title: values.title ?? cached.run.title, note: values.note ?? cached.run.note };
    console.log(`uploaded 0 images and 0 videos: ${done} already holds this run`);
  } else {
    // An earlier publish of these same files that failed part way keeps its uploads, so a video already in Stream is
    // waited on again rather than uploaded twice.
    const record = cached?.digest === digest ? cached : { digest, id: randomUUID(), uploads: {} };
    const save = () => writeFileSync(done, `${JSON.stringify(record, null, 2)}\n`);
    const count = { png: 0, mp4: 0 };
    const all = SIDES.flatMap((side) => sides[side].captures.map((c) => ({ c, key: `${side}/${c.step}` })));
    for (const { c, key } of all) {
      if (record.uploads[key]) continue;
      const name = `lhc/${record.id}/${key.replace("/", "-")}.${c.kind}`;
      record.uploads[key] = c.kind === "png" ? await uploadImage(c, name) : { uid: await uploadVideo(c, name) };
      count[c.kind]++;
      save();
      console.log(`uploaded ${key}: ${JSON.stringify(record.uploads[key])}`);
    }
    console.log(`uploaded ${count.png} images and ${count.mp4} videos`);
    // Every video uploads before any wait, so Stream processes them together.
    for (const { c, key } of all.filter(({ c }) => c.kind === "mp4")) {
      record.uploads[key] = await readyVideo(c, record.uploads[key].uid, readyTimeout);
      save();
      console.log(`ready ${key}: ${record.uploads[key].watch}`);
    }
    const src = (side, c) => record.uploads[`${side}/${c.step}`];
    record.run = {
      id: record.id,
      title: values.title ?? basename(dir),
      note: values.note ?? "",
      base: sides.base.sha,
      head: sides.head.sha,
      steps: sides.head.captures.map((c) =>
        c.kind === "png"
          ? { step: c.step, base: src("base", c), head: src("head", c) }
          : {
              step: c.step,
              base: src("base", c).thumbnail,
              head: src("head", c).thumbnail,
              watch: { base: src("base", c).watch, head: src("head", c).watch },
            },
      ),
    };
    save();
    run = record.run;
  }

  const kept = prev?.head === pr.headRefOid ? prev.runs : [];
  const runs = kept.some((r) => r.id === run.id) ? kept.map((r) => (r.id === run.id ? run : r)) : [...kept, run];
  const body = JSON.stringify({ body: render({ head: pr.headRefOid, runs }) });
  const posted = existing
    ? gh(["api", "-X", "PATCH", `repos/${repo}/issues/comments/${existing.id}`, "--input", "-"], body)
    : gh(["api", "-X", "POST", `repos/${repo}/issues/${values.pr}/comments`, "--input", "-"], body);
  console.log(`${existing ? "updated" : "added"} comment ${JSON.parse(posted).html_url}`);
}

await main();
