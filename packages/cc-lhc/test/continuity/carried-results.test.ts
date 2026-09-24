/**
 * beads 7uo (gorilla F4): a carried subagent and a relaunched Monitor reach
 * the replacement session through the next-real-prompt hook and end terminal.
 * Real SQLite record, real adapters and relaunch (`invokeCarryover`), real
 * hook binding through a ready descriptor; delivery is acknowledged only the
 * way the wrapper does it — from the rollout's hook_additional_context record.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { qualifyActiveItems, statPathReal } from "../../src/continuity/adapters.js";
import {
  interruptedNotice,
  interruptedRestartNotice,
  parseAgentFinalResult,
  settleCarriedWork,
  stopRelaunchedMonitors,
} from "../../src/continuity/carried-results.js";
import { cleanupThread } from "../../src/continuity/cleanup.js";
import { deliveredResultKeys } from "../../src/continuity/delivery.js";
import { invokeCarryover } from "../../src/continuity/handoff.js";
import { carryHelpersFromPreviousSession } from "../../src/continuity/helper-transfer.js";
import { createContinuityObserver } from "../../src/continuity/observe.js";
import { snapshotContinuity } from "../../src/continuity/snapshot.js";
import { type ContinuityStore, openContinuityStore } from "../../src/continuity/store.js";
import { executeTasks, executeTasksHook } from "../../src/continuity/tasks-cli.js";
import type { RolloutLineItem } from "../../src/rollout/types.js";
import {
  createOpeningDescriptor,
  defaultDescriptorIo,
  markReady,
  newDescriptorPath,
} from "../../src/runtime/descriptor.js";
import { LAUNCH_IDS, LAUNCHES, type ReapTarget, reapProcesses, toolResult, toolUse, trackForReap } from "./helpers.js";

const T = "th_f4";
const SESSION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const dirs: string[] = [];
const pids: ReapTarget[] = [];
const stores: ContinuityStore[] = [];
afterEach(async () => {
  await reapProcesses(pids);
  // Windows refuses to remove a tree while the SQLite file is still open.
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Claude Code 2.1.x subagent transcript records (shapes from real `subagents/agent-<id>.jsonl` files). */
const rec = {
  prompt: (text: string) => ({
    type: "user",
    isSidechain: true,
    agentId: "agent-1",
    message: { role: "user", content: text },
  }),
  attachment: () => ({
    type: "attachment",
    isSidechain: true,
    agentId: "agent-1",
    attachment: { type: "skill_listing" },
  }),
  assistant: (id: string, content: unknown[], stop_reason: string | null) => ({
    type: "assistant",
    isSidechain: true,
    agentId: "agent-1",
    message: { id, type: "message", role: "assistant", model: "claude-opus-4-8", content, stop_reason },
  }),
  toolResult: (id: string) => ({
    type: "user",
    isSidechain: true,
    agentId: "agent-1",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
  }),
};
const jsonl = (records: unknown[]) => `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;

const FINAL_TRANSCRIPT = jsonl([
  rec.prompt("review the diff"),
  rec.attachment(),
  rec.assistant("msg_1", [{ type: "tool_use", id: "toolu_r1", name: "Read", input: { file_path: "/x" } }], "tool_use"),
  rec.toolResult("toolu_r1"),
  rec.attachment(),
  rec.assistant("msg_2", [{ type: "thinking", thinking: "", signature: "s" }], null),
  rec.assistant(
    "msg_2",
    [{ type: "text", text: "Review done.\n\nNo blocking issues; one nit in foo.ts." }],
    "end_turn",
  ),
]);
/** The gorilla shape: the paused child's agent stopped at its first tool call. */
const UNFINISHED_TRANSCRIPT = jsonl([
  rec.prompt("write sub log lines"),
  rec.attachment(),
  rec.attachment(),
  rec.assistant("msg_1", [{ type: "tool_use", id: "toolu_b1", name: "Bash", input: { command: "echo" } }], "tool_use"),
]);

/** A handed-over session: carried agent + relaunched Monitor, generation closed, ready descriptor bound. */
function session(opts: { monitorCommand: string; transcript: string }) {
  const root = mkdtempSync(join(tmpdir(), "cc-lhc-f4-"));
  dirs.push(root);
  const sessionDir = join(root, "projects", "-x", "session-old");
  const tasksDir = join(root, "tmp", "-x", "session-old", "tasks");
  mkdirSync(join(sessionDir, "subagents"), { recursive: true });
  mkdirSync(tasksDir, { recursive: true });
  const transcriptPath = join(sessionDir, "subagents", "agent-agent-1.jsonl");
  const metaPath = join(sessionDir, "subagents", "agent-agent-1.meta.json");
  writeFileSync(transcriptPath, "");
  writeFileSync(metaPath, JSON.stringify({ agentType: "general-purpose", description: "reviewer" }));
  // The replacement session's folder, as Claude names it: <projectDir>/<sessionId>.
  const newSessionDir = join(root, "projects", "-x", SESSION);
  const rolloutPath = `${sessionDir}.jsonl`;
  const monitorLines = [
    toolUse("toolu_mon", "Monitor", { command: opts.monitorCommand, description: "CI watch" }),
    toolResult("toolu_mon", { taskId: "mon-1", timeoutMs: 60_000, persistent: false }),
  ];
  writeFileSync(rolloutPath, `${monitorLines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  const dbPath = join(root, "cc-lhc.sqlite");
  const store = openContinuityStore(dbPath);
  stores.push(store);
  let now = 1_000;
  const observer = createContinuityObserver({ store, threadId: T, nowFn: () => (now += 1) });
  for (const line of [...LAUNCHES.agent.lines({ tasksDir, sessionDir }), ...monitorLines]) observer.observeLine(line);
  const context = { platform: process.platform, sourceRolloutPath: rolloutPath, statPath: statPathReal };
  expect(qualifyActiveItems(store, T, context, 2_000).refused).toEqual([]);
  const snap = snapshotContinuity(store, { threadId: T, oldSessionId: "session-old", nowMs: 3_000 });
  if (!snap.ok) throw new Error(snap.reason);
  const monitorOutputDir = join(root, "continuity");
  const transfer = invokeCarryover(store, snap.snapshot, { monitorOutputDir, cwd: root, log: () => {} }, 4_000);
  const relaunched = transfer.results.find((r) => r.launchId === LAUNCH_IDS.monitor);
  if (relaunched?.kind !== "relaunched") throw new Error(`monitor not relaunched: ${JSON.stringify(relaunched)}`);
  trackForReap(pids, relaunched.pid);
  // The saved transcript as the old host left it.
  writeFileSync(transcriptPath, opts.transcript);

  const io = defaultDescriptorIo();
  const descPath = newDescriptorPath(root, io);
  markReady(descPath, createOpeningDescriptor(descPath, io), {
    threadId: T,
    registryPath: join(root, "registry.sqlite"),
    sessionId: SESSION,
    rolloutPath,
  });
  const env = { ...process.env, CLAUDE_CODE_SESSION_ID: SESSION };
  const payload = JSON.stringify({
    session_id: SESSION,
    transcript_path: `${newSessionDir}.jsonl`,
    hook_event_name: "UserPromptSubmit",
    prompt: "next",
  });
  /** One real prompt: the hook answers; the wrapper's capture path acknowledges what the rollout recorded. */
  const prompt = (observed = true): string => {
    const hook = executeTasksHook(payload, { env, descriptorPath: descPath, continuityDbPath: dbPath });
    if (!hook.ok) throw new Error(hook.reason);
    if (observed && hook.additionalContext !== "") {
      const keys = deliveredResultKeys(hookRecord(hook.additionalContext));
      expect(keys.sort()).toEqual([...hook.keys].sort());
      store.markDelivered({ threadId: T, launchIds: keys, nowMs: Date.now() });
    }
    return hook.additionalContext;
  };
  const tasks = (argv: string[]) =>
    executeTasks(["tasks", ...argv], { env, descriptorPath: descPath, continuityDbPath: dbPath });
  return {
    root,
    store,
    dbPath,
    transcriptPath,
    metaPath,
    newSessionDir,
    monitorOutputDir,
    pid: relaunched.pid,
    outputPath: relaunched.outputPath,
    prompt,
    tasks,
  };
}

