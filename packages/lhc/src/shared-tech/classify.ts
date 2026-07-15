// `safeCall` contains the host function: a thrown exception becomes `other`
// and the adapter-owned timeout race becomes `timeout`, so host behavior cannot
// crash a drain.
import type { ModelCall, ModelCallInput, ModelCallResult } from "./inference-types.js";

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
