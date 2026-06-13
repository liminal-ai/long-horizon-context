// The real host (DD-13, AC-4.1): a test-owned ModelCall over OpenRouter's
// OpenAI-compatible chat-completions endpoint using plain fetch — test code,
// never production LHC transport. It exists to prove the injected-function
// contract is sufficient against a real endpoint: the same AC-1.2 shape the
// scripted fakes implement, exercised by the same seam-conformance helpers.
//
// Key resolution and the suite's ran/not-ran accounting also live here so the
// run/not-run state is one fact reported once (Flow 4): the suite-level guard
// in inference-real.test.ts calls resolveRealSuiteEnv exactly once at module
// load and emits exactly one visible line — absence of the key can never look
// like a pass.
import type {
  ModelCall,
  ModelCallFailureKind,
  ModelCallResult,
} from "../../src/inference/types.js";

export const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

// The suite's cheap default lane; LHC_OPENROUTER_MODEL overrides it for
// dial-in experiments without touching test code.
export const DEFAULT_OPENROUTER_MODEL = "openai/gpt-4o-mini";

// The guard's one fact: ran (with the key and the model lane the run will
// use) or not-ran (with reason). The shapes share no fields, so a not-ran
// record can never be mistaken for a keyed resolution by any structural
// check (AC-4.1's "absence of the key can never produce a silent pass").
export type RealSuiteEnv = { key: string; model: string } | { notRan: string };

export function resolveRealSuiteEnv(
  env: Record<string, string | undefined>,
): RealSuiteEnv {
  const key = env["LHC_OPENROUTER_KEY"];
  if (key === undefined || key.trim() === "") {
    return { notRan: "LHC_OPENROUTER_KEY unset" };
  }
  const model = env["LHC_OPENROUTER_MODEL"];
  return {
    key,
    model: model !== undefined && model.trim() !== "" ? model : DEFAULT_OPENROUTER_MODEL,
  };
}

// ── suite-level accounting (AC-4.1) ───────────────────────────────
//
// One visible line per resolution, written straight to the runner's stdout
// (not through a logger a reporter could swallow). The emission log lets the
// always-run guard test assert "exactly one ran/not-ran line" as data.
const emissions: string[] = [];

export function emitRealSuiteAccounting(env: RealSuiteEnv): string {
  const line =
    "notRan" in env
      ? `NOT-RAN: real-inference (${env.notRan})`
      : `RAN: real-inference (model ${env.model})`;
  emissions.push(line);
  process.stdout.write(`${line}\n`);
  return line;
}

export function realSuiteAccountingEmissions(): readonly string[] {
  return emissions;
}

// ── the real ModelCall (AC-1.2 over a real endpoint) ──────────────

// OpenRouter failure mapping (story §Technical Notes): auth-shaped statuses
// are terminal-classified by LHC, the rest fall where the table says.
function failureKindForStatus(status: number): ModelCallFailureKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status === 400) return "invalid_request";
  return "other";
}

function failure(kind: ModelCallFailureKind, message: string): ModelCallResult {
  return { ok: false, kind, message };
}

// The assistant text out of an OpenAI-compatible completion payload, or
// undefined when the body is not the shape the endpoint documents.
function extractAssistantText(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const first: unknown = choices[0];
  if (typeof first !== "object" || first === null) return undefined;
  const message = (first as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return undefined;
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content : undefined;
}

// createOpenRouterCall(key, defaultModel) implements the ModelCall contract
// over plain fetch. Host-side interpretation of the opaque routing keys
// (AC-1.2 grants this): OpenRouter takes one model slug, so a `model` string
// that already names a slug (contains "/") routes as-is and anything else —
// including conformance-probe placeholders — falls to the suite's default
// model. The provider string is carried but not consulted: this host has
// exactly one lane behind it.
export function createOpenRouterCall(key: string, defaultModel: string): ModelCall {
  return async (input) => {
    const slug = input.model.includes("/") ? input.model : defaultModel;
    let response: Response;
    try {
      response = await fetch(OPENROUTER_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: slug, messages: input.messages }),
      });
    } catch (error) {
      return failure("network", error instanceof Error ? error.message : String(error));
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return failure(
        failureKindForStatus(response.status),
        `HTTP ${String(response.status)}: ${body.slice(0, 200)}`,
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return failure("other", "response body was not JSON");
    }
    const text = extractAssistantText(payload);
    if (text === undefined) {
      return failure("other", "response carried no assistant text");
    }
    // Empty/whitespace text crosses the boundary as a success: empty_output
    // is adapter-generated (AC-2.4); hosts never return it.
    return { ok: true, text };
  };
}