function hookRecord(context: string): RolloutLineItem {
  return {
    type: "attachment",
    isSidechain: false,
    attachment: {
      type: "hook_additional_context",
      content: [context],
      hookName: "UserPromptSubmit",
      hookEvent: "UserPromptSubmit",
    },
  } as unknown as RolloutLineItem;
}

async function waitGone(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`pid ${pid} still alive`);
}

/** The agent's result line and, when present, its indented detail line. */
const agentLines = (context: string): string[] => {
  const lines = context.split("\n");
  const at = lines.findIndex((l) => l.startsWith(`result ${LAUNCH_IDS.agent} `));
  if (at < 0) return [];
  return lines[at + 1]?.startsWith("  ") === true ? [lines[at]!, lines[at + 1]!] : [lines[at]!];
};
const itemOf = (store: ContinuityStore, id: string) => store.getItem(T, id)!;

describe("F4 carried subagent: settled on the next prompt from its saved transcript", () => {
  it("a final result is delivered once (bounded, with a pointer to the full text) and the item ends completed", () => {
    const s = session({ monitorCommand: "sleep 30", transcript: FINAL_TRANSCRIPT });
    expect(itemOf(s.store, LAUNCH_IDS.agent).state).toBe("active");
    const first = s.prompt();
    expect(agentLines(first)).toEqual([
      `result ${LAUNCH_IDS.agent} · agent · background agent "reviewer" (agent-1) · completed`,
      "  final result: Review done. No blocking issues; one nit in foo.ts.",
    ]);
    expect(itemOf(s.store, LAUNCH_IDS.agent)).toMatchObject({ state: "terminal", terminal: { outcome: "completed" } });
    expect(s.store.getResult(T, LAUNCH_IDS.agent)).toMatchObject({ delivery: "delivered", outcome: "completed" });
    // Exactly once: the next prompt carries nothing for it.
    expect(agentLines(s.prompt())).toEqual([]);
    // The full saved text is served by `tasks output <key>`.
    const out = s.tasks(["output", LAUNCH_IDS.agent]);
    expect(out.ok && out.bytes?.toString("utf8")).toBe("Review done.\n\nNo blocking issues; one nit in foo.ts.");
  });

  it("a long final text is bounded in the prompt and points at tasks output", () => {
    const long = "x".repeat(5_000);
    const s = session({
      monitorCommand: "sleep 30",
      transcript: jsonl([rec.prompt("go"), rec.assistant("m", [{ type: "text", text: long }], "end_turn")]),
    });
    const [, detail] = agentLines(s.prompt());
    expect(detail!.length).toBeLessThanOrEqual(602);
    expect(detail).toContain(`(full text: cc-lhc tasks output ${LAUNCH_IDS.agent})`);
    const out = s.tasks(["output", LAUNCH_IDS.agent, "--max", "1048576"]);
    expect(out.ok && out.bytes?.length).toBe(5_000);
  });

  it("no final result (stopped at a tool call, the gorilla shape) delivers the interrupted notice once; the item ends terminal", () => {
    const s = session({ monitorCommand: "sleep 30", transcript: UNFINISHED_TRANSCRIPT });
    const first = s.prompt();
    expect(agentLines(first)).toEqual([
      `result ${LAUNCH_IDS.agent} · agent · background agent "reviewer" (agent-1) · killed`,
      "  subagent agent-1 was interrupted by the compaction; resume it with SendMessage(agent-1)",
    ]);
    expect(itemOf(s.store, LAUNCH_IDS.agent)).toMatchObject({
      state: "terminal",
      terminal: { outcome: "killed", evidence: interruptedNotice("agent-1") },
    });
    expect(agentLines(s.prompt())).toEqual([]);
  });

  it("a malformed or unreadable transcript delivers the interrupted notice, never a crash", () => {
    const s = session({
      monitorCommand: "sleep 30",
      transcript: `${JSON.stringify(rec.prompt("go"))}\n{"type":"assis`,
    });
    expect(agentLines(s.prompt())[1]).toBe(`  ${interruptedNotice("agent-1")}`);
    expect(itemOf(s.store, LAUNCH_IDS.agent).terminal?.outcome).toBe("killed");

    const gone = session({ monitorCommand: "sleep 30", transcript: FINAL_TRANSCRIPT });
    rmSync(gone.transcriptPath);
    expect(agentLines(gone.prompt())[1]).toBe(`  ${interruptedRestartNotice("agent-1", "its transcript is missing")}`);
  });

  it("undelivered context (hook ran, rollout never recorded it) is offered again, and settles nothing twice", () => {
    const s = session({ monitorCommand: "sleep 30", transcript: FINAL_TRANSCRIPT });
    const first = agentLines(s.prompt(false));
    expect(first).toHaveLength(2);
    expect(s.store.getResult(T, LAUNCH_IDS.agent)?.delivery).toBe("pending");
    expect(agentLines(s.prompt())).toEqual(first);
    expect(agentLines(s.prompt())).toEqual([]);
  });
});

