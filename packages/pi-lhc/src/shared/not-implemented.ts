import type { OpResult } from "lhc";

// The two fail-closed primitives every Epic 1 stub uses until its owning story
// lands. The anti-shim rule (story §Anti-Shim Requirements): no stub may report
// success for unimplemented capture, derivation, validation, fork seeding, or
// replay. Pure algorithms throw `NotImplementedError`; services/adapters return
// the `notImplemented` OpResult. Both are unmistakably "not done", never a
// silent success.

/** Thrown by pure-algorithm stubs (map-message, idempotency, turn-accumulator,
 *  classifyFailure) before their story implements them. Tests assert behavior,
 *  never that this was thrown (test-plan: "never asserting on NotImplementedError"). */
export class NotImplementedError extends Error {
  readonly operation: string;
  constructor(operation: string) {
    super(`${operation} is not implemented yet (Epic 1 foundation stub)`);
    this.name = "NotImplementedError";
    this.operation = operation;
  }
}

/** Fail-closed structured result for service/adapter/handler stubs. Uses LHC's
 *  `not_implemented` error code ("operation's story has not landed yet"). */
export function notImplemented<T>(operation: string): OpResult<T> {
  return {
    ok: false,
    error: {
      errorClass: "system_error",
      code: "not_implemented",
      reason: `${operation} is not implemented yet (Epic 1 foundation stub)`,
    },
  };
}
