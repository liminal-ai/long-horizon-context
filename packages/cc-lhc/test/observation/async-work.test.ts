import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createAsyncWorkFold, liveAsyncWork, type OpenAsyncWork } from "../../src/observation/async-work.js";
import { observeRolloutLines } from "../../src/observation/observe.js";
import type { RolloutLineItem } from "../../src/rollout/types.js";

/**
 * Real Claude Code 2.1.235 records captured from throwaway probe sessions.
 * These drive through the same per-line observation the capture session runs,
 * so the derivation is exercised through its production entry point rather
 * than by hand-built shapes.
 */
const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "async-work",
  "claude-2.1.235-async-work.jsonl",
);

function fixtureLines(): RolloutLineItem[] {
  return readFileSync(FIXTURE_PATH, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RolloutLineItem);
}

const NOW = 1_787_135_000_000;

/** Replay lines through the production observer and read the open set. */
function replay(
  lines: readonly RolloutLineItem[],
  options: { nowMs?: number; suppressRuntimeLifecycle?: boolean } = {},
): OpenAsyncWork[] {
  const asyncWorkFold = createAsyncWorkFold();
  observeRolloutLines(lines, {
    asyncWorkFold,
    ...(options.suppressRuntimeLifecycle === true ? { suppressRuntimeLifecycle: true } : {}),
  });
  return liveAsyncWork(asyncWorkFold, options.nowMs ?? NOW);
}

/** The launch/acknowledgement pairs, in fixture order. */
const LAUNCH_PAIRS = 10;

describe("open async work derived from real 2.1.235 records", () => {
  it("opens exactly one item per launcher acknowledgement", () => {
    const open = replay(fixtureLines().slice(0, LAUNCH_PAIRS));
    expect(open.map((work) => work.family)).toEqual([
      "agent",
      "workflow",
      "background_shell",
      "monitor",
      "scheduled_wakeup",
    ]);
    expect(open.map((work) => work.taskId)).toEqual([
      "a84a875db2d82b281",
      "wesz8pl39",
      "bxuhr034a",
      "bpla2kne5",
      undefined,
    ]);
  });

  it("labels each item from the call that launched it", () => {
    const open = replay(fixtureLines().slice(0, LAUNCH_PAIRS));
    const byFamily = new Map(open.map((work) => [work.family, work]));
    expect(byFamily.get("agent")?.description).toBe("probe agent");
    expect(byFamily.get("workflow")?.description).toBe("probe-wf");
    expect(byFamily.get("monitor")?.description).toBe("probe monitor");
    expect(byFamily.get("scheduled_wakeup")?.description).toBe("probe wakeup");
    expect(byFamily.get("background_shell")?.description).toBe("Run background heartbeat logger");
  });

  it("keeps the acknowledgement itself from closing anything", () => {
    // The whole point: an async launcher's tool result says "started", and the
    // launch/ack pairs alone must leave every item open.
    expect(replay(fixtureLines().slice(0, LAUNCH_PAIRS))).toHaveLength(5);
  });

  it("leaves work open across a nonterminal monitor event and shows it", () => {
    const lines = fixtureLines();
    const open = replay(lines.slice(0, LAUNCH_PAIRS + 1));
    expect(open).toHaveLength(5);
    const monitor = open.find((work) => work.family === "monitor");
    expect(monitor?.latestEvent).toBe("TICK-2");
  });

  it("stays open under repeated nonterminal progress", () => {
    const lines = fixtureLines();
    const event = lines[LAUNCH_PAIRS]!;
    const open = replay([...lines.slice(0, LAUNCH_PAIRS), event, event, event]);
    expect(open).toHaveLength(5);
    expect(open.find((work) => work.family === "monitor")?.latestEvent).toBe("TICK-2");
  });

  it("closes exactly the completed item and nothing else", () => {
    const lines = fixtureLines();
    // ...through the agent completion only.
    const afterAgent = replay(lines.slice(0, LAUNCH_PAIRS + 2));
    expect(afterAgent.map((work) => work.family)).toEqual([
      "workflow",
      "background_shell",
      "monitor",
      "scheduled_wakeup",
    ]);
    // ...and then the workflow completion.
    const afterWorkflow = replay(lines.slice(0, LAUNCH_PAIRS + 3));
    expect(afterWorkflow.map((work) => work.family)).toEqual(["background_shell", "monitor", "scheduled_wakeup"]);
  });

  it("closes the matching item on an explicit TaskStop", () => {
    const lines = fixtureLines();
    const open = replay(lines.slice(0, LAUNCH_PAIRS + 5));
    expect(open.map((work) => work.family)).toEqual(["background_shell", "scheduled_wakeup"]);
  });

  it("closes on a stopped notification in both the queue and user-record shapes", () => {
    const lines = fixtureLines();
    const queueOnly = replay(lines.slice(0, lines.length - 1));
    expect(queueOnly.map((work) => work.family)).toEqual(["scheduled_wakeup"]);
    // The same envelope is delivered again as a synthetic user turn; closing is
    // idempotent, so the second delivery changes nothing.
    expect(replay(lines).map((work) => work.family)).toEqual(["scheduled_wakeup"]);
  });

  it("closes on a task-notification delivered as a synthetic user turn alone", () => {
    const lines = fixtureLines();
    // Resume catch-up can reach the delivered user record without the queue
    // record that preceded it (a prune boundary, a re-read from an offset).
    const deliveredOnly = [...lines.slice(0, LAUNCH_PAIRS), lines[lines.length - 1]!];
    expect(replay(deliveredOnly).map((work) => work.family)).toEqual([
      "agent",
      "workflow",
      "monitor",
      "scheduled_wakeup",
    ]);
  });

  it("reconstructs the same set when the whole transcript is re-read", () => {
    const lines = fixtureLines();
    // Resume catch-up re-reads from the top; the derivation must land in the
    // same place, including launch-then-stopped for the background shell.
    const once = replay(lines);
    const twice = replay([...lines]);
    expect(twice).toEqual(once);
    expect(once.map((work) => work.family)).toEqual(["scheduled_wakeup"]);
  });

  it("ignores a rebuilt historical prefix", () => {
    // Replayed prefix lines are a projection of history the swap already
    // killed; they must not resurrect work.
    expect(replay(fixtureLines(), { suppressRuntimeLifecycle: true })).toEqual([]);
  });
});

