import { performance } from "node:perf_hooks";

export async function callChatCompletion({ endpoint, keyEnv, model, extraJson, messages, timeoutMs = 60000 }) {
  const key = process.env[keyEnv];
  if (!key || key.trim() === "") throw new Error(`Missing API key env ${keyEnv}`);

  const body = {
    model,
    messages,
    temperature: 0.1,
    reasoning: { enabled: false },
    ...extraJson,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    const totalMs = Math.round(performance.now() - started);
    if (error?.name === "AbortError") {
      return { ok: false, status: 0, headersMs: totalMs, totalMs, error: `timeout after ${timeoutMs}ms` };
    }
    return { ok: false, status: 0, headersMs: totalMs, totalMs, error: String(error) };
  } finally {
    clearTimeout(timeout);
  }
  const headersMs = Math.round(performance.now() - started);
  const raw = await response.text();
  const totalMs = Math.round(performance.now() - started);

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = { raw };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      headersMs,
      totalMs,
      error: raw.slice(0, 2000),
      payload,
    };
  }

  const message = payload.choices?.[0]?.message ?? {};
  return {
    ok: typeof message.content === "string",
    status: response.status,
    headersMs,
    totalMs,
    text: message.content ?? "",
    reasoning: message.reasoning ?? null,
    usage: payload.usage,
    payload,
  };
}
