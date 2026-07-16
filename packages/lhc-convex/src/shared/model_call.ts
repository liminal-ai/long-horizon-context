import type { ModelCallResult } from "../client/types.js";

export async function safeModelCall(call: () => Promise<ModelCallResult>, timeoutMs: number): Promise<ModelCallResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
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
      return await call();
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
