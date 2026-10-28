import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelCall, ModelCallFailureKind, ModelCallResult } from "../../src/shared-tech/inference-types.js";

export const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export const DEFAULT_OPENROUTER_MODEL = "openai/gpt-5.4-mini";

export type RealSuiteEnv = { key: string; model: string } | { notRan: string };

export function loadLocalLhcEnv(): Record<string, string> {
  const path = join(homedir(), ".lhc", ".env");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  const env: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return env;
}

export function resolveRealSuiteEnv(env: Record<string, string | undefined>): RealSuiteEnv {
  const key = env["OPENROUTER_API_KEY"];
  if (key === undefined || key.trim() === "") {
    return { notRan: "OPENROUTER_API_KEY unset" };
  }
  const model = env["OPENROUTER_MODEL"];
  return {
    key,
    model: model !== undefined && model.trim() !== "" ? model : DEFAULT_OPENROUTER_MODEL,
  };
}

const emissions: string[] = [];

export function emitRealSuiteAccounting(env: RealSuiteEnv): string {
  const line = "notRan" in env ? `NOT-RAN: real-inference (${env.notRan})` : `RAN: real-inference (model ${env.model})`;
  emissions.push(line);
  process.stdout.write(`${line}\n`);
  return line;
}

export function realSuiteAccountingEmissions(): readonly string[] {
  return emissions;
}

function failureKindForStatus(status: number): ModelCallFailureKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status === 400) return "invalid_request";
  return "other";
}

function failure(kind: ModelCallFailureKind, message: string): ModelCallResult {
  return { ok: false, kind, message };
}

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
      return failure(failureKindForStatus(response.status), `HTTP ${String(response.status)}: ${body.slice(0, 200)}`);
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
    return { ok: true, text };
  };
}
