/** Lifecycle signals derived from the Claude rollout observation adapter. */

export type LifecycleSignalKind =
  | "session_bound"
  | "turn_opened"
  | "sampling_observed"
  | "turn_settled"
  | "native_compact_observed"
  | "session_mismatch_observed"
  | "capture_degraded";

export type TurnOpenReason = "user_prompt" | "tool_result";
export type TurnSettleReason = "end_turn" | "interrupt" | "stop_sequence" | "other";

export type LifecycleSignal =
  | { kind: "session_bound"; sessionId: string }
  | { kind: "turn_opened"; reason: TurnOpenReason }
  | {
      kind: "sampling_observed";
      /** Stable sampling identity from the rollout (assistant message.id when present). */
      samplingId: string;
      model?: string;
      providerUsage?: Record<string, unknown>;
    }
  | { kind: "turn_settled"; reason: TurnSettleReason }
  | { kind: "native_compact_observed"; summaryPreview?: string }
  | { kind: "session_mismatch_observed"; expected: string; observed: string }
  | { kind: "capture_degraded"; reason: string; generation: number };

export interface ObservationStats {
  sidechain: number;
  unknown: number;
  meta: number;
  image: number;
}
