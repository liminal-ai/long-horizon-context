export type ErrorClass = "caller_error" | "state_corruption" | "system_error";

export type ErrorCode =
  | "path_exists"
  | "thread_not_found"
  | "invalid_event"
  | "empty_batch"
  | "empty_stdin" // CLI adapter only, emitted before any SDK call
  | "turn_state_corrupt"
  | "storage_failure";

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

export function notImplemented(op: string): { ok: false; error: ErrorResult } {
  return {
    ok: false,
    error: {
      errorClass: "system_error",
      code: "storage_failure",
      reason: `not implemented: ${op}`,
    },
  };
}
