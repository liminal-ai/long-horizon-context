// C2: the seat on the relay. Drives `lhc-agent` (the relay CLI) against a
// registered seat whose command is t3code-inject, and checks the projection
// of the seat thread. Needs the relay restarted on a registry that has the seat.
//   node --no-warnings scripts/relay-proof.ts --seat t3code-wren --thread <seat thread id> [--out DIR]
// Proofs: (1) lhc-agent <seat> 'msg' returns the reply; (2) lhc-agent --priority
// steers a busy thread; (3) two senders queued while busy come out per-sender
// bundled; (4) Lee's path: prioritized job with no sender (LHC_AGENT_ID unset,
// no --from), as the photon connector enqueues, steers with [from: lee].
import { execFile } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { BASE_URL, connect, fetchThread, now, Timeline, writeRecord } from "./lib.ts";
import { chainFiles, linkOf, READ_TASK, CODES } from "./fixtures.ts";

const { values: a } = parseArgs({ options: { seat: { type: "string" }, thread: { type: "string" }, workspace: { type: "string" }, out: { type: "string", default: "/srv/work/t3code-campaign/builders/wren/inject" } } });
if (!a.seat || !a.thread) throw new Error("--seat and --thread are required");
const seat = a.seat; const threadId = a.thread;
const workspace = a.workspace ?? join(process.env.HOME!, ".t3code-inject", "seats", seat);
const log: string[] = [];
const say = (m: string) => { const line = `[${now()}] ${m}`; log.push(line); console.log(line); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Call { label: string; spawnedAt: string; done: Promise<{ code: number; stdout: string; stderr: string; exitedAt: string }> }
/** One `lhc-agent` invocation, as an agent (or Lee's path with `noSender`) would make it. */
function agent(label: string, argv: string[], opts: { from?: string; priority?: boolean; noSender?: boolean } = {}): Call {
  const env = { ...process.env };
  if (opts.noSender) delete env.LHC_AGENT_ID;
  const args = [...(opts.priority ? ["--priority"] : []), ...(opts.from ? ["--from", opts.from] : []), ...argv];
  const spawnedAt = now();
  const done = new Promise<{ code: number; stdout: string; stderr: string; exitedAt: string }>((resolve) =>
    execFile("lhc-agent", args, { env, encoding: "utf8", maxBuffer: 8 << 20 }, (error, stdout, stderr) =>
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr, exitedAt: now() })));
  return { label, spawnedAt, done };
}
const ms = (c: Call, r: { exitedAt: string }) => Date.parse(r.exitedAt) - Date.parse(c.spawnedAt);

