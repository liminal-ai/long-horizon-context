export type ErrorClass = "caller_error" | "state_corruption" | "system_error";

export type ErrorCode =
  | "path_exists"
  | "thread_not_found"
  | "invalid_thread_ref" // empty/blank file path or otherwise unusable reference
  | "invalid_event"
  | "empty_batch"
  | "empty_stdin" // CLI adapter only, emitted before any SDK call
  | "turn_state_corrupt"
  | "storage_failure"
  // Epic 02 (tech design §Interfaces, issue 4):
  | "turn_open" // caller_error — mutation against an open turn
  | "message_initiates_turn" // caller_error — delete refused toward turns.delete
  | "message_not_found" // caller_error
  | "turn_not_found" // caller_error
  | "unknown_work_kind" // state_corruption — unregistered kind at dispatch
  | "provider_not_configured" // caller_error — CLI drain without --provider / LHC_PROVIDER (DD-11)
  | "provider_failure" // system_error — exhausted retries; form.reason carries detail
  | "source_damaged"; // state_corruption — handler found corrupt source; form blocked

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
export type OpResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ErrorResult };

// Infrastructure failures (SQLite, fs) are expected operational outcomes,
// caught at the operation boundary and wrapped with the underlying detail.
export function storageFailure(reason: string): { ok: false; error: ErrorResult } {
  return {
    ok: false,
    error: { errorClass: "system_error", code: "storage_failure", reason },
  };
}
