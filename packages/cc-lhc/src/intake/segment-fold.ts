import type { MessageEventInput } from "lhc";

import type { RolloutLineItem } from "../rollout/types.js";
import { idempotencyKey, recordUuid } from "./map.js";
import { classifyTurnSignal } from "./turn-signal.js";

const HARNESS = "cc";

export type SegmentCandidateKind = "exchange" | "completion";

export interface SegmentCandidate {
  kind: SegmentCandidateKind;
  lineUuid: string;
}

export interface SegmentFoldState {
  openCalls: Set<string>;
  lastSettledLineUuid: string | null;
}

export function createSegmentFoldState(): SegmentFoldState {
  return { openCalls: new Set(), lastSettledLineUuid: null };
}

export function foldSegmentLine(
  state: SegmentFoldState,
  item: RolloutLineItem,
  lineIndex: number,
  events: readonly MessageEventInput[],
): SegmentCandidate | null {
  let sawResult = false;
  for (const event of events) {
    if (event.eventKind === "tool_call") {
      const id = event.payload.toolCallId;
      if (typeof id === "string" && id !== "") state.openCalls.add(id);
    } else if (event.eventKind === "tool_result") {
      sawResult = true;
      const id = event.payload.toolCallId;
      if (typeof id === "string") state.openCalls.delete(id);
    }
  }

  const signal = classifyTurnSignal(item);
  if (signal === "closes") {
    const lineUuid = recordUuid(item, lineIndex);
    state.lastSettledLineUuid = lineUuid;
    state.openCalls.clear();
    return item.type === "assistant" ? { kind: "completion", lineUuid } : null;
  }
  if (sawResult && state.openCalls.size === 0) {
    return { kind: "exchange", lineUuid: recordUuid(item, lineIndex) };
  }
  return null;
}

export type SegmentEndReason = "cc_lhc_segment" | "cc_lhc_completion" | "cc_lhc_settled_catch_up";

export function segmentEndEvent(lineUuid: string, reason: SegmentEndReason): MessageEventInput {
  return {
    eventKind: "turn_end",
    idempotencyKey: idempotencyKey(lineUuid, 0, "turn_end"),
    actor: "system",
    harness: HARNESS,
    payload: { outcome: "completed", outcomeReason: reason },
  };
}