describe("0.4.5 interrupted helper: its transcript moves into the replacement session before the resume offer", () => {
  const newCopy = (s: { newSessionDir: string }, name: string) => join(s.newSessionDir, "subagents", name);

  it("copies transcript and metadata unchanged into the current session, originals kept, then offers SendMessage", () => {
    const s = session({ monitorCommand: "sleep 30", transcript: UNFINISHED_TRANSCRIPT });
    expect(existsSync(newCopy(s, "agent-agent-1.jsonl"))).toBe(false);
    expect(agentLines(s.prompt())[1]).toBe(`  ${interruptedNotice("agent-1")}`);
    expect(readFileSync(newCopy(s, "agent-agent-1.jsonl"), "utf8")).toBe(UNFINISHED_TRANSCRIPT);
    expect(readFileSync(newCopy(s, "agent-agent-1.meta.json"), "utf8")).toBe(readFileSync(s.metaPath, "utf8"));
    expect(readFileSync(s.transcriptPath, "utf8")).toBe(UNFINISHED_TRANSCRIPT);
    expect(readdirSync(join(s.newSessionDir, "subagents")).filter((n) => n.startsWith("."))).toEqual([]);
  });

  it("a failed copy never offers SendMessage: the notice says to start it again", () => {
    const s = session({ monitorCommand: "sleep 30", transcript: UNFINISHED_TRANSCRIPT });
    // The destination folder cannot be created: a file stands where it would go.
    mkdirSync(s.newSessionDir, { recursive: true });
    writeFileSync(join(s.newSessionDir, "subagents"), "not a folder");
    const [, detail] = agentLines(s.prompt());
    expect(detail).toMatch(
      /^ {2}subagent agent-1 was interrupted by the compaction and cannot be resumed here \(its transcript could not be copied \(E[A-Z]+\)\); start it again/,
    );
    expect(detail).not.toContain("SendMessage");
    expect(itemOf(s.store, LAUNCH_IDS.agent).terminal?.outcome).toBe("killed");
  });

  it("a copy that fails partway leaves no transcript and no partial file, and no resume offer", () => {
    const s = session({ monitorCommand: "sleep 30", transcript: UNFINISHED_TRANSCRIPT });
    // The metadata copies; the transcript cannot be read (a folder in its place).
    rmSync(s.transcriptPath);
    mkdirSync(s.transcriptPath);
    const [, detail] = agentLines(s.prompt());
    expect(detail).toContain("cannot be resumed here (its transcript could not be copied");
    const names = readdirSync(join(s.newSessionDir, "subagents"));
    expect(names).not.toContain("agent-agent-1.jsonl");
    expect(names.filter((n) => n.startsWith("."))).toEqual([]);
  });

  it("a crash's leftover partial copy is swept and never looks resumable", () => {
    const s = session({ monitorCommand: "sleep 30", transcript: UNFINISHED_TRANSCRIPT });
    const dir = join(s.newSessionDir, "subagents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".agent-agent-1.jsonl.cc-lhc-partial-99-1"), "torn");
    expect(agentLines(s.prompt())[1]).toBe(`  ${interruptedNotice("agent-1")}`);
    expect(readdirSync(dir).sort()).toEqual(["agent-agent-1.jsonl", "agent-agent-1.meta.json"]);
  });

  it("never overwrites a helper already in the current session (resumed there): it is kept and offered", () => {
    const s = session({ monitorCommand: "sleep 30", transcript: UNFINISHED_TRANSCRIPT });
    const dir = join(s.newSessionDir, "subagents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agent-agent-1.jsonl"), "resumed here\n");
    expect(agentLines(s.prompt())[1]).toBe(`  ${interruptedNotice("agent-1")}`);
    expect(readFileSync(join(dir, "agent-agent-1.jsonl"), "utf8")).toBe("resumed here\n");
  });

  it("an unknown current session (no transcript path) never offers SendMessage", () => {
    const s = session({ monitorCommand: "sleep 30", transcript: UNFINISHED_TRANSCRIPT });
    const settled = settleCarriedWork(s.store, T, { continuityDir: join(s.root, "continuity") });
    expect(settled.agents).toEqual([expect.objectContaining({ outcome: "killed", resumable: false })]);
    expect(itemOf(s.store, LAUNCH_IDS.agent).terminal?.evidence).toBe(
      interruptedRestartNotice("agent-1", "the current session folder is unknown"),
    );
  });
});

