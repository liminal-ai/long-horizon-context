import type { ModelCall, ModelCallInput, ModelCallResult } from "./inference-types.js";

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
  const attempt = (async (): Promise<ModelCallResult> => {
    try {
      return await call(input);
    } catch (cause) {
      return { ok: false, kind: "other", message: String(cause) };
    }
  })();
  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
