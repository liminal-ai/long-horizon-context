export type ErrorClass = "caller_error" | "state_corruption" | "system_error";

export type ErrorCode =
  | "path_exists"
  | "thread_not_found"
  | "ambiguous_thread_id"
  | "conflicting_lhc_launch_flags"
  | "invalid_thread_ref"
  | "invalid_thread_alias"
  | "alias_not_found"
  | "alias_bound_to_other_thread"
  | "mid_turn"
  | "thread_exists"
  | "invalid_event"
  | "empty_batch"
  | "turn_state_corrupt"
  | "storage_failure"
  | "turn_open"
  | "message_initiates_turn"
  | "message_not_found"
  | "turn_not_found"
  | "unknown_work_kind"
  | "provider_failure"
  | "source_damaged"
  | "inference_unavailable"
  | "derivation_work_in_flight"
  | "derivation_completion_mismatch"
  | "not_implemented"
  | "unknown_profile"
  | "invalid_view_config"
  | "compact_stopped"
  | "unknown_format"
  | "invalid_bounds"
  | "invalid_target_tokens"
  | "invalid_compact_continuation_input"
  | "compact_continuation_writer_conflict"
  | "compact_continuation_attempt_conflict"
  | "unsettled_capture_seam"
  | "forced_boundary_thread"
  | "compact_continuation_parts_thread"
  | "invalid_compact_policy";

export interface ErrorResult {
  errorClass: ErrorClass;
  code: ErrorCode;
  reason: string;
  eventIndex?: number;
}

export type OpResult<T> = { ok: true; value: T } | { ok: false; error: ErrorResult };

export function storageFailure(reason: string): { ok: false; error: ErrorResult } {
  return {
    ok: false,
    error: { errorClass: "system_error", code: "storage_failure", reason },
  };
}
