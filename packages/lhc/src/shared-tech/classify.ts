// Failure classification is a pure table from the model-call failure vocabulary
// onto retryable-or-not. The queue machinery consumes `retryable` exactly as it
// always has: no queue changes, no new states. `safeCall` contains the host
// function: a thrown exception classifies `other` and the adapter-owned timeout
// race classifies `timeout`, so host behavior cannot crash a drain.
import type { ModelCall, ModelCallFailureKind, ModelCallInput, ModelCallResult } from "./inference-types.js";

export const FAILURE_CLASSIFICATION: Record<ModelCallFailureKind, { retryable: boolean }> = {
  rate_limit: { retryable: true },
  timeout: { retryable: true },
  network: { retryable: true },
  empty_output: { retryable: true },
  other: { retryable: true },
  auth: { retryable: false },
  invalid_request: { retryable: false },
};

/** try/catch + timeout race around the host function. */
export async function safeCall(call: ModelCall, input: ModelCallInput, timeoutMs: number): Promise<ModelCallResult> {
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
  // the host's promise contract is not trusted.
  const attempt = (async (): Promise<ModelCallResult> => {
    try {
      return await call(input);
    } catch (cause) {
      return { ok: false, kind: "other", message: String(cause) };
    }
  })();
  try {
    // A host that resolves after the race resolves into nothing.
    return await Promise.race([attempt, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
