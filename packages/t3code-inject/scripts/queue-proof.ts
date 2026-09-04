// Queue: thread busy with a long turn; three senders, five messages arrive
// interleaved (A, B, C, A, B). After the running turn closes: A's two as one
// turn with two timed prompts, then B's two, then C's one. Each process gets
// its sender's reply; bundled processes get identical text. The three sender
// paths are all exercised: A by a `[from: A]` first line (relay envelope), B
// by LHC_RELAY_SENDER (relay env hook), C by --from.
//   node --no-warnings scripts/queue-proof.ts [--provider claude-lhc] [--model slug] [--out DIR] [--keep]
import { parseArgs } from "node:util";
import { join } from "node:path";
import { BASE_URL, connect, createThread, deleteProject, fetchThread, inject, now, pickModel, Timeline, writeRecord, type InjectRun } from "./lib.ts";
import { chainFiles } from "./fixtures.ts";

const { values: a } = parseArgs({ options: { provider: { type: "string", default: "claude-lhc" }, model: { type: "string" }, out: { type: "string", default: "/srv/work/t3code-campaign/builders/wren/inject" }, keep: { type: "boolean", default: false } } });
const log: string[] = [];
const say = (m: string) => { const line = `[${now()}] ${m}`; log.push(line); console.log(line); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const fx = chainFiles();
const { rpc, bearer } = await connect();
const modelSelection = await pickModel(rpc, a.provider!, a.model);
const ws = join(a.out!, "ws", `queue-${a.provider}-${Date.now()}`);
const { projectId, threadId } = await createThread({ rpc, label: `queue ${a.provider}`, workspaceRoot: ws, modelSelection, files: fx.files });
say(`thread ${threadId} project ${projectId} model ${modelSelection.model}`);
const timeline = new Timeline();
const unsubscribe = await rpc.subscribeThread(threadId, timeline.onItem, () => undefined);
let pass = false;
try {
  const loader = inject("loader", ["--thread", threadId, "--from", "loader", "--json"], fx.task);
  say("spawned loader (normal, idle thread): the long read task");
  await timeline.until(() => timeline.toolsCompleted >= 2, 180_000, "2 completed tools");
  say("thread busy; spawning A1, B1, C1, A2, B2 one second apart");
  const t = ["--thread", threadId, "--json"];
  const runs: InjectRun[] = [];
  runs.push(inject("A1", t, "[from: A]\nQuestion one: what is 2 + 2? Answer with the number only."));
  await sleep(1000);
  runs.push(inject("B1", t, "What colour is a clear daytime sky? One word.", { LHC_RELAY_SENDER: "B", LHC_RELAY_JOB_CLASS: "deprioritized" }));
  await sleep(1000);
  runs.push(inject("C1", [...t, "--from", "C"], "How many legs does a spider have? Answer with the number only."));
  await sleep(1000);
  runs.push(inject("A2", t, "[from: A]\nQuestion two: what is the capital of France? One word."));
  await sleep(1000);
  runs.push(inject("B2", t, "Which planet in our solar system is the largest? One word.", { LHC_RELAY_SENDER: "B" }));
  const results = await Promise.all(runs.map((r) => r.done));
  const loaderResult = await loader.done;
  for (const [i, r] of results.entries()) say(`${runs[i]!.label}: exit ${r.code} after ${Date.parse(r.exitedAt) - Date.parse(runs[i]!.spawnedAt)} ms; reply: ${r.code === 0 ? (JSON.parse(r.stdout) as { text: string }).text.replace(/\n/g, " | ").slice(0, 120) : r.stderr.trim().slice(-160)}`);
  say(`loader: exit ${loaderResult.code} after ${Date.parse(loaderResult.exitedAt) - Date.parse(loader.spawnedAt)} ms`);

  const thread = await fetchThread(BASE_URL, bearer, threadId);
  const users = thread.messages.filter((m) => m.role === "user").sort((x, y) => x.createdAt.localeCompare(y.createdAt));
  for (const m of users) say(`user message ${m.createdAt} turn=${m.turnId}: ${m.text.split("\n").filter((l) => l.startsWith("[")).join(" ")}`);
  const reply = (i: number) => (results[i]!.code === 0 ? (JSON.parse(results[i]!.stdout) as { text: string }).text : null);
  const [rA1, rB1, rC1, rA2, rB2] = [0, 1, 2, 3, 4].map(reply) as [string | null, string | null, string | null, string | null, string | null];
  const has = (text: string | null, re: RegExp) => text !== null && re.test(text);
  const senderOf = (m: { text: string }) => /^\[from: ([^\]]+)\]/.exec(m.text)?.[1] ?? "?";
  const arrivals = (m: { text: string }) => (m.text.match(/^\[arrived \d{4}-/gm) ?? []).length;
  const assistants = thread.messages.filter((m) => m.role === "assistant").sort((x, y) => x.createdAt.localeCompare(y.createdAt));
  const turnOrder = [...new Set(assistants.map((m) => m.turnId))];
  const sessions = timeline.entries.filter((e) => e.kind === "session");
  const loaderRunning = sessions.find((e) => e.detail.startsWith("running"));
  const loaderEnded = loaderRunning ? sessions.find((e) => e.at > loaderRunning.at && !e.detail.startsWith("running")) : undefined;
  say(`loader turn ${loaderRunning?.at ?? "?"} -> ${loaderEnded?.at ?? "?"}; assistant turn order: ${turnOrder.join(",")}`);
  const checks = {
    allExitZero: results.every((r) => r.code === 0) && loaderResult.code === 0,
    fourTurnsInOrder: users.length === 4 && users.map(senderOf).join(",") === "loader,A,B,C" && turnOrder.length === 4,
    aBundledWithTwoTimedPrompts: users[1] !== undefined && arrivals(users[1]) === 2 && users[1].text.includes("Question one") && users[1].text.includes("Question two"),
    bBundledWithTwoTimedPrompts: users[2] !== undefined && arrivals(users[2]) === 2,
    cSingleTimed: users[3] !== undefined && arrivals(users[3]) === 1,
    afterLoaderClosed: loaderEnded !== undefined && users.slice(1).every((m) => m.createdAt > loaderEnded.at),
    aIdenticalReplies: rA1 !== null && rA1 === rA2 && has(rA1, /\b4\b/) && has(rA1, /paris/i),
    bIdenticalReplies: rB1 !== null && rB1 === rB2 && has(rB1, /blue/i) && has(rB1, /jupiter/i),
    cReply: has(rC1, /\b8\b|eight/i),
    noCrossSenderReply: rC1 !== null && !has(rC1, /paris|jupiter/i) && rB1 !== null && !has(rB1, /paris/i),
  };
  pass = Object.values(checks).every(Boolean);
  say(`${pass ? "PASS" : "FAIL"} ${JSON.stringify(checks)}`);
  writeRecord(a.out!, `queue-${a.provider}`, log, { provider: a.provider, modelSelection, threadId, projectId, checks, pass, runs: runs.map((r, i) => ({ label: r.label, spawnedAt: r.spawnedAt, ...results[i]! })), loader: { spawnedAt: loader.spawnedAt, ...loaderResult }, userMessages: users.map((m) => ({ createdAt: m.createdAt, turnId: m.turnId, text: m.text })), assistantMessages: thread.messages.filter((m) => m.role === "assistant").map((m) => ({ createdAt: m.createdAt, turnId: m.turnId, text: m.text })), timeline: timeline.entries });
} finally {
  await unsubscribe();
  if (!a.keep) { await deleteProject(rpc, projectId); say(`deleted project ${projectId}`); }
  await rpc.close();
}
process.exit(pass ? 0 : 1);
