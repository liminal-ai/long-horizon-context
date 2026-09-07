/**
 * Canonical segment boundaries for long native turns.
 *
 * Claude Code writes one native turn as many rollout lines; the SDK keeps the
 * whole run in one open canonical turn until the next prompt. A giant open
 * turn cannot be split at serving time (cc has no step indices), so the reader
 * closes the canonical turn itself at safe points with an ordinary `turn_end`:
 *
 * - **exchange**: a mapped tool_result line after which no tool call is left
 *   outstanding. Calls and results may be split across lines (late tool_use
 *   blocks of the same API message arrive as later lines); the outstanding-call
 *   set, not a message id, decides safety. The session appends the end only when
 *   the SDK's open-turn estimate is at or above the live threshold.
 * - **completion**: the assistant line that closes the native turn. Genuine
 *   completion closes the segment regardless of size.
 *
 * Nothing here touches the native turn lifecycle (`turnOpen`, turn_settled):
 * an artificial end is canonical bookkeeping only. Pure fold; no I/O.
 */
import type { MessageEventInput } from "lhc";

import type { RolloutLineItem } from "../rollout/types.js";
import { idempotencyKey, recordUuid } from "./map.js";
import { classifyTurnSignal } from "./turn-signal.js";

const HARNESS = "cc";

export type SegmentCandidateKind = "exchange" | "completion";

export interface SegmentCandidate {
  kind: SegmentCandidateKind;
  /** Source line identity the boundary is keyed to (stable across replay). */
  lineUuid: string;
}

export interface SegmentFoldState {
  /** Tool calls seen without their result yet, across line boundaries. */
  openCalls: Set<string>;
  /** Identity of the newest line that closed the native turn; null until one is seen. */
  lastSettledLineUuid: string | null;
}

export function createSegmentFoldState(): SegmentFoldState {
  return { openCalls: new Set(), lastSettledLineUuid: null };
}

/**
 * Fold one mapped rollout line. `events` are the line's mapped events before
 * any replay filtering, so pairing state is maintained even for lines the
 * host later skips. Returns the boundary candidate this line ends, if any.
 */
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
    // Only the assistant's own terminal line is a completion boundary. An
    // interrupt prompt closes the previous canonical turn by prompt boundary
    // and becomes a member of the next; the settled seam closes that one.
    return item.type === "assistant" ? { kind: "completion", lineUuid } : null;
  }
  if (sawResult && state.openCalls.size === 0) {
    return { kind: "exchange", lineUuid: recordUuid(item, lineIndex) };
  }
  return null;
}

export type SegmentEndReason = "cc_lhc_segment" | "cc_lhc_completion" | "cc_lhc_settled_catch_up";

/** The canonical `turn_end` for a boundary, keyed to its source line like every other cc event. */
export function segmentEndEvent(lineUuid: string, reason: SegmentEndReason): MessageEventInput {
  return {
    eventKind: "turn_end",
    idempotencyKey: idempotencyKey(lineUuid, 0, "turn_end"),
    actor: "system",
    harness: HARNESS,
    payload: { outcome: "completed", outcomeReason: reason },
  };
}
