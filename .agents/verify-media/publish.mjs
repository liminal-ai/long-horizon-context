#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { STEP, sha256, tokenShaped } from "./capture.mjs";

const USAGE = `usage: publish.mjs --pr <n> [--title <text>] [--note <text>] <run dir>
  Publishes one capture.mjs run to a pull request of liminal-ai/long-horizon-context. Checks that every head capture
  ran at the PR's current head and every base capture at its merge base with the PR's base branch, none with
  uncommitted changes, with the same steps on both sides and no token-shaped text. Each PNG and text must match the
  hashes capture.mjs recorded, and each side's captures must carry one run id, so the files belong together.
  Checks the state of the gh user's PR comment marked <!-- lhc-captures --> before any upload. Uploads each PNG to
  Cloudflare Images under lhc/<random uuid>/, unsigned, through the cf CLI, and checks that its public URL serves a
  PNG of the same size. Writes published.json, so a second publish of the same run uploads nothing.
  Then adds or updates that comment, never another author's: one section per run for the PR's head, each step's base
  and head side by side. A run on a new head replaces the old head's runs.
  Reads CLOUDFLARE_ACCOUNT_ID, defaulting to the Liminal.builder account. Needs gh and cf, logged in.`;

const MARKER = "<!-- lhc-captures -->";
const STATE = /<!-- lhc-captures-state (\{.*\}) -->/;
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || "e8e382d5bf8ec24ee2125188819b995c";
const SIDES = ["base", "head"];

function fail(message) {
  console.error(`publish FAILED: ${message}`);
  process.exit(1);
}

function gh(args, input) {
  const r = spawnSync("gh", args, { input, encoding: "utf8" });
  if (r.status !== 0) fail(`gh ${args.slice(0, 3).join(" ")} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

function pngSize(bytes) {
  const signature = "89504e470d0a1a0a";
  if (bytes.length < 24 || bytes.subarray(0, 8).toString("hex") !== signature) return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function readRun(dir) {
  const sides = {};
  for (const side of SIDES) {
    const sideDir = join(dir, side);
    if (!existsSync(sideDir)) fail(`${dir} has no ${side}/ captures`);
    const steps = readdirSync(sideDir)
      .filter((f) => f.endsWith(".png"))
      .map((f) => f.slice(0, -4))
      .sort();
    if (steps.length === 0) fail(`${sideDir} has no captures`);
    const captures = steps.map((step) => {
      if (!STEP.test(step)) fail(`${sideDir}/${step}.png is not a capture.mjs step name`);
      const meta = join(sideDir, `${step}.json`);
      const text = join(sideDir, `${step}.txt`);
      if (!existsSync(meta) || !existsSync(text)) fail(`${sideDir}/${step}.png has no ${step}.json or ${step}.txt`);
      const textBytes = readFileSync(text);
      const token = tokenShaped(textBytes.toString("utf8"));
      if (token) fail(`${sideDir}/${step}.txt holds a token-shaped string (${token.slice(0, 6)}…); never publish it`);
      const png = readFileSync(join(sideDir, `${step}.png`));
      const size = pngSize(png);
      if (!size) fail(`${sideDir}/${step}.png is not a PNG`);
      const m = JSON.parse(readFileSync(meta, "utf8"));
      if (m.step !== step || m.side !== side || typeof m.run !== "string" || !m.run)
        fail(`${meta} is not capture.mjs metadata for ${side} ${step}; recapture`);
      if (m.png !== sha256(png) || m.text !== sha256(textBytes))
        fail(`${sideDir}/${step}.png or ${step}.txt is not the pair capture.mjs wrote; recapture`);
      return { step, png, size, file: join(sideDir, `${step}.png`), run: m.run, sha: m.sha, dirty: m.dirty };
    });
    const runs = [...new Set(captures.map((c) => c.run))];
    if (runs.length !== 1) fail(`${side} captures come from more than one run: ${runs.join(", ")}; recapture into one run dir`);
    const dirty = captures.find((c) => c.dirty);
    if (dirty) fail(`${side} ${dirty.step} ran at ${dirty.sha} with uncommitted changes; commit, push and recapture`);
    const shas = [...new Set(captures.map((c) => c.sha))];
    if (shas.length !== 1) fail(`${side} captures ran at more than one commit: ${shas.join(", ")}`);
    sides[side] = { sha: shas[0], captures };
  }
  const steps = (side) => sides[side].captures.map((c) => c.step).join(",");
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

async function upload(capture, id) {
  const r = spawnSync("cf", ["images", "create", "--file", capture.file, "--id", id, "--require-signed-urls=false"], {
    encoding: "utf8",
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
  });
  let image = null;
  try {
    image = JSON.parse(r.stdout);
  } catch {}
  // The account's `full` variant only scales down past 4000x12000, so a capture reads back at its own size; `public` fits 1366x768.
  const url =
    image?.variants?.find((v) => v.endsWith("/full")) ??
    image?.variants?.find((v) => v.endsWith("/public"))?.replace(/\/public$/, "/full");
  if (r.status !== 0 || image?.id !== id || !url)
    fail(`upload of ${capture.file} exited ${r.status}: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
  await readBack(url, capture.size);
  return url;
}

function digestOf(sides) {
  const h = createHash("sha256");
  for (const side of SIDES)
    for (const c of sides[side].captures) h.update(`${side}/${c.step}\0${c.sha}\0`).update(c.png);
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
        r.steps.every((s) => typeof s?.step === "string" && STEP.test(s.step) && url(s.base) && url(s.head)),
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
    "Screens captured by the project's verify skill from throwaway homes, base against head, and published to Cloudflare Images by `.agents/verify-media/publish.mjs`.",
    "",
  ];
  for (const run of state.runs) {
    lines.push(`### ${text(run.title)}`, "");
    if (run.note) lines.push(text(run.note), "");
    lines.push(`Base is \`${run.base}\`, the merge base. Head is \`${run.head}\`.`, "");
    for (const s of run.steps) {
      const img = (u) => `<a href="${u}"><img src="${u}" width="420"></a>`;
      lines.push(
        `**${s.step}**`,
        "",
        `| Base \`${run.base.slice(0, 7)}\` | Head \`${run.head.slice(0, 7)}\` |`,
        "| --- | --- |",
        `| ${img(s.base)} | ${img(s.head)} |`,
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
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  if (values.help || !values.pr || positionals.length !== 1) {
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
  if (cached?.digest === digest) {
    run = { ...cached.run, title: values.title ?? cached.run.title, note: values.note ?? cached.run.note };
    console.log(`uploaded 0 images: ${done} already holds this run`);
  } else {
    const id = randomUUID();
    const urls = {};
    for (const side of SIDES)
      for (const c of sides[side].captures) {
        urls[`${side}/${c.step}`] = await upload(c, `lhc/${id}/${side}-${c.step}.png`);
        console.log(`uploaded ${side} ${c.step}: ${urls[`${side}/${c.step}`]}`);
      }
    run = {
      id,
      title: values.title ?? basename(dir),
      note: values.note ?? "",
      base: sides.base.sha,
      head: sides.head.sha,
      steps: sides.head.captures.map((c) => ({ step: c.step, base: urls[`base/${c.step}`], head: urls[`head/${c.step}`] })),
    };
    writeFileSync(done, `${JSON.stringify({ digest, run }, null, 2)}\n`);
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