describe("0.4.5 helpers stay resumable after every compaction", () => {
  function sessions() {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-helpers-"));
    dirs.push(root);
    const project = join(root, "projects", "-x");
    const store = openContinuityStore(join(root, "cc-lhc.sqlite"));
    stores.push(store);
    const helper = (sessionId: string, agentId: string, text: string) => {
      const dir = join(project, sessionId, "subagents");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `agent-${agentId}.jsonl`), text);
      writeFileSync(join(dir, `agent-${agentId}.meta.json`), `{"agentType":"general-purpose"}`);
    };
    const handoff = (oldSessionId: string, close = true) => {
      const g = store.allocateGeneration({ threadId: T, oldSessionId, launchIds: [], nowMs: Date.now() });
      if (close)
        store.setGenerationState({ threadId: T, generation: g.generation, state: "closed", nowMs: Date.now() });
      return g.generation;
    };
    return { root, project, store, helper, handoff, dir: (id: string) => join(project, id) };
  }

  it("each compaction carries the previous session's helpers forward, A → B → C, keeping existing copies", () => {
    const t = sessions();
    t.helper("A", "h1", "h1 transcript\n");
    t.handoff("A");
    expect(carryHelpersFromPreviousSession(t.store, T, t.dir("B"))).toMatchObject({
      results: [{ ok: true, agentId: "h1", status: "copied" }],
    });
    // Resumed in B: its transcript there grows; a new helper h2 starts in B.
    appendFileSync(join(t.dir("B"), "subagents", "agent-h1.jsonl"), "resumed in B\n");
    t.helper("B", "h2", "h2 transcript\n");
    t.handoff("B");
    const carried = carryHelpersFromPreviousSession(t.store, T, t.dir("C"));
    expect(carried).toMatchObject({
      results: [
        { ok: true, agentId: "h1", status: "copied" },
        { ok: true, agentId: "h2", status: "copied" },
      ],
    });
    expect(readFileSync(join(t.dir("C"), "subagents", "agent-h1.jsonl"), "utf8")).toBe("h1 transcript\nresumed in B\n");
    expect(existsSync(join(t.dir("C"), "subagents", "agent-h2.meta.json"))).toBe(true);
    // Running it again (every prompt) changes nothing.
    appendFileSync(join(t.dir("C"), "subagents", "agent-h1.jsonl"), "resumed in C\n");
    expect(carryHelpersFromPreviousSession(t.store, T, t.dir("C"))).toMatchObject({
      results: [
        { ok: true, agentId: "h1", status: "present" },
        { ok: true, agentId: "h2", status: "present" },
      ],
    });
    expect(readFileSync(join(t.dir("C"), "subagents", "agent-h1.jsonl"), "utf8")).toContain("resumed in C");
  });

  it("copies nothing until the handoff closed, nor while the old Claude still runs unpaused", () => {
    const t = sessions();
    t.helper("A", "h1", "x\n");
    const g = t.handoff("A", false);
    expect(carryHelpersFromPreviousSession(t.store, T, t.dir("B"))).toEqual({ skipped: "handoff not complete" });
    t.store.setGenerationState({ threadId: T, generation: g, state: "closed", nowMs: Date.now() });
    const host = { pid: 1, bootId: "b", starttime: "1", retainedAtMs: 1 };
    t.store.setRetainedHost({ threadId: T, generation: g, host, nowMs: Date.now() });
    expect(carryHelpersFromPreviousSession(t.store, T, t.dir("B"))).toEqual({
      skipped: "previous session still running",
    });
    expect(existsSync(join(t.dir("B"), "subagents"))).toBe(false);
    // Paused (a mixed carryover): it can no longer write, so its helpers move.
    t.store.clearRetainedHost({ threadId: T, generation: g, nowMs: Date.now() });
    t.store.setRetainedHost({ threadId: T, generation: g, host: { ...host, frozen: true }, nowMs: Date.now() });
    expect(carryHelpersFromPreviousSession(t.store, T, t.dir("B"))).toMatchObject({
      results: [{ ok: true, agentId: "h1", status: "copied" }],
    });
    // Or stopped since (its retained-host record cleared): likewise.
    t.helper("A", "h2", "y\n");
    t.store.clearRetainedHost({ threadId: T, generation: g, nowMs: Date.now() });
    expect(carryHelpersFromPreviousSession(t.store, T, t.dir("B"))).toMatchObject({
      results: [
        { ok: true, agentId: "h1", status: "present" },
        { ok: true, agentId: "h2", status: "copied" },
      ],
    });
  });
});

