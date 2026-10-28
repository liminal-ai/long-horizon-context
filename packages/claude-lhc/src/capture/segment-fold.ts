import type { MessageEventInput } from "lhc";
import { HARNESS, idempotencyKey } from "./mapper.js";

export const SEGMENT_END_REASON = "claude_lhc_segment";

export interface SegmentFoldState {
  openCalls: Set<string>;
}

export function createSegmentFoldState(): SegmentFoldState {
  return { openCalls: new Set() };
}

export interface SegmentCandidate {
  closedBy: string;
}

export function foldSegmentEvents(
  state: SegmentFoldState,
  events: readonly MessageEventInput[],
): SegmentCandidate | null {
  let lastResult: string | null = null;
  for (const event of events) {
    if (event.eventKind === "tool_call") {
      const id = event.payload.toolCallId;
      if (typeof id === "string" && id !== "") state.openCalls.add(id);
    } else if (event.eventKind === "tool_result") {
      const id = event.payload.toolCallId;
      if (typeof id === "string") {
        state.openCalls.delete(id);
        lastResult = id;
      }
    }
  }
  return lastResult !== null && state.openCalls.size === 0 ? { closedBy: lastResult } : null;
}

export function resetSegmentFold(state: SegmentFoldState): void {
  state.openCalls.clear();
}

export function segmentThresholdTokens(viewTargetTokens: number, fullSharePercent: number): number {
  return (viewTargetTokens * fullSharePercent) / 100 / 2;
}

export function segmentEndEvent(
  lineUuid: string,
  startedAt: string | undefined,
  endedAt = new Date().toISOString(),
): MessageEventInput {
  return {
    eventKind: "turn_end",
    idempotencyKey: idempotencyKey(lineUuid, 0, "turn_end"),
    actor: "system",
    harness: HARNESS,
    payload: {
      outcome: "completed",
      outcomeReason: SEGMENT_END_REASON,
      ...(startedAt !== undefined ? { startedAt } : {}),
      endedAt,
    },
  };
}
