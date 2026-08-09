/**
 * Generation-scoped sticky capture degradation.
 *
 * Phases: binding → ready | degraded → closed (terminal).
 * Until expected-file bind, thread/SDK, initial watcher catch-up, and initial
 * intake settle, phase stays binding — mutation must report not-ready.
 */

export type CapturePhase = "binding" | "ready" | "degraded" | "closed";

/** Cap retained distinct degradation reason keys (schema-drift safety). */
export const MAX_DEGRADATION_REASONS = 16;

export interface CaptureGenerationState {
  generation: number;
  phase: CapturePhase;
  /** Bounded sticky reason keys (first-seen order). */
  reasons: string[];
  /** Counts for repeated reason keys (log volume control). */
  reasonCounts: Record<string, number>;
  durableLineOffset: number;
}

export function createCaptureGeneration(generation = 1): CaptureGenerationState {
  return {
    generation,
    phase: "binding",
    reasons: [],
    reasonCounts: {},
    durableLineOffset: 0,
  };
}

/**
 * Collapse free-form reasons into a bounded key. Line numbers stay out of the
 * sticky key; first concrete diagnostic is preserved in the key prefix.
 */
export function boundDegradationReason(reason: string): string {
  if (reason.startsWith("unknown_shape:")) {
    // Prefer type=… segment if present; else generic unknown_shape.
    const typeMatch = /type=([^\s:]+)/.exec(reason);
    if (typeMatch !== null) return `unknown_shape:type=${typeMatch[1]}`;
    const lineMatch = /^unknown_shape:line_\d+$/.exec(reason);
    if (lineMatch !== null) return "unknown_shape:untyped";
    return reason.length > 64 ? `${reason.slice(0, 64)}…` : reason;
  }
  if (reason.startsWith("session_mismatch:")) return "session_mismatch";
  if (reason.startsWith("parse_error:")) return "parse_error";
  if (reason.startsWith("intake_")) {
    const head = reason.split(":")[0] ?? "intake";
    return head;
  }
  if (reason.startsWith("lineage_")) {
    const head = reason.split(":")[0] ?? "lineage";
    return head;
  }
  if (reason.startsWith("lifecycle_subscriber:")) return "lifecycle_subscriber";
  if (reason.startsWith("batch_queue:")) return "batch_queue";
  if (reason.startsWith("buffer_cap:")) return "buffer_cap";
  if (reason.startsWith("discovery_conflict:")) return "discovery_conflict";
  if (reason.startsWith("discover_failed:")) return "discover_failed";
  if (reason.startsWith("prefix_boundary:")) {
    const head = reason.split(":").slice(0, 2).join(":");
    return head.length > 64 ? `${head.slice(0, 64)}…` : head;
  }
  if (reason.startsWith("file_shrink:")) return "file_shrink";
  if (reason.startsWith("file_continuity:")) return "file_continuity";
  if (reason.startsWith("watcher_runtime:")) return "watcher_runtime";
  if (reason.startsWith("initial_catchup:")) return "initial_catchup";
  return reason.length > 80 ? `${reason.slice(0, 80)}…` : reason;
}

export function markCaptureReady(
  state: CaptureGenerationState,
  durableLineOffset: number,
): CaptureGenerationState {
  if (state.phase === "degraded" || state.phase === "closed") return state;
  return {
    ...state,
    phase: "ready",
    durableLineOffset,
  };
}

/** Aggregate overflow for unbounded distinct keys after the reasons cap. */
export const REASONS_CAPPED_KEY = "reasons_capped";

export interface MarkDegradedResult {
  state: CaptureGenerationState;
  /** Key that was counted (may be reasons_capped after overflow). */
  countKey: string;
  /** True only on the first occurrence of countKey in this generation. */
  isFirstForKey: boolean;
}

/**
 * Latch sticky degradation. Caps both `reasons` and `reasonCounts`.
 * Callers that log/emit must use `isFirstForKey` so post-cap novel reasons and
 * repeated identical failures do not produce unbounded lifecycle/log output.
 */
export function markCaptureDegraded(
  state: CaptureGenerationState,
  reason: string,
): CaptureGenerationState {
  return applyCaptureDegraded(state, reason).state;
}

/** Same as markCaptureDegraded but returns whether this is a first-seen key. */
export function applyCaptureDegraded(
  state: CaptureGenerationState,
  reason: string,
): MarkDegradedResult {
  // closed is terminal — never leave it.
  if (state.phase === "closed") {
    return { state, countKey: boundDegradationReason(reason), isFirstForKey: false };
  }
  const key = boundDegradationReason(reason);
  let reasons = state.reasons;
  let countKey = key;
  if (!reasons.includes(key)) {
    if (reasons.length < MAX_DEGRADATION_REASONS) {
      reasons = [...reasons, key];
    } else {
      // Cap reasonCounts as well as reasons: novel keys after the cap aggregate
      // under one bounded overflow key so the map cannot grow without bound.
      countKey = REASONS_CAPPED_KEY;
      if (!reasons.includes(REASONS_CAPPED_KEY)) {
        reasons = [...reasons, REASONS_CAPPED_KEY];
      }
    }
  }
  const prevCount = state.reasonCounts[countKey] ?? 0;
  const reasonCounts = {
    ...state.reasonCounts,
    [countKey]: prevCount + 1,
  };
  return {
    state: {
      ...state,
      phase: "degraded",
      reasons,
      reasonCounts,
    },
    countKey,
    isFirstForKey: prevCount === 0,
  };
}

export function markCaptureClosed(state: CaptureGenerationState): CaptureGenerationState {
  return { ...state, phase: "closed" };
}

export function isCaptureHealthy(state: CaptureGenerationState): boolean {
  return state.phase === "ready";
}

export function canMutateCapture(state: CaptureGenerationState): boolean {
  return state.phase === "ready";
}

/** Format reasons for logs: key (count) when count > 1. */
export function formatDegradationReasons(state: CaptureGenerationState): string {
  return state.reasons
    .map((key) => {
      const n = state.reasonCounts[key] ?? 1;
      return n > 1 ? `${key}×${n}` : key;
    })
    .join(", ");
}
