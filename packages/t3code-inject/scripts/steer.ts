// High priority mid-turn: a long read-24-files task (normal priority), then a
// --priority message asking for one extra fact once >= 4 tools completed.
// Shows, from the projection only, that the steer joined the running turn on
// the next model call, the reads continued, and both replies came back.
//   node --no-warnings scripts/steer.ts --provider claude-lhc|codex|grok [--model slug] [--out DIR] [--keep]
import { parseArgs } from "node:util";
import { join } from "node:path";
import { BASE_URL, connect, createThread, deleteProject, fetchThread, inject, now, pickModel, Timeline, writeRecord } from "./lib.ts";
import { chainFiles, hasAllCodes, linkOf } from "./fixtures.ts";

const { values: a } = parseArgs({ options: { provider: { type: "string", default: "claude-lhc" }, model: { type: "string" }, out: { type: "string", default: "/srv/work/t3code-campaign/builders/wren/inject" }, keep: { type: "boolean", default: false }, "steer-after": { type: "string", default: "4" } } });
const log: string[] = [];
const say = (m: string) => { const line = `[${now()}] ${m}`; log.push(line); console.log(line); };
const CODEWORD = "marigold";

const { rpc, bearer } = await connect();
const modelSelection = await pickModel(rpc, a.provider!, a.model);
const ws = join(a.out!, "ws", `steer-${a.provider}-${Date.now()}`);
const fx = chainFiles();
const { files, chain } = fx;
const { projectId, threadId } = await createThread({ rpc, label: `steer ${a.provider}`, workspaceRoot: ws, modelSelection, files });
say(`thread ${threadId} project ${projectId} model ${modelSelection.model}`);
const timeline = new Timeline();
const unsubscribe = await rpc.subscribeThread(threadId, timeline.onItem, () => undefined);
let pass = false;
try {
  const task = inject("task", ["--thread", threadId, "--from", "wren", "--json"], fx.task);
  say("spawned task injector (normal, idle thread)");
  await timeline.until(() => timeline.toolsCompleted >= Number(a["steer-after"]), 180_000, `${a["steer-after"]} completed tools`);
  say(`${timeline.toolsCompleted} tools completed; spawning the high-priority injector`);
  const steer = inject("steer", ["--thread", threadId, "--from", "lee", "--priority", "--json"], `The codeword for this session is ${CODEWORD}. Include it in your final reply.`);
  const [taskResult, steerResult] = await Promise.all([task.done, steer.done]);
  say(`task injector exit ${taskResult.code} (${Date.parse(taskResult.exitedAt) - Date.parse(task.spawnedAt)} ms); steer injector exit ${steerResult.code} (${Date.parse(steerResult.exitedAt) - Date.parse(steer.spawnedAt)} ms)`);
  say(`steer stderr: ${steerResult.stderr.trim().replace(/\n/g, " | ").slice(0, 300)}`);

  const thread = await fetchThread(BASE_URL, bearer, threadId);
  const users = thread.messages.filter((m) => m.role === "user").sort((x, y) => x.createdAt.localeCompare(y.createdAt));
  const steerMsg = users[1];
  // User messages carry no turn id in the projection; turn identity comes from
  // the session (timeline), the activities and the assistant messages.
  const turnId = thread.latestTurn?.turnId ?? null;
  const turnIds = new Set([...thread.activities.map((x) => x.turnId), ...thread.messages.filter((m) => m.role === "assistant").map((m) => m.turnId)].filter((t) => t !== null));
  const tools = thread.activities.filter((x) => x.kind === "tool.completed").sort((x, y) => x.createdAt.localeCompare(y.createdAt));
  const parts = tools.map((x) => linkOf(JSON.stringify(x.payload ?? {}), fx)).filter((p): p is string => p !== null);
  const afterSteer = steerMsg ? tools.filter((x) => x.createdAt > steerMsg.createdAt) : [];
  const partsAfter = afterSteer.map((x) => linkOf(JSON.stringify(x.payload ?? {}), fx)).filter((p): p is string => p !== null);
  const before = parts.slice(0, parts.length - partsAfter.length);
  const repeated = partsAfter.filter((p, i) => p !== "decoy" && partsAfter.indexOf(p) !== i);
  const decoys = parts.filter((p) => p === "decoy").length;
  const assistantText = thread.messages.filter((m) => m.role === "assistant" && m.turnId === turnId).map((m) => m.text).join("\n");
  const codesFound = fx.codes.filter(({ nn, word }) => new RegExp(`${nn}\\s*=\\s*${word}`, "i").test(assistantText)).length;
  const firstAfter = steerMsg ? [...thread.activities, ...thread.messages.filter((m) => m.role === "assistant")].map((x) => x.createdAt).filter((t) => t > steerMsg.createdAt).sort()[0] ?? null : null;
  const sessions = timeline.entries.filter((e) => e.kind === "session");
  const running = sessions.find((e) => e.detail.startsWith("running"));
  const ended = running ? sessions.find((e) => e.at > running.at && !e.detail.startsWith("running")) : undefined;
  const sessionChangesDuringSteer = steerMsg && ended ? sessions.filter((e) => e.at > steerMsg.createdAt && e.at < ended.at) : [];
  const steerReply = steerResult.code === 0 ? (JSON.parse(steerResult.stdout) as { text: string; mode: string; turnId: string }) : null;
  const taskReply = taskResult.code === 0 ? (JSON.parse(taskResult.stdout) as { text: string; mode: string; turnId: string }) : null;

  say(`t0 turn running ${running?.at ?? "?"}; t1 steer message ${steerMsg?.createdAt ?? "?"}; t2 first activity after steer ${firstAfter ?? "?"}; t3 turn ended ${ended?.at ?? "?"}`);
  say(`turn ${turnId}; distinct turn ids across activities and assistant messages: ${turnIds.size}; session changes between the steer and the turn end: ${sessionChangesDuringSteer.length}; steer text head: ${steerMsg?.text.split("\n").slice(0, 2).join(" | ") ?? "?"}`);
  say(`tools completed: ${tools.length} total, ${afterSteer.length} after the steer; parts before steer: ${before.join(",")}; after: ${partsAfter.join(",")}; repeated after the steer: ${repeated.length ? repeated.join(",") : "none"}; decoy reads: ${decoys}`);
  say(`final assistant text: ${codesFound}/24 codes, codeword ${assistantText.toLowerCase().includes(CODEWORD) ? "present" : "MISSING"}`);
  say(`steer reply (${steerReply?.mode ?? "-"}): ${steerReply?.text.replace(/\n/g, " | ").slice(0, 200) ?? steerResult.stderr.slice(-200)}`);
  say(`task reply (${taskReply?.mode ?? "-"}): ${taskReply?.text.replace(/\n/g, " | ").slice(0, 120) ?? taskResult.stderr.slice(-200)}`);
  const checks = {
    bothExitZero: taskResult.code === 0 && steerResult.code === 0,
    steerJoinedTheTurn: steerMsg !== undefined && running !== undefined && ended !== undefined && steerMsg.createdAt > running.at && steerMsg.createdAt < ended.at && turnIds.size === 1 && sessionChangesDuringSteer.length === 0 && steerReply?.turnId === turnId && taskReply?.turnId === turnId,
    steerMarked: steerMsg !== undefined && steerMsg.text.startsWith("[from: lee]\n[arrived mid-turn at "),
    readsContinued: afterSteer.length >= 4 && partsAfter.includes("24") && partsAfter.filter((p) => p !== "decoy").every((p, i, all) => i === 0 || p >= all[i - 1]!),
    noRepeatBeyondOne: repeated.length <= (a.provider === "grok" ? 1 : 0),
    allCodes: codesFound === 24,
    codewordInFinalText: assistantText.toLowerCase().includes(CODEWORD),
    steerReplyHasCodeword: steerReply !== null && steerReply.text.toLowerCase().includes(CODEWORD),
    taskReplyHasCodes: taskReply !== null && hasAllCodes(taskReply.text, fx.codes),
  };
  pass = Object.values(checks).every(Boolean);
  say(`${pass ? "PASS" : "FAIL"} ${JSON.stringify(checks)}`);
  writeRecord(a.out!, `steer-${a.provider}`, log, { provider: a.provider, modelSelection, threadId, projectId, turnId, chain, sessionProviderInstance: thread.session?.providerInstanceId ?? null, checks, pass, times: { t0: running?.at ?? null, t1: steerMsg?.createdAt ?? null, t2: firstAfter, t3: ended?.at ?? null }, taskSpawnedAt: task.spawnedAt, steerSpawnedAt: steer.spawnedAt, taskResult, steerResult, userMessages: users.map((m) => ({ createdAt: m.createdAt, turnId: m.turnId, text: m.text })), toolsCompleted: tools.map((x) => ({ createdAt: x.createdAt, turnId: x.turnId, summary: x.summary, part: linkOf(JSON.stringify(x.payload ?? {}), fx) })), assistantMessages: thread.messages.filter((m) => m.role === "assistant").map((m) => ({ createdAt: m.createdAt, turnId: m.turnId, text: m.text })), timeline: timeline.entries });
} finally {
  await unsubscribe();
  if (!a.keep) { await deleteProject(rpc, projectId); say(`deleted project ${projectId}`); }
  await rpc.close();
}
process.exit(pass ? 0 : 1);
