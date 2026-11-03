import { randomUUID } from "node:crypto";
import {
  claudeCliInferenceAssignments,
  type ModelAssignment,
  type ModelCall,
  type ModelCallFailureKind,
  type ModelCallInput,
  type ModelCallResult,
  summaryWorkerRequest,
} from "lhc";
import type { BridgeOutcome, BridgeRequest, BridgeResult } from "../../src/inference.ts";

export const BRIDGE_PROVIDER = "cc-lhc-mod-bridge";
export const BRIDGE_CONCURRENCY = 3;
// $.model.complete counts thinking in the cap, so leave room past the longest derivation.
const MAX_TOKENS = 32_000;

type Call = { request: BridgeRequest; settle: (result: ModelCallResult) => void; queuedAt: number; isClaimed: boolean };

export type Bridge = {
  call: ModelCall;
  claim: () => BridgeRequest[];
  answer: (result: BridgeResult) => void;
};

const API_ERRORS: Readonly<Record<string, ModelCallFailureKind>> = {
  rate_limit: "rate_limit",
  overloaded: "rate_limit",
  authentication_failed: "auth",
  invalid_request: "invalid_request",
};

function effortOf(thinking: ModelCallInput["thinking"]): BridgeRequest["effort"] {
  if (thinking === undefined) return undefined;
  return thinking === "none" || thinking === "minimal" ? "low" : thinking;
}

function resultOf(outcome: Exclude<BridgeOutcome, { reason: "aborted" }>): ModelCallResult {
  if (outcome.isAnswered) return { ok: true, text: outcome.text };
  if (outcome.reason === "empty-reply") return { ok: false, kind: "empty_output", message: "the model replied with no text" };
  const kind = API_ERRORS[outcome.error] ?? (outcome.status === null ? "network" : "other");
  return { ok: false, kind, message: `api-error ${outcome.status ?? "no response"} ${outcome.error}` };
}

export function laneAssignments(provider: string): Record<string, ModelAssignment> {
  return Object.fromEntries(
    Object.entries(claudeCliInferenceAssignments()).map(([kind, assignment]) => [kind, { ...assignment, provider }]),
  );
}

export function createBridge(coreTimeoutMs: number, log: (line: string) => void): Bridge {
  const calls = new Map<string, Call>();
  return {
    call: (input) => {
      if (input.provider !== BRIDGE_PROVIDER) {
        return Promise.resolve({ ok: false, kind: "invalid_request", message: `unsupported inference provider "${input.provider}"` });
      }
      const { systemPrompt, user } = summaryWorkerRequest(input.messages);
      const effort = effortOf(input.thinking);
      const id = randomUUID();
      const request: BridgeRequest = {
        id,
        model: input.model,
        system: systemPrompt,
        prompt: user,
        maxTokens: MAX_TOKENS,
        ...(effort === undefined ? {} : { effort }),
      };
      return new Promise((settle) => calls.set(id, { request, settle, queuedAt: Date.now(), isClaimed: false }));
    },
    claim: () => {
      const now = Date.now();
      for (const [id, call] of calls) if (now - call.queuedAt > coreTimeoutMs) calls.delete(id);
      const waiting = [...calls.values()];
      const free = BRIDGE_CONCURRENCY - waiting.filter((call) => call.isClaimed).length;
      const claimed = waiting.filter((call) => !call.isClaimed).slice(0, Math.max(0, free));
      for (const call of claimed) call.isClaimed = true;
      return claimed.map((call) => call.request);
    },
    answer: ({ id, outcome }) => {
      const call = calls.get(id);
      if (call === undefined) return;
      if (!outcome.isAnswered && outcome.reason === "aborted") {
        call.isClaimed = false;
        log(`bridge ${id} aborted, back in the queue`);
        return;
      }
      calls.delete(id);
      const result = resultOf(outcome);
      log(`bridge ${id} ${result.ok ? `answered ${result.text.length} chars` : `failed ${result.kind}: ${result.message}`}`);
      call.settle(result);
    },
  };
}
