// Idle + normal: one injector on an idle thread sends at once. Records
// spawn -> dispatch -> session running -> exit. Also the live smoke of the path.
//   node --no-warnings scripts/idle.ts --provider claude-lhc [--model slug] [--out DIR] [--keep]
import { parseArgs } from "node:util";
import { join } from "node:path";
import { BASE_URL, connect, createThread, deleteProject, fetchThread, inject, now, pickModel, Timeline, writeRecord } from "./lib.ts";

const { values: a } = parseArgs({ options: { provider: { type: "string", default: "claude-lhc" }, model: { type: "string" }, out: { type: "string", default: join(import.meta.dirname, "..", "..", "..", "..", "t3code-campaign", "builders", "wren", "inject") }, keep: { type: "boolean", default: false } } });
const log: string[] = [];
const say = (m: string) => { const line = `[${now()}] ${m}`; log.push(line); console.log(line); };

const { rpc, bearer } = await connect();
const modelSelection = await pickModel(rpc, a.provider!, a.model);
const ws = join(a.out!, "ws", `idle-${a.provider}-${Date.now()}`);
const { projectId, threadId } = await createThread({ rpc, label: `idle ${a.provider}`, workspaceRoot: ws, modelSelection, files: { "note.txt": "The colour of the day is teal.\n" } });
say(`thread ${threadId} project ${projectId} model ${modelSelection.model}`);
const timeline = new Timeline();
const unsubscribe = await rpc.subscribeThread(threadId, timeline.onItem, () => undefined);
let pass = false;
try {
  const run = inject("normal", ["--thread", threadId, "--from", "wren", "--json", "--verbose"], "Read note.txt with your file reading tool and reply with the colour it names, one word.");
  say(`spawned injector (normal, idle thread)`);
  const result = await run.done;
  const running = timeline.entries.find((e) => e.kind === "session" && e.detail.startsWith("running"));
  const userMsg = timeline.entries.find((e) => e.kind === "user");
  const thread = await fetchThread(BASE_URL, bearer, threadId);
  say(`injector exit ${result.code} after ${Date.parse(result.exitedAt) - Date.parse(run.spawnedAt)} ms; stdout: ${result.stdout.trim().slice(0, 200)}`);
  say(`stderr: ${result.stderr.trim().replace(/\n/g, " | ").slice(0, 300)}`);
  const spawnToUser = userMsg ? Date.parse(userMsg.at) - Date.parse(run.spawnedAt) : null;
  const spawnToRunning = running ? Date.parse(running.at) - Date.parse(run.spawnedAt) : null;
  say(`spawn -> user message ${spawnToUser} ms; spawn -> session running ${spawnToRunning} ms; turns on thread: ${thread.latestTurn ? 1 : 0}`);
  const reply = result.code === 0 ? (JSON.parse(result.stdout) as { text: string; sender: string; priority: boolean }) : null;
  const ok = result.code === 0 && reply !== null && /teal/i.test(reply.text) && reply.sender === "wren" && reply.priority === false && userMsg !== undefined && userMsg.detail.includes("[from: wren]") && !userMsg.detail.includes("[arrived");
  say(ok ? "PASS: sent at once, envelope is just the from line, reply names teal" : "FAIL");
  pass = ok;
  writeRecord(a.out!, `idle-${a.provider}`, log, { provider: a.provider, modelSelection, threadId, projectId, spawnedAt: run.spawnedAt, spawnToUserMs: spawnToUser, spawnToRunningMs: spawnToRunning, result, timeline: timeline.entries, userMessages: thread.messages.filter((m) => m.role === "user").map((m) => ({ createdAt: m.createdAt, turnId: m.turnId, text: m.text })), pass });
} finally {
  await unsubscribe();
  if (!a.keep) { await deleteProject(rpc, projectId); say(`deleted project ${projectId}`); }
  await rpc.close();
}
process.exit(pass ? 0 : 1);
