// C2 follow-up: proofs 2 (--priority steer) and 4 (Lee's path) with an organic
// mid-turn clarification instead of a codeword. The steer changes the running
// task's output; the check is that the final reply follows the changed format
// and the reads continue in order after the steer.
//
//   node --no-warnings scripts/organic-proof.ts --seat t3code-wren [--via relay|command] [--workspace DIR] [--out DIR]
//       [--steer-from fable] [--only steer|lee]
//
// --via command (default): runs the seat command exactly as the relay would,
// from the registry entry (bin, args, cwd, env) plus the relay's job env
// (LHC_RELAY_JOB_CLASS, LHC_RELAY_SENDER). Used when the live relay has not
// been restarted on the registry that names the seat's current thread.
// --via relay: the same through `lhc-agent`.
import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { BASE_URL, connect, fetchThread, now, Timeline, writeRecord } from "./lib.ts";
import { chainFiles, FIXTURE_FILE, linkOf, type Fixture } from "./fixtures.ts";

const { values: a } = parseArgs({ options: { seat: { type: "string" }, via: { type: "string", default: "command" }, out: { type: "string", default: "/srv/work/t3code-campaign/builders/wren/inject" }, workspace: { type: "string" }, "steer-from": { type: "string", default: "fable" }, only: { type: "string" } } });
const seat = a.seat ?? "t3code-wren";
const registry = JSON.parse(readFileSync(join(homedir(), ".lhc-console", "agents.json"), "utf8")) as { agents: Record<string, { relay: { threadId: string; command: string; args: string[]; cwd?: string; env?: Record<string, string> } }> };
const maybeEntry = registry.agents[seat]?.relay;
if (!maybeEntry) throw new Error(`no registry seat ${seat}`);
const entry = maybeEntry;
const threadId = entry.threadId;
const log: string[] = [];
const say = (line: string) => { const s = `[${now()}] ${line}`; log.push(s); console.log(s); };
say(`seat ${seat} via ${a.via}: thread ${threadId}; command ${entry.command} ${entry.args.join(" ")}`);

const { rpc, bearer } = await connect();
// The seat thread's workspace (the project root scripts/seat.ts created).
const workspace = a.workspace ?? join(homedir(), ".t3code-inject", "seats", `${seat}-2`);
mkdirSync(workspace, { recursive: true });
function freshChain(): Fixture {
  const fx = chainFiles();
  const stale = readdirSync(workspace).filter((name) => FIXTURE_FILE.test(name));
  for (const name of stale) rmSync(join(workspace, name));
  for (const [name, text] of Object.entries(fx.files)) writeFileSync(join(workspace, name), text);
  say(`fixture ${fx.tag}: ${Object.keys(fx.files).length} files written to ${workspace}; ${stale.length} stale fixture files removed`);
  return fx;
}
const timeline = new Timeline();
const unsubscribe = await rpc.subscribeThread(threadId, timeline.onItem, () => undefined);
interface Call { label: string; spawnedAt: string; done: Promise<{ code: number; stdout: string; stderr: string; exitedAt: string }> }
/** One job as the relay would run it (or as lhc-agent would submit it). `from` undefined = Lee's path. */
function job(label: string, prompt: string, opts: { from?: string; priority?: boolean }): Call {
  const spawnedAt = now();
  let file: string; let args: string[]; let cwd: string | undefined; let env: NodeJS.ProcessEnv;
  if (a.via === "relay") {
    file = "lhc-agent"; args = [...(opts.priority ? ["--priority"] : []), ...(opts.from ? ["--from", opts.from] : []), seat, prompt]; cwd = undefined;
    env = { ...process.env }; if (!opts.from) delete env.LHC_AGENT_ID;
  } else {
    file = entry.command; args = [...entry.args, prompt]; cwd = entry.cwd;
    env = { ...process.env, ...entry.env, LHC_RELAY_JOB_CLASS: opts.priority ? "prioritized" : "deprioritized", ...(opts.from ? { LHC_RELAY_SENDER: opts.from } : {}) };
    delete env.LHC_AGENT_ID; if (!opts.from) delete env.LHC_RELAY_SENDER;
  }
  const done = new Promise<{ code: number; stdout: string; stderr: string; exitedAt: string }>((resolve) =>
    execFile(file, args, { cwd, env, encoding: "utf8", maxBuffer: 8 << 20 }, (error, stdout, stderr) =>
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr, exitedAt: now() })));
  return { label, spawnedAt, done };
}
const ms = (c: Call, r: { exitedAt: string }) => Date.parse(r.exitedAt) - Date.parse(c.spawnedAt);
const usersSince = async (since: string) => (await fetchThread(BASE_URL, bearer, threadId)).messages.filter((m) => m.role === "user" && m.createdAt >= since).sort((x, y) => x.createdAt.localeCompare(y.createdAt));
const sessionsSince = (since: string) => timeline.entries.filter((e) => e.kind === "session" && e.at >= since);
const oneTurnBetween = (since: string, until: string) => sessionsSince(since).filter((e) => e.at <= until && e.detail.startsWith("running")).length === 1;
async function busyAfter(tools: number): Promise<void> {
  const base = timeline.toolsCompleted;
  await timeline.until(() => timeline.toolsCompleted >= base + tools, 180_000, `${tools} completed tools`);
}
const compactionsBetween = async (since: string, until: string) => (await fetchThread(BASE_URL, bearer, threadId)).activities.filter((x) => x.kind === "context-compaction" && x.createdAt >= since && x.createdAt <= until).map((x) => x.createdAt);

