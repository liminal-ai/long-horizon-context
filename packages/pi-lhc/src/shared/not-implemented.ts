import type { OpResult } from "lhc";

// Fail-closed primitives for unfinished implementation slots. No stub may
// report success for unimplemented capture, derivation, validation, fork
// seeding, or replay. Pure algorithms throw `NotImplementedError`;
// services/adapters return the `notImplemented` OpResult. Both are unmistakably
// "not done", never a silent success.

/** Thrown by pure-algorithm stubs (map-message, idempotency, turn-accumulator,
 *  classifyFailure) before implementation. Tests assert behavior, never that
 *  this was thrown. */
export class NotImplementedError extends Error {
  readonly operation: string;
  constructor(operation: string) {
    super(`${operation} is not implemented yet`);
    this.name = "NotImplementedError";
    this.operation = operation;
  }
}

/** Fail-closed structured result for service/adapter/handler stubs. Uses LHC's
 *  `not_implemented` error code. */
export function notImplemented<T>(operation: string): OpResult<T> {
  return {
    ok: false,
    error: {
      errorClass: "system_error",
      code: "not_implemented",
      reason: `${operation} is not implemented yet`,
    },
  };
}
