// Failure classification (DD-3): a pure table from the boundary's failure
// vocabulary onto Epic 02's retryable-or-not. The queue machinery consumes
// `retryable` exactly as it always has — no queue changes, no new states.
// `safeCall` is the containment wrapper around the host function: a thrown
// exception classifies `other` (AC-3.3) and the adapter-owned timeout race
// classifies `timeout` (DD-6) — both structured failures, so no host
// function behavior can crash a drain.
import type {
  ModelCall,
  ModelCallFailureKind,
  ModelCallInput,
  ModelCallResult,
} from "./types.js";

export const FAILURE_CLASSIFICATION: Record<ModelCallFailureKind, { retryable: boolean }> = {
  rate_limit: { retryable: true },
  timeout: { retryable: true },
  network: { retryable: true },
  empty_output: { retryable: true },
  other: { retryable: true },
  auth: { retryable: false },
  invalid_request: { retryable: false },
};

/** try/catch + timeout race around the host function (AC-3.3, DD-6). */
export async function safeCall(
  call: ModelCall,
  input: ModelCallInput,
  timeoutMs: number,
): Promise<ModelCallResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<ModelCallResult>((resolve) => {
    timer = setTimeout(() => {
      resolve({
        ok: false,
        kind: "timeout",
        message: `model call timed out after ${String(timeoutMs)}ms`,
      });
    }, timeoutMs);
  });
  // The async wrapper folds synchronous throws into the same rejection path —
  // the host's promise contract is not trusted (AC-3.3).
  const attempt = (async (): Promise<ModelCallResult> => {
    try {
      return await call(input);
    } catch (cause) {
      return { ok: false, kind: "other", message: String(cause) };
    }
  })();
  try {
    // A host that resolves after the race resolves into nothing (DD-6).
    return await Promise.race([attempt, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