const STEER_TABLE = "Change of plan on the output: give me the codes as a table with columns link, file, code, sorted by the code word. Skip anything about the decoys.";
const STEER_LONGEST = "Also note which link took the longest to find, one line at the end.";

/** Rows of a markdown table with columns link, file, code (any column order by header). */
function tableRows(text: string): Array<{ link: string; file: string; code: string }> | null {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("|"));
  if (lines.length < 3) return null;
  const cells = (l: string) => l.replace(/^\||\|$/g, "").split("|").map((c) => c.trim().replace(/`/g, ""));
  const header = cells(lines[0]!).map((h) => h.toLowerCase());
  const idx = { link: header.findIndex((h) => h.startsWith("link")), file: header.findIndex((h) => h.startsWith("file")), code: header.findIndex((h) => h.startsWith("code")) };
  if (Object.values(idx).some((i) => i < 0)) return null;
  return lines.slice(1).filter((l) => !/^\|[\s:-]+\|/.test(l) || /[a-z0-9]/i.test(l.replace(/[-:|\s]/g, ""))).map(cells).filter((c) => c.length >= 3).map((c) => ({ link: c[idx.link]!.replace(/\D/g, "").padStart(2, "0"), file: c[idx.file]!, code: c[idx.code]!.toLowerCase() }));
}

const checks: Record<string, boolean> = {};
const texts: Record<string, unknown> = {};
const results: Record<string, unknown> = {};
let errored: string | null = null;
const runStarted = now();
try {
  // (2) --priority steer that changes the output format
  if (!a.only || a.only === "steer") {
    const fx = freshChain();
    const t = now();
    const task = job("task", fx.task, { from: "t3code-steward" });
    await busyAfter(4);
    const steer = job("steer", STEER_TABLE, { from: a["steer-from"]!, priority: true });
    const [tr, sr] = await Promise.all([task.done, steer.done]);
    const users = await usersSince(t);
    const thread = await fetchThread(BASE_URL, bearer, threadId);
    const tools = thread.activities.filter((x) => x.kind === "tool.completed" && x.createdAt >= t);
    const steerAt = users[1]?.createdAt ?? tr.exitedAt;
    const after = tools.filter((x) => x.createdAt > steerAt).map((x) => linkOf(JSON.stringify(x.payload ?? {}), fx)).filter((p): p is string => p !== null && p !== "decoy");
    const assistant = thread.messages.filter((m) => m.role === "assistant" && m.createdAt >= t).sort((x, y) => x.createdAt.localeCompare(y.createdAt)).map((m) => ({ createdAt: m.createdAt, text: m.text }));
    const finalText = assistant.at(-1)?.text ?? "";
    const rows = tableRows(finalText);
    const byWord = [...fx.chain].sort((x, y) => x.word.localeCompare(y.word));
    const rowsCorrect = rows !== null && rows.length === 24 && rows.every((r) => fx.chain.some((l) => l.nn === r.link && l.word === r.code && r.file.includes(l.name)));
    const rowsSorted = rows !== null && rows.map((r) => r.code).join(",") === byWord.map((l) => l.word).join(",");
    say(`(2) task exit ${tr.code} in ${ms(task, tr)} ms; steer exit ${sr.code} in ${ms(steer, sr)} ms`);
    say(`(2) steer user message: ${users[1]?.text.split("\n").slice(0, 2).join(" | ") ?? "?"}; links after steer: ${after.join(",")}; compactions: ${(await compactionsBetween(t, tr.exitedAt)).length}; sessions: ${sessionsSince(t).map((e) => e.detail.split(" ")[0]).join(">")}`);
    say(`(2) table rows parsed: ${rows?.length ?? "none"}; correct ${rowsCorrect}; sorted by code ${rowsSorted}; decoy mentioned ${/decoy/i.test(finalText)}`);
    checks.steerBothExitZero = tr.code === 0 && sr.code === 0;
    checks.steerMarked = users.length === 2 && users[1]!.text.startsWith(`[from: ${a["steer-from"]}]\n[arrived mid-turn at `);
    checks.steerOneTurn = oneTurnBetween(t, tr.exitedAt);
    checks.steerReadsContinued = after.length >= 4 && after.includes("24") && after.every((p, i) => i === 0 || p >= after[i - 1]!);
    checks.steerFormatFollowed = rowsCorrect && rowsSorted && !/decoy/i.test(finalText);
    checks.steerReplyIsTable = tableRows(sr.stdout) !== null;
    texts.steer = { steerMessage: users[1]?.text ?? null, assistantMessages: assistant, steerStdout: sr.stdout, taskStdout: tr.stdout };
    results.steer = { fixtureTag: fx.tag, chain: fx.chain, task: { ...tr, spawnedAt: task.spawnedAt }, steer: { ...sr, spawnedAt: steer.spawnedAt }, users: users.map((m) => ({ createdAt: m.createdAt, text: m.text })), linksAfterSteer: after, rows, sessions: sessionsSince(t) };
  }
  // (4) Lee's path: prioritized, no sender, organic addition to the output
  if (!a.only || a.only === "lee") {
    const fx = freshChain();
    const t = now();
    const task = job("task", fx.task, { from: "t3code-steward" });
    await busyAfter(4);
    const lee = job("lee", STEER_LONGEST, { priority: true });
    const [tr, lr] = await Promise.all([task.done, lee.done]);
    const users = await usersSince(t);
    const thread = await fetchThread(BASE_URL, bearer, threadId);
    const tools = thread.activities.filter((x) => x.kind === "tool.completed" && x.createdAt >= t);
    const steerAt = users[1]?.createdAt ?? tr.exitedAt;
    const after = tools.filter((x) => x.createdAt > steerAt).map((x) => linkOf(JSON.stringify(x.payload ?? {}), fx)).filter((p): p is string => p !== null && p !== "decoy");
    const assistant = thread.messages.filter((m) => m.role === "assistant" && m.createdAt >= t).sort((x, y) => x.createdAt.localeCompare(y.createdAt)).map((m) => ({ createdAt: m.createdAt, text: m.text }));
    const finalText = assistant.at(-1)?.text ?? "";
    const lines = finalText.split("\n").map((l) => l.trim()).filter(Boolean);
    const codeLines = lines.filter((l) => /^\d\d\s*=\s*[a-z]+$/i.test(l));
    const codesRight = fx.codes.every(({ nn, word }) => codeLines.some((l) => new RegExp(`^${nn}\\s*=\\s*${word}$`, "i").test(l)));
    const lastLine = lines.at(-1) ?? "";
    const longestNoted = /longest|took the most|most time|slowest/i.test(lastLine) && (/\b\d\d\b|link|chain-/i.test(lastLine)) && !/^\d\d\s*=/.test(lastLine);
    say(`(4) task exit ${tr.code} in ${ms(task, tr)} ms; lee exit ${lr.code} in ${ms(lee, lr)} ms`);
    say(`(4) lee user message: ${users[1]?.text.split("\n").slice(0, 2).join(" | ") ?? "?"}; links after steer: ${after.join(",")}; compactions: ${(await compactionsBetween(t, tr.exitedAt)).length}; sessions: ${sessionsSince(t).map((e) => e.detail.split(" ")[0]).join(">")}`);
    say(`(4) codes right ${codesRight} (${codeLines.length} code lines); last line: ${lastLine.slice(0, 160)}`);
    checks.leeExitZero = tr.code === 0 && lr.code === 0;
    checks.leeMarkedAsLee = users.length === 2 && users[1]!.text.startsWith("[from: lee]\n[arrived mid-turn at ");
    checks.leeOneTurn = oneTurnBetween(t, tr.exitedAt);
    checks.leeReadsContinued = after.length >= 4 && after.includes("24") && after.every((p, i) => i === 0 || p >= after[i - 1]!);
    checks.leeFormatFollowed = codesRight && longestNoted;
    checks.leeReplyReturned = lr.stdout.trim().length > 0;
    texts.lee = { leeMessage: users[1]?.text ?? null, assistantMessages: assistant, leeStdout: lr.stdout, taskStdout: tr.stdout };
    results.lee = { fixtureTag: fx.tag, chain: fx.chain, task: { ...tr, spawnedAt: task.spawnedAt }, lee: { ...lr, spawnedAt: lee.spawnedAt }, users: users.map((m) => ({ createdAt: m.createdAt, text: m.text })), linksAfterSteer: after, sessions: sessionsSince(t) };
  }
} catch (err) {
  errored = err instanceof Error ? err.stack ?? err.message : String(err);
  say(`ERROR ${errored}`);
} finally {
  const expected = [...(!a.only || a.only === "steer" ? ["steerBothExitZero", "steerMarked", "steerOneTurn", "steerReadsContinued", "steerFormatFollowed", "steerReplyIsTable"] : []), ...(!a.only || a.only === "lee" ? ["leeExitZero", "leeMarkedAsLee", "leeOneTurn", "leeReadsContinued", "leeFormatFollowed", "leeReplyReturned"] : [])];
  const missing = expected.filter((k) => !(k in checks));
  const pass = errored === null && missing.length === 0 && expected.every((k) => checks[k] === true);
  say(`${pass ? "PASS" : "FAIL"}${errored ? " (error)" : ""}${missing.length ? ` missing: ${missing.join(",")}` : ""} ${JSON.stringify(checks)}`);
  const name = `organic-${seat}${a.only ? `-${a.only}-${a["steer-from"]}` : ""}`;
  writeRecord(a.out!, name, log, { seat, via: a.via, steerFrom: a["steer-from"], only: a.only ?? null, threadId, error: errored, checks, pass, texts, results, timeline: timeline.entries });
  const verbatim = (["steer", "lee"] as const).flatMap((k) => { const x = texts[k] as { steerMessage?: string; leeMessage?: string; assistantMessages: Array<{ createdAt: string; text: string }>; steerStdout?: string; leeStdout?: string } | undefined; if (!x) return [`## ${k}: not reached`]; return [`## ${k} proof`, `### steer message as delivered`, x.steerMessage ?? x.leeMessage ?? "", `### assistant messages in the turn`, ...x.assistantMessages.map((m) => `--- ${m.createdAt}\n${m.text}`), `### steer job stdout (reply returned to the steering sender)`, x.steerStdout ?? x.leeStdout ?? "", ""]; });
  writeFileSync(join(a.out!, `${name}.verbatim.md`), `${verbatim.join("\n\n")}\n`);
  const stamp = runStarted.replace(/[:.]/g, "-");
  for (const ext of ["log", "json", "verbatim.md"]) copyFileSync(join(a.out!, `${name}.${ext}`), join(a.out!, `${name}.${stamp}.${ext}`));
  unsubscribe();
  await rpc.close();
  process.exit(pass ? 0 : 1);
}
