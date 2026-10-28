import type {
  ModelAssignment,
  ModelCall,
  ModelCallInput,
  ModelCallResult,
} from "../../src/shared-tech/inference-types.js";
import { DEFAULT_PROMPT_NAMES } from "../../src/shared-tech/prompts/index.js";

export const DERIVATION_TYPES = [
  "smoothed_prompt",
  "tool_result_summary",
  "turn_rendering",
  "pre_detailed_assembly",
  "detailed_turn_compression",
  "chunk_summary_detailed",
  "chunk_summary_brief",
] as const;
export type DerivationType = (typeof DERIVATION_TYPES)[number];

export const INFERENCE_DERIVATION_TYPES = [
  "smoothed_prompt",
  "tool_result_summary",
  "detailed_turn_compression",
  "chunk_summary_brief",
] as const;
export type InferenceDerivationType = (typeof INFERENCE_DERIVATION_TYPES)[number];

function fixturePrompt(kind: InferenceDerivationType): string {
  const inferenceDefault = DEFAULT_PROMPT_NAMES[kind];
  if (inferenceDefault !== undefined) return inferenceDefault;
  return "unknown-prompt";
}

export const FAKE_PROVIDER_PREFIX = "prov-";
export const FAKE_MODEL_PREFIX = "model-";

export function validAssignments(
  overrides: Partial<Record<InferenceDerivationType, Partial<ModelAssignment>>> = {},
): Record<InferenceDerivationType, ModelAssignment> {
  const map = {} as Record<InferenceDerivationType, ModelAssignment>;
  for (const kind of INFERENCE_DERIVATION_TYPES) {
    map[kind] = {
      provider: `${FAKE_PROVIDER_PREFIX}${kind}`,
      model: `${FAKE_MODEL_PREFIX}${kind}`,
      prompt: fixturePrompt(kind),
      ...(overrides[kind] ?? {}),
    };
  }
  return map;
}

export function cannedResponses(): Record<DerivationType, string> {
  const map = {} as Record<DerivationType, string>;
  for (const kind of DERIVATION_TYPES) {
    map[kind] = `canned ${kind} text from the fake host`;
  }
  return map;
}

export function recordingCall(responses: Record<DerivationType, string>): {
  call: ModelCall;
  log: ModelCallInput[];
} {
  const log: ModelCallInput[] = [];
  const known = new Set<string>(INFERENCE_DERIVATION_TYPES);
  const call: ModelCall = (input) => {
    log.push(structuredClone(input));
    const kind = input.model.startsWith(FAKE_MODEL_PREFIX) ? input.model.slice(FAKE_MODEL_PREFIX.length) : input.model;
    if (!known.has(kind)) {
      throw new Error(`recordingCall: no canned response for model "${input.model}"`);
    }
    return Promise.resolve({ ok: true, text: responses[kind as DerivationType] });
  };
  return { call, log };
}

export function scriptedCall(script: ModelCallResult[]): ModelCall {
  let next = 0;
  return (input) => {
    const entry = script[next];
    next += 1;
    if (entry === undefined) {
      throw new Error(`scriptedCall: script exhausted after ${String(script.length)} calls (model "${input.model}")`);
    }
    return Promise.resolve(entry);
  };
}

export function throwingCall(error: Error): ModelCall {
  return () => Promise.reject(error);
}

export function hangingCall(): ModelCall {
  return () => new Promise<ModelCallResult>(() => {});
}