/**
 * Shapes the fixture cannot hold because they need a session in a state the
 * probe could not reach (aggregate orphan reports, superseded wakeups, error
 * results). Each is the documented 2.1.235 shape.
 */
describe("open async work: shapes beyond the captured session", () => {
  function assistantToolUse(id: string, name: string, input: Record<string, unknown>): RolloutLineItem {
    return {
      type: "assistant",
      uuid: `a-${id}`,
      message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
    } as unknown as RolloutLineItem;
  }

  function toolResult(id: string, result: Record<string, unknown>): RolloutLineItem {
    return {
      type: "user",
      uuid: `r-${id}`,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
      toolUseResult: result,
    } as unknown as RolloutLineItem;
  }

  function notification(body: string): RolloutLineItem {
    return {
      type: "queue-operation",
      operation: "enqueue",
      content: `<task-notification>\n${body}\n</task-notification>`,
    } as unknown as RolloutLineItem;
  }

  const bashLaunch = [
    assistantToolUse("t1", "Bash", { command: "sleep 600", description: "long build", run_in_background: true }),
    toolResult("t1", { stdout: "", stderr: "", interrupted: false, backgroundTaskId: "b111" }),
  ];
  const agentLaunch = [
    assistantToolUse("t2", "Agent", { description: "reviewer", subagent_type: "general-purpose", prompt: "go" }),
    toolResult("t2", { isAsync: true, status: "async_launched", agentId: "a222", description: "reviewer" }),
  ];

  it("keeps concurrent items apart by their own ids", () => {
    const open = replay([...bashLaunch, ...agentLaunch]);
    expect(open.map((work) => work.key)).toEqual(["b111", "a222"]);
    // Closing one leaves the other exactly where it was.
    const afterOne = replay([
      ...bashLaunch,
      ...agentLaunch,
      notification("<task-id>b111</task-id>\n<status>completed</status>"),
    ]);
    expect(afterOne.map((work) => work.key)).toEqual(["a222"]);
  });

  it("closes on failed and killed as well as completed and stopped", () => {
    for (const status of ["completed", "failed", "killed", "stopped"]) {
      const open = replay([...bashLaunch, notification(`<task-id>b111</task-id>\n<status>${status}</status>`)]);
      expect(open, status).toEqual([]);
    }
  });

  it("never closes on a notification that carries no terminal status", () => {
    const open = replay([
      ...bashLaunch,
      notification('<task-id>b111</task-id>\n<summary>Background command "long build" appears stalled</summary>'),
    ]);
    expect(open).toHaveLength(1);
    expect(open[0]?.latestEvent).toContain("appears stalled");
  });

  it("ignores orphan-summary scan markers, including ones naming live tasks", () => {
    // An aggregate report pads its id list with markers; one of them names a
    // task Claude is explicitly NOT reporting because it is still running.
    const open = replay([
      ...bashLaunch,
      ...agentLaunch,
      notification(
        "<task-id>a222</task-id>\n<task-id>__orphan_summary__:shell</task-id>\n" +
          "<task-id>__orphan_summary_live__:b111</task-id>\n<status>stopped</status>\n" +
          "<summary>2 background shell task(s) from the previous session have no completion record.</summary>",
      ),
    ]);
    expect(open.map((work) => work.key)).toEqual(["b111"]);
  });

  it("reads a notification out of a queued_command attachment", () => {
    const attachment = {
      type: "attachment",
      attachment: {
        type: "queued_command",
        commandMode: "task-notification",
        prompt: "<task-notification>\n<task-id>b111</task-id>\n<status>completed</status>\n</task-notification>",
      },
    } as unknown as RolloutLineItem;
    expect(replay([...bashLaunch, attachment])).toEqual([]);
  });

  it("reads a notification a rebuilt rollout re-served as a runtime note", () => {
    const reserved = {
      type: "user",
      uuid: "note",
      message: {
        role: "user",
        content:
          "[runtime note] <task-notification>\n<task-id>b111</task-id>\n<status>completed</status>\n</task-notification>",
      },
    } as unknown as RolloutLineItem;
    expect(replay([...bashLaunch, reserved])).toEqual([]);
  });

  it("holds at most one wakeup, because each call supersedes the last", () => {
    const first = [
      assistantToolUse("w1", "ScheduleWakeup", { delaySeconds: 600, reason: "first" }),
      toolResult("w1", { scheduledFor: NOW + 600_000, clampedDelaySeconds: 600, wasClamped: false }),
    ];
    const second = [
      assistantToolUse("w2", "ScheduleWakeup", { delaySeconds: 300, reason: "second" }),
      toolResult("w2", { scheduledFor: NOW + 300_000, clampedDelaySeconds: 300, wasClamped: false }),
    ];
    const open = replay([...first, ...second]);
    expect(open).toHaveLength(1);
    expect(open[0]?.description).toBe("second");
  });

  it("closes the wakeup on stop:true and once its moment has passed", () => {
    const armed = [
      assistantToolUse("w1", "ScheduleWakeup", { delaySeconds: 600, reason: "loop" }),
      toolResult("w1", { scheduledFor: NOW + 600_000, clampedDelaySeconds: 600, wasClamped: false }),
    ];
    expect(replay(armed)).toHaveLength(1);
    // Already fired: nothing left for a swap to kill.
    expect(replay(armed, { nowMs: NOW + 700_000 })).toEqual([]);
    const stopped = [
      ...armed,
      assistantToolUse("w2", "ScheduleWakeup", { stop: true }),
      toolResult("w2", {
        scheduledFor: 0,
        clampedDelaySeconds: 0,
        wasClamped: false,
        stopped: true,
        cancelledWakeups: 1,
      }),
    ];
    expect(replay(stopped)).toEqual([]);
  });

  it("opens nothing for a synchronous agent or a workflow that failed to launch", () => {
    const sync = [
      assistantToolUse("s1", "Agent", { description: "inline", run_in_background: false, prompt: "go" }),
      toolResult("s1", { content: [{ type: "text", text: "done" }], totalDurationMs: 12 }),
    ];
    const failedWorkflow = [
      assistantToolUse("s2", "Workflow", { script: "bad" }),
      toolResult("s2", { status: "async_launched", taskType: "local_workflow", taskId: "w9", error: "syntax error" }),
    ];
    expect(replay([...sync, ...failedWorkflow])).toEqual([]);
  });

  it("does not open work from a subagent's own transcript", () => {
    const sidechain = [
      { ...(bashLaunch[0] as object), isSidechain: true } as RolloutLineItem,
      { ...(bashLaunch[1] as object), isSidechain: true } as RolloutLineItem,
    ];
    expect(replay(sidechain)).toEqual([]);
  });

  it("reports an unrecognized status as a diagnostic and opens nothing from it", () => {
    const fold = createAsyncWorkFold();
    observeRolloutLines([...bashLaunch, notification("<task-id>b111</task-id>\n<status>bewildered</status>")], {
      asyncWorkFold: fold,
    });
    expect(liveAsyncWork(fold, NOW)).toHaveLength(1);
    expect(fold.diagnostics).toEqual(['task-notification with unrecognized status "bewildered"']);
  });
});