describe("parseAgentFinalResult", () => {
  it("accepts only a closing end_turn/stop_sequence assistant message without tool calls", () => {
    expect(parseAgentFinalResult(FINAL_TRANSCRIPT)).toEqual({
      kind: "final",
      text: "Review done.\n\nNo blocking issues; one nit in foo.ts.",
    });
    expect(parseAgentFinalResult(UNFINISHED_TRANSCRIPT).kind).toBe("none");
    // A tool result after the last assistant message: still working.
    expect(parseAgentFinalResult(`${FINAL_TRANSCRIPT}${jsonl([rec.toolResult("t")])}`).kind).toBe("none");
    // Synthetic API error message.
    const synthetic = {
      ...rec.assistant("e", [{ type: "text", text: "API Error: 500" }], "stop_sequence"),
      isApiErrorMessage: true,
    };
    expect(parseAgentFinalResult(jsonl([rec.prompt("go"), synthetic])).kind).toBe("none");
    expect(parseAgentFinalResult("").kind).toBe("none");
    expect(parseAgentFinalResult(null).kind).toBe("none");
    expect(parseAgentFinalResult("[1,2]\n").kind).toBe("none");
  });
});

describe("F4 relaunched Monitor: events delivered once each, terminal after exit, stopped at session end", () => {
  it("each event line is delivered exactly once across prompts; the item ends completed once the process exited", async () => {
    const s = session({ monitorCommand: "sleep 30", transcript: FINAL_TRANSCRIPT });
    const events = (context: string) => context.split("\n").filter((l) => l.startsWith("event "));
    appendFileSync(s.outputPath, "build 1 started\nbuild 1 ");
    const first = events(s.prompt());
    expect(first).toEqual([`event ${LAUNCH_IDS.monitor}@16 · monitor · monitor "CI watch" (mon-1) · build 1 started`]);
    expect(s.store.deliveredEventOffset(T, LAUNCH_IDS.monitor)).toBe(16);
    expect(itemOf(s.store, LAUNCH_IDS.monitor).state).toBe("active");

    appendFileSync(s.outputPath, "passed\nbuild 2 started\n");
    const second = events(s.prompt());
    expect(second.map((l) => l.split(" · ").at(-1))).toEqual(["build 1 passed", "build 2 started"]);
    expect(events(s.prompt())).toEqual([]);

    // The relaunched process exits: a trailing unterminated line is final now, and the item closes.
    appendFileSync(s.outputPath, "watch ended");
    // Through the reaper: it stops the whole tree and waits for every process in it.
    // A bare kill of the pid ends only Git Bash on Windows; its `sleep` child keeps
    // the output file open and the temp dir cannot be removed (CI run 35920735874).
    await reapProcesses(
      pids.splice(
        pids.findIndex((t) => t.pid === s.pid),
        1,
      ),
    );
    await waitGone(s.pid);
    const last = s.prompt();
    expect(events(last).map((l) => l.split(" · ").at(-1))).toEqual(["watch ended"]);
    expect(last).toContain(`result ${LAUNCH_IDS.monitor} · monitor · monitor "CI watch" (mon-1) · completed`);
    expect(itemOf(s.store, LAUNCH_IDS.monitor)).toMatchObject({
      state: "terminal",
      terminal: { outcome: "completed" },
    });
    expect(s.prompt()).not.toContain(LAUNCH_IDS.monitor);
  });

  it("a failed stop signal keeps the Monitor only while the exact process still runs (win32 taskkill /T)", () => {
    // taskkill /T /F exits non-zero when one process in the tree is already
    // gone, though the root was killed (CI 35941944288, win32-x64).
    const s = session({ monitorCommand: "sleep 30", transcript: FINAL_TRANSCRIPT });
    const item = itemOf(s.store, LAUNCH_IDS.monitor);
    const proc = item.relaunch!.process!;
    const live = { ok: true as const, identity: { pid: proc.pid, bootId: proc.bootId, starttime: proc.starttime } };
    const failed = () => ({ ok: false as const, reason: "ERROR: The process with PID 1 could not be terminated." });

    const kept = stopRelaunchedMonitors(s.store, T, { signal: failed, probeIdentity: () => live });
    expect(kept.stopped).toEqual([]);
    expect(kept.kept).toEqual([{ launchId: LAUNCH_IDS.monitor, reason: failed().reason }]);
    expect(itemOf(s.store, LAUNCH_IDS.monitor).state).toBe("active");

    // The root did die: the first probe (before signalling) sees it live, the re-probe does not.
    let probes = 0;
    const stopped = stopRelaunchedMonitors(s.store, T, {
      signal: failed,
      probeIdentity: () =>
        probes++ === 0 ? live : { ok: false as const, code: "not_found" as const, message: "no such process" },
    });
    expect(stopped).toEqual({
      stopped: [{ launchId: LAUNCH_IDS.monitor, pid: proc.pid }],
      alreadyExited: [],
      kept: [],
    });
    expect(itemOf(s.store, LAUNCH_IDS.monitor)).toMatchObject({ state: "terminal", terminal: { outcome: "stopped" } });
  });

  it("the hook never marks events delivered by itself; an unobserved batch is offered again", () => {
    const s = session({ monitorCommand: "sleep 30", transcript: FINAL_TRANSCRIPT });
    appendFileSync(s.outputPath, "one\n");
    const unobserved = s.prompt(false);
    expect(unobserved).toContain("· one");
    expect(s.store.deliveredEventOffset(T, LAUNCH_IDS.monitor)).toBe(0);
    expect(s.prompt()).toContain("· one");
    expect(s.prompt()).not.toContain("· one");
  });

  it("session end stops the live relaunched Monitor, identity-gated, and records it stopped", async () => {
    const s = session({ monitorCommand: "sleep 30", transcript: FINAL_TRANSCRIPT });
    const report = stopRelaunchedMonitors(s.store, T);
    // The whole report, so a kept Monitor prints why.
    expect(report).toEqual({ stopped: [{ launchId: LAUNCH_IDS.monitor, pid: s.pid }], alreadyExited: [], kept: [] });
    await waitGone(s.pid);
    expect(itemOf(s.store, LAUNCH_IDS.monitor)).toMatchObject({
      state: "terminal",
      terminal: { outcome: "stopped", evidence: `stopped at session end (pid ${s.pid})` },
    });
    // Idempotent: nothing left to stop.
    expect(stopRelaunchedMonitors(s.store, T).stopped).toEqual([]);
  });

  it("a pid that now names a different process is never signalled", () => {
    const s = session({ monitorCommand: "sleep 30", transcript: FINAL_TRANSCRIPT });
    const signalled: number[] = [];
    const report = stopRelaunchedMonitors(s.store, T, {
      probeIdentity: (pid) => ({ ok: true, identity: { pid, bootId: "other-boot", starttime: "1" } }),
      signal: (pid) => {
        signalled.push(pid);
        return { ok: true };
      },
    });
    expect(signalled).toEqual([]);
    expect(report.alreadyExited).toEqual([LAUNCH_IDS.monitor]);
    const indeterminate = session({ monitorCommand: "sleep 30", transcript: FINAL_TRANSCRIPT });
    const kept = stopRelaunchedMonitors(indeterminate.store, T, {
      probeIdentity: () => ({ ok: false, code: "indeterminate", message: "no" }),
      signal: (pid) => {
        signalled.push(pid);
        return { ok: true };
      },
    });
    expect(signalled).toEqual([]);
    expect(kept.kept).toHaveLength(1);
    expect(itemOf(indeterminate.store, LAUNCH_IDS.monitor).state).toBe("active");
  });
});

