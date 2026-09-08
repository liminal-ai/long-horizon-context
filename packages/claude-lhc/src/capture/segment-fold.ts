/**
 * Size-based canonical turn ends for long native turns (port of cc-lhc's
 * intake/segment-fold.ts, 0.4.1).
 *
 * Claude Code runs one native turn as many wire messages; the sidecar keeps the
 * whole run in one open canonical turn until the next prompt. A giant open turn
 * cannot be split at serving time, so the session closes the canonical turn
 * itself at safe points with an ordinary `turn_end`: a mapped tool_result after
 * which no tool call is left outstanding, once the open turn's estimate is at or
 * above the threshold. Calls and results may be split across wire messages, so
 * the outstanding-call set, not a message id, decides safety.
 *
 * Nothing here touches the native turn (`#turnOpen`, the SDK result): an
 * artificial end is canonical bookkeeping only. Core keeps exactly one open
 * turn, so a later turn_end (mid-turn compact, settle) landing on the fresh
 * empty turn is a no-op there, not an error. Pure fold; no I/O.
 */
import type { MessageEventInput } from "lhc";
import { HARNESS, idempotencyKey } from "./mapper.ts";

export const SEGMENT_END_REASON = "claude_lhc_segment";

export interface SegmentFoldState {
  /** Tool calls seen without their result yet, across wire-message boundaries. */
  openCalls: Set<string>;
}

export function createSegmentFoldState(): SegmentFoldState {
  return { openCalls: new Set() };
}

export interface SegmentCandidate {
  /** The tool call whose result left no call outstanding. */
  closedBy: string;
}

/**
 * Fold one wire message's mapped events (before any intake filtering, so pairing
 * state is kept for every message). Returns the boundary this message ends, if any.
 */
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

/** The native turn is over: a call it left unanswered never gets its result and must not block the next turn. */
export function resetSegmentFold(state: SegmentFoldState): void {
  state.openCalls.clear();
}

/** Half the full share of the view the compact builds, as cc-lhc's segmentThresholdTokens. */
export function segmentThresholdTokens(viewTargetTokens: number, fullSharePercent: number): number {
  return (viewTargetTokens * fullSharePercent) / 100 / 2;
}

/** The canonical `turn_end` for a boundary, keyed to the wire message that closed it (a repeat is an SDK skip). */
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
