import { describe, expect, it } from "vitest";

import { mapRolloutLine } from "../../src/intake/map.js";
import { createSegmentFoldState, foldSegmentLine, segmentEndEvent } from "../../src/intake/segment-fold.js";
import type { RolloutLineItem } from "../../src/rollout/types.js";

function fold(state: ReturnType<typeof createSegmentFoldState>, item: RolloutLineItem, index = 0) {
  return foldSegmentLine(state, item, index, mapRolloutLine(item, index).events);
}

const prompt: RolloutLineItem = { type: "user", uuid: "u0", message: { role: "user", content: "research it" } };
const thinkingOnly: RolloutLineItem = {
  type: "assistant",
  uuid: "a0",
  message: {
    role: "assistant",
    stop_reason: "tool_use",
    content: [{ type: "thinking", thinking: "", signature: "SIG" }],
  },
};
const twoCalls: RolloutLineItem = {
  type: "assistant",
  uuid: "a1",
  message: {
    role: "assistant",
    stop_reason: "tool_use",
    content: [
      { type: "tool_use", id: "t1", name: "Read", input: {} },
      { type: "tool_use", id: "t2", name: "Read", input: {} },
    ],
  },
};
function result(uuid: string, id: string): RolloutLineItem {
  return {
    type: "user",
    uuid,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
  };
}
const textThenLateCall: RolloutLineItem = {
  type: "assistant",
  uuid: "a2",
  message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "text", text: "next" }] },
};
const lateCall: RolloutLineItem = {
  type: "assistant",
  uuid: "a3",
  message: {
    role: "assistant",
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id: "t3", name: "Bash", input: {} }],
  },
};
const terminal: RolloutLineItem = {
  type: "assistant",
  uuid: "a4",
  message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] },
};
const interrupt: RolloutLineItem = {
  type: "user",
  uuid: "u9",
  message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
};

describe("segment fold", () => {
  it("offers an exchange boundary only once every call split across lines has its result", () => {
    const state = createSegmentFoldState();
    expect(fold(state, prompt)).toBeNull();
    expect(fold(state, thinkingOnly)).toBeNull();
    expect(fold(state, twoCalls)).toBeNull();
    // First of two parallel results: t2 still outstanding.
    expect(fold(state, result("r1", "t1"))).toBeNull();
    expect(fold(state, result("r2", "t2"))).toEqual({ kind: "exchange", lineUuid: "r2" });
    // A text line of the next API message is not a boundary even with nothing outstanding.
    expect(fold(state, textThenLateCall)).toBeNull();
    expect(fold(state, lateCall)).toBeNull();
    expect(fold(state, result("r3", "t3"))).toEqual({ kind: "exchange", lineUuid: "r3" });
    expect(state.openCalls.size).toBe(0);
  });

  it("the assistant terminal line is a completion boundary and records settled identity", () => {
    const state = createSegmentFoldState();
    fold(state, prompt);
    expect(fold(state, terminal)).toEqual({ kind: "completion", lineUuid: "a4" });
    expect(state.lastSettledLineUuid).toBe("a4");
  });

  it("an interrupted task's abandoned calls never block the next task's exchanges", () => {
    const state = createSegmentFoldState();
    fold(state, twoCalls);
    // Claude Code's interrupt line: not a completion boundary, but the native
    // task is over, so its unanswered calls are released.
    expect(fold(state, interrupt)).toBeNull();
    expect(state.lastSettledLineUuid).toBe("u9");
    expect(state.openCalls.size).toBe(0);
    // Next real task: prompt, one call, its result — a clean exchange boundary.
    expect(fold(state, { type: "user", uuid: "u10", message: { role: "user", content: "new task" } })).toBeNull();
    expect(fold(state, lateCall)).toBeNull();
    expect(fold(state, result("r3", "t3"))).toEqual({ kind: "exchange", lineUuid: "r3" });
  });

  it("an interrupt delivered as a tool_result line is handled the same way", () => {
    const state = createSegmentFoldState();
    fold(state, twoCalls);
    const interruptResult: RolloutLineItem = {
      type: "user",
      uuid: "u11",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "[Request interrupted by user for tool use]" }],
      },
    };
    expect(fold(state, interruptResult)).toBeNull();
    expect(state.openCalls.size).toBe(0);
    fold(state, { type: "user", uuid: "u12", message: { role: "user", content: "again" } });
    fold(state, lateCall);
    expect(fold(state, result("r3", "t3"))).toEqual({ kind: "exchange", lineUuid: "r3" });
  });

  it("a mid-task steer prompt does not release calls still in flight", () => {
    const state = createSegmentFoldState();
    fold(state, twoCalls);
    expect(fold(state, { type: "user", uuid: "u13", message: { role: "user", content: "also check X" } })).toBeNull();
    expect(state.openCalls.has("t1")).toBe(true);
    fold(state, result("r1", "t1"));
    expect(fold(state, result("r2", "t2"))).toEqual({ kind: "exchange", lineUuid: "r2" });
  });

  it("a result line with a call still outstanding is never a boundary, even after a prior boundary", () => {
    const state = createSegmentFoldState();
    fold(state, twoCalls);
    fold(state, result("r1", "t1"));
    fold(state, result("r2", "t2"));
    fold(state, lateCall);
    expect(fold(state, result("rX", "unknown-call"))).toBeNull();
    expect(fold(state, result("r3", "t3"))).toEqual({ kind: "exchange", lineUuid: "r3" });
  });

  it("keys the canonical end to the source line, like every other cc event", () => {
    const end = segmentEndEvent("r2", "cc_lhc_segment");
    expect(end).toEqual({
      eventKind: "turn_end",
      idempotencyKey: "cc-lhc:rollout:r2:0:turn_end",
      actor: "system",
      harness: "cc",
      payload: { outcome: "completed", outcomeReason: "cc_lhc_segment" },
    });
    expect(segmentEndEvent("r2", "cc_lhc_completion").idempotencyKey).toBe(end.idempotencyKey);
  });
});