describe("F4b a relaunched Monitor across a second Smart Compact", () => {
  /** A later compaction: the new rollout holds no Monitor tool_use (the wrapper made the relaunch). */
  function compactAgain(s: ReturnType<typeof session>, generationNow: number) {
    const rolloutPath = join(s.root, "projects", "-x", "session-new.jsonl");
    writeFileSync(rolloutPath, "");
    const context = { platform: process.platform, sourceRolloutPath: rolloutPath, statPath: statPathReal };
    const qualified = qualifyActiveItems(s.store, T, context, generationNow);
    const snap = snapshotContinuity(s.store, { threadId: T, oldSessionId: "new", nowMs: generationNow + 1 });
    if (!snap.ok) throw new Error(snap.reason);
    const transfer = invokeCarryover(
      s.store,
      snap.snapshot,
      { monitorOutputDir: s.monitorOutputDir, cwd: s.root, log: () => {} },
      generationNow + 2,
    );
    return { qualified, transfer };
  }
  const events = (context: string) =>
    context
      .split("\n")
      .filter((l) => l.startsWith("event "))
      .map((l) => l.split(" · ").at(-1));

  it("carries as is: later events are delivered once, the process is stopped at exit, nothing is left", async () => {
    const s = session({ monitorCommand: "sleep 30", transcript: FINAL_TRANSCRIPT });
    appendFileSync(s.outputPath, "tick 1\n");
    // The first prompt settles the carried agent and delivers the first event.
    expect(events(s.prompt())).toEqual(["tick 1"]);

    const { qualified, transfer } = compactAgain(s, 10_000);
    expect(qualified.terminalized).toEqual([]);
    expect(qualified.refused).toEqual([]);
    expect(transfer.results).toEqual([
      { launchId: LAUNCH_IDS.monitor, kind: "relaunch_carried", pid: s.pid, outputPath: s.outputPath },
    ]);
    expect(itemOf(s.store, LAUNCH_IDS.monitor).state).toBe("active");
    process.kill(s.pid, 0); // still the one relaunched process, never respawned

    appendFileSync(s.outputPath, "tick 2\ntick 3\n");
    expect(events(s.prompt())).toEqual(["tick 2", "tick 3"]);
    expect(events(s.prompt())).toEqual([]);

    expect(stopRelaunchedMonitors(s.store, T).stopped).toEqual([{ launchId: LAUNCH_IDS.monitor, pid: s.pid }]);
    await waitGone(s.pid);
    expect(itemOf(s.store, LAUNCH_IDS.monitor)).toMatchObject({ state: "terminal", terminal: { outcome: "stopped" } });
    const cleaned = cleanupThread(s.store, T, s.monitorOutputDir);
    expect(cleaned.retained).toEqual([]);
    expect(cleaned.fencesRemoved).toContain(s.outputPath);
    expect(s.store.getItem(T, LAUNCH_IDS.monitor)).toBeNull();
  });

  it("a terminal record over a live relaunch never leaks it: exit stops it, cleanup keeps its fence until it is gone", async () => {
    const s = session({ monitorCommand: "sleep 30", transcript: FINAL_TRANSCRIPT });
    s.prompt();
    // The 0.4.3 soak state: recorded failed while the relaunched process kept running.
    s.store.recordTerminal({
      threadId: T,
      launchId: LAUNCH_IDS.monitor,
      outcome: "failed",
      evidence: "monitor relaunch unavailable: launch_not_found",
      nowMs: 20_000,
    });
    const early = cleanupThread(s.store, T, s.monitorOutputDir);
    expect(early.retained).toEqual([
      expect.objectContaining({ launchId: LAUNCH_IDS.monitor, reason: "relaunch_process_live" }),
    ]);
    expect(s.store.getItem(T, LAUNCH_IDS.monitor)).not.toBeNull();

    expect(stopRelaunchedMonitors(s.store, T).stopped).toEqual([{ launchId: LAUNCH_IDS.monitor, pid: s.pid }]);
    await waitGone(s.pid);
    // Its terminal record stands; only the process was stopped.
    expect(itemOf(s.store, LAUNCH_IDS.monitor).terminal).toMatchObject({ outcome: "failed" });
    expect(cleanupThread(s.store, T, s.monitorOutputDir).retained).toEqual([]);
    expect(s.store.getItem(T, LAUNCH_IDS.monitor)).toBeNull();
  });
});
