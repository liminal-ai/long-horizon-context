export type LifecycleSignalKind =
  | "session_bound"
  | "turn_opened"
  | "sampling_observed"
  | "post_measurement_estimate"
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
      samplingId: string;
      model?: string;
      providerUsage?: Record<string, unknown>;
      contextLimitRejected?: true;
    }
  | {
      kind: "post_measurement_estimate";
      tokens: number;
      source: string;
      mode?: "set" | "add";
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
