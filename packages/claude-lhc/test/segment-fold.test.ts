import { describe, expect, test } from "bun:test";
import type { MessageEventInput } from "lhc";
import {
  createSegmentFoldState,
  foldSegmentEvents,
  resetSegmentFold,
  segmentEndEvent,
  segmentThresholdTokens,
} from "../src/capture/segment-fold.ts";

const call = (id: string): MessageEventInput => ({
  eventKind: "tool_call",
  idempotencyKey: `k:${id}:call`,
  actor: "assistant",
  harness: "claude-lhc",
  payload: { toolCallId: id, toolName: "Read", arguments: {} },
});
const result = (id: string): MessageEventInput => ({
  eventKind: "tool_result",
  idempotencyKey: `k:${id}:res`,
  actor: "tool",
  harness: "claude-lhc",
  payload: { toolCallId: id, content: "ok", isError: false },
});
const text = (): MessageEventInput => ({
  eventKind: "assistant_text",
  idempotencyKey: "k:text",
  actor: "assistant",
  harness: "claude-lhc",
  payload: { text: "hi" },
});

describe("segment fold", () => {
  test("no boundary while any call is outstanding; the result that clears the set is the boundary", () => {
    const state = createSegmentFoldState();
    expect(foldSegmentEvents(state, [call("a"), call("b")])).toBeNull();
    expect(foldSegmentEvents(state, [result("a")])).toBeNull();
    expect(foldSegmentEvents(state, [result("b")])).toEqual({ closedBy: "b" });
  });
  test("calls and results split across messages pair by id, not by message", () => {
    const state = createSegmentFoldState();
    expect(foldSegmentEvents(state, [call("a")])).toBeNull();
    expect(foldSegmentEvents(state, [call("b"), result("a")])).toBeNull();
    expect(foldSegmentEvents(state, [result("b")])).toEqual({ closedBy: "b" });
  });
  test("text-only messages are never a boundary; reset forgets an abandoned call", () => {
    const state = createSegmentFoldState();
    expect(foldSegmentEvents(state, [text()])).toBeNull();
    foldSegmentEvents(state, [call("orphan")]);
    resetSegmentFold(state);
    expect(foldSegmentEvents(state, [call("c"), result("c")])).toEqual({ closedBy: "c" });
  });
  test("threshold is half the full share; the end event is keyed to the wire line and marked completed", () => {
    expect(segmentThresholdTokens(60_000, 30)).toBe(9_000);
    const end = segmentEndEvent("wire-uuid", "2026-09-08T00:00:00.000Z", "2026-09-08T00:01:00.000Z");
    expect(end.idempotencyKey).toBe("claude-lhc:wire-uuid:0:turn_end");
    expect(end.payload).toEqual({
      outcome: "completed",
      outcomeReason: "claude_lhc_segment",
      startedAt: "2026-09-08T00:00:00.000Z",
      endedAt: "2026-09-08T00:01:00.000Z",
    });
  });
});
