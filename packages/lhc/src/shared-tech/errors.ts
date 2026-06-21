export type ErrorClass = "caller_error" | "state_corruption" | "system_error";

export type ErrorCode =
  | "path_exists"
  | "thread_not_found"
  | "ambiguous_thread_id" // caller_error — a partial thread id matched more than one thread (A-8 partial-id resolve)
  | "invalid_thread_ref" // empty/blank file path or otherwise unusable reference
  | "invalid_event"
  | "empty_batch"
  | "turn_state_corrupt"
  | "storage_failure"
  // Epic 02 (tech design §Interfaces, issue 4):
  | "turn_open" // caller_error — mutation against an open turn
  | "message_initiates_turn" // caller_error — delete refused toward turns.delete
  | "message_not_found" // caller_error
  | "turn_not_found" // caller_error
  | "unknown_work_kind" // state_corruption — unregistered kind at dispatch
  | "provider_failure" // system_error — exhausted retries; form.reason carries detail
  | "source_damaged" // state_corruption — handler found corrupt source; form blocked
  | "inference_unavailable" // caller_error — synchronous derivation called outside an SDK inference seam
  | "derivation_work_in_flight" // caller_error — synchronous derive refused because equivalent queued work is live
  | "derivation_retry_scheduled" // system_error — synchronous derive failed retryably and requeued durable work
  | "derivation_completion_mismatch" // state_corruption — handler writes did not exactly match queued derivation targets
  // Epic 03 (tech design §Interface Definitions): the surface-skeleton stub
  // contract — machine-readable, never a throw on the thread-view surface.
  | "not_implemented" // system_error — operation's story has not landed yet
  // Epic 03 Story 2 (AC-2.2/2.3): compact-time config rejection — unlike SDK
  // construction (programmer error, throws), a bad compact invocation is an
  // operational caller error returned as a result.
  | "unknown_profile" // caller_error — named profile not configured
  | "invalid_view_config" // caller_error — band sum / bound violation, named
  | "compact_stopped" // caller_error — caller stopped compact before it wrote a view
  // Epic 03 Story 5: materialize accepts pi-session only; an unknown format
  // is a caller error naming the accepted values (story Scope).
  | "unknown_format" // caller_error — materialize format not supported
  // Epic 04 Story 1: bounded listing — a bad bounds option (from > to,
  // limit < 1, non-integer) is an operational caller error returned as a
  // result, mirroring the compact-params precedent (additive code, the
  // Epic 03 deviation pattern).
  | "invalid_bounds"; // caller_error — list bounds option rejected

export interface ErrorResult {
  errorClass: ErrorClass;
  code: ErrorCode;
  reason: string; // human-readable; machine logic switches on code
  eventIndex?: number; // present on batch validation failures
}

// Expected operational failures — caller errors, corruption, environment
// failures — are always returned as OpResult errors, never thrown.
// Programmer bugs inside lhc may still throw; callers are not expected
// to handle throws as contract outcomes.
export type OpResult<T> = { ok: true; value: T } | { ok: false; error: ErrorResult };

// Infrastructure failures (SQLite, fs) are expected operational outcomes,
// caught at the operation boundary and wrapped with the underlying detail.
export function storageFailure(reason: string): { ok: false; error: ErrorResult } {
  return {
    ok: false,
    error: { errorClass: "system_error", code: "storage_failure", reason },
  };
}