const { rpc, bearer } = await connect();
const { files, chain } = chainFiles();
mkdirSync(workspace, { recursive: true });
for (const [name, text] of Object.entries(files)) writeFileSync(join(workspace, name), text);
const timeline = new Timeline();
const unsubscribe = await rpc.subscribeThread(threadId, timeline.onItem, () => undefined);
const results: Record<string, unknown> = {};
const checks: Record<string, boolean> = {};
const usersSince = async (since: string) => (await fetchThread(BASE_URL, bearer, threadId)).messages.filter((m) => m.role === "user" && m.createdAt >= since).sort((x, y) => x.createdAt.localeCompare(y.createdAt));
const sessionsSince = (since: string) => timeline.entries.filter((e) => e.kind === "session" && e.at >= since);
const oneTurnBetween = (since: string, until: string) => { const s = sessionsSince(since).filter((e) => e.at <= until); return s.filter((e) => e.detail.startsWith("running")).length === 1; };
const codeword = () => `word-${Math.random().toString(36).slice(2, 7)}`;
async function busyAfter(since: string, tools: number): Promise<void> {
  const base = timeline.toolsCompleted;
  await timeline.until(() => timeline.toolsCompleted >= base + tools, 180_000, `${tools} completed tools after ${since}`);
}
try {
  // (1) direct call, idle thread
  {
    const t = now();
    const c = agent("direct", [seat, `Reply with exactly: seat ${seat} online`], { from: "wren" });
    const r = await c.done;
    const users = await usersSince(t);
    say(`(1) direct: exit ${r.code} in ${ms(c, r)} ms; stdout: ${r.stdout.trim().slice(0, 120)}`);
    say(`(1) user message: ${users[0]?.text.split("\n").slice(0, 1).join("") ?? "?"}`);
    checks.directReply = r.code === 0 && r.stdout.includes(`seat ${seat} online`);
    checks.directEnvelope = users.length === 1 && users[0]!.text.startsWith("[from: wren]\n") && !users[0]!.text.includes("[arrived");
    results.direct = { ...r, spawnedAt: c.spawnedAt, users: users.map((m) => m.text) };
  }
  // (2) --priority steers a busy thread
  {
    const t = now(); const word = codeword();
    const task = agent("task", [seat, READ_TASK], { from: "wren" });
    await busyAfter(t, 4);
    const steer = agent("steer", [seat, `The codeword for this session is ${word}. Include it in your final reply.`], { from: "fable", priority: true });
    const [tr, sr] = await Promise.all([task.done, steer.done]);
    const users = await usersSince(t);
    const thread = await fetchThread(BASE_URL, bearer, threadId);
    const tools = thread.activities.filter((x) => x.kind === "tool.completed" && x.createdAt >= t);
    const after = users[1] ? tools.filter((x) => x.createdAt > users[1]!.createdAt).map((x) => linkOf(JSON.stringify(x.payload ?? {}), chain)).filter((p): p is string => p !== null && p !== "decoy") : [];
    const finalText = thread.messages.filter((m) => m.role === "assistant" && m.createdAt >= t).map((m) => m.text).join("\n");
    say(`(2) task exit ${tr.code} in ${ms(task, tr)} ms; steer exit ${sr.code} in ${ms(steer, sr)} ms; steer stdout: ${sr.stdout.trim().replace(/\n/g, " | ").slice(0, 160)}`);
    say(`(2) steer user message: ${users[1]?.text.split("\n").slice(0, 2).join(" | ") ?? "?"}; links after steer: ${after.join(",")}; sessions: ${sessionsSince(t).map((e) => e.detail.split(" ")[0]).join(">")}`);
    checks.steerBothExitZero = tr.code === 0 && sr.code === 0;
    checks.steerMarked = users.length === 2 && users[1]!.text.startsWith("[from: fable]\n[arrived mid-turn at ");
    checks.steerOneTurn = oneTurnBetween(t, tr.exitedAt);
    checks.steerReadsContinued = after.length >= 4 && after.includes("24") && after.every((p, i) => i === 0 || p >= after[i - 1]!);
    checks.steerCodeword = finalText.includes(word) && sr.stdout.includes(word);
    checks.steerTaskCodes = CODES.every(({ nn, word: w }) => new RegExp(`${nn}\\s*=\\s*${w}`, "i").test(tr.stdout));
    results.steer = { word, task: { ...tr, spawnedAt: task.spawnedAt }, steer: { ...sr, spawnedAt: steer.spawnedAt }, users: users.map((m) => ({ createdAt: m.createdAt, text: m.text })), linksAfterSteer: after, sessions: sessionsSince(t) };
  }
  // (3) two senders queued while busy, per-sender bundles
  {
    const t = now();
    const task = agent("loader", [seat, READ_TASK], { from: "wren" });
    await busyAfter(t, 2);
    const a1 = agent("A1", [seat, "Question one: what is 2 + 2? Number only."], { from: "fable" });
    await sleep(1000);
    const b1 = agent("B1", [seat, "What colour is a clear daytime sky? One word."], { from: "overseer" });
    await sleep(1000);
    const a2 = agent("A2", [seat, "Question two: capital of France? One word."], { from: "fable" });
    const [lr, ra1, rb1, ra2] = await Promise.all([task.done, a1.done, b1.done, a2.done]);
    const users = await usersSince(t);
    const arrivals = (m: { text: string }) => (m.text.match(/^\[arrived \d{4}-/gm) ?? []).length;
    const from = (m: { text: string }) => /^\[from: ([^\]]+)\]/.exec(m.text)?.[1] ?? "?";
    say(`(3) loader exit ${lr.code}; A1 ${ra1.code} ${ms(a1, ra1)} ms "${ra1.stdout.trim().replace(/\n/g, " | ")}"; B1 ${rb1.code} ${ms(b1, rb1)} ms "${rb1.stdout.trim().replace(/\n/g, " | ")}"; A2 ${ra2.code} ${ms(a2, ra2)} ms "${ra2.stdout.trim().replace(/\n/g, " | ")}"`);
    say(`(3) user messages: ${users.map((m) => `${from(m)}(${arrivals(m)})`).join(" > ")}`);
    checks.queueAllExitZero = [lr, ra1, rb1, ra2].every((r) => r.code === 0);
    checks.queueOrderAndBundles = users.map(from).join(",") === "wren,fable,overseer" && arrivals(users[1]!) === 2 && arrivals(users[2]!) === 1;
    checks.queueAfterLoader = users.slice(1).every((m) => m.createdAt > lr.exitedAt || sessionsSince(t).some((e) => !e.detail.startsWith("running") && e.at < m.createdAt && e.at > users[0]!.createdAt));
    checks.queueIdenticalBundleReply = ra1.stdout === ra2.stdout && /\b4\b/.test(ra1.stdout) && /paris/i.test(ra1.stdout);
    checks.queueSenderIsolated = /blue/i.test(rb1.stdout) && !/paris/i.test(rb1.stdout);
    results.queue = { loader: { ...lr, spawnedAt: task.spawnedAt }, A1: { ...ra1, spawnedAt: a1.spawnedAt }, B1: { ...rb1, spawnedAt: b1.spawnedAt }, A2: { ...ra2, spawnedAt: a2.spawnedAt }, users: users.map((m) => ({ createdAt: m.createdAt, text: m.text })) };
  }
  // (4) Lee's path: prioritized, no sender
  {
    const t = now(); const word = codeword();
    const task = agent("task", [seat, READ_TASK], { from: "wren" });
    await busyAfter(t, 4);
    const lee = agent("lee", [seat, `Also: the codeword is ${word}; include it in your final reply.`], { priority: true, noSender: true });
    const [tr, lr] = await Promise.all([task.done, lee.done]);
    const users = await usersSince(t);
    say(`(4) task exit ${tr.code}; lee-path exit ${lr.code} in ${ms(lee, lr)} ms; stdout: ${lr.stdout.trim().replace(/\n/g, " | ").slice(0, 160)}`);
    say(`(4) lee user message: ${users[1]?.text.split("\n").slice(0, 2).join(" | ") ?? "?"}; sessions: ${sessionsSince(t).map((e) => e.detail.split(" ")[0]).join(">")}`);
    checks.leeExitZero = tr.code === 0 && lr.code === 0;
    checks.leeMarkedAsLee = users.length === 2 && users[1]!.text.startsWith("[from: lee]\n[arrived mid-turn at ");
    checks.leeOneTurn = oneTurnBetween(t, tr.exitedAt);
    checks.leeCodeword = lr.stdout.includes(word) && tr.stdout.includes(word);
    results.lee = { word, task: { ...tr, spawnedAt: task.spawnedAt }, lee: { ...lr, spawnedAt: lee.spawnedAt }, users: users.map((m) => ({ createdAt: m.createdAt, text: m.text })), sessions: sessionsSince(t) };
  }
} finally {
  const pass = Object.values(checks).length > 0 && Object.values(checks).every(Boolean);
  say(`${pass ? "PASS" : "FAIL"} ${JSON.stringify(checks)}`);
  writeRecord(a.out!, `relay-${seat}`, log, { seat, threadId, checks, pass, results, timeline: timeline.entries });
  await unsubscribe();
  await rpc.close();
  process.exit(pass ? 0 : 1);
}
