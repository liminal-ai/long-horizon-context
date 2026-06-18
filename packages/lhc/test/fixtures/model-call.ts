// The scripted-host builders (Epic 05 test plan §Fixture Contracts): fake
// ModelCall implementations every Flow 1–3 test uses. These are boundary
// doubles, not internal mocks — the ModelCall function is where LHC's code
// ends (tech design §Testing Strategy). All builders return
// contract-conformant shapes (AC-1.2); seam-conformance.ts asserts that of
// recordingCall in its own test so fixture drift is caught by the suite.

import type {
  ModelAssignment,
  ModelCall,
  ModelCallInput,
  ModelCallResult,
} from "../../src/shared-tech/inference-types.js";
import { DEFAULT_PROMPT_NAMES } from "../../src/shared-tech/prompts/index.js";

// The derivation-type vocabulary for fixtures. AC-0.3 removed the typed
// enumeration (DERIVATION_TYPES / DerivationType) from src — derivation types
// are plain string discriminators now — so fixtures keep a local list so
// per-kind routing stays observable. Only INFERENCE_DERIVATION_TYPES cross the
// host ModelCall boundary; DERIVATION_TYPES also names deterministic forms that
// the turns domain assembles locally.
export const DERIVATION_TYPES = [
  "smoothed_prompt",
  "tool_result_summary",
  "turn_rendering",
  "smooth_turn_compression",
  "chunk_summary_detailed",
  "chunk_summary_brief",
] as const;
export type DerivationType = (typeof DERIVATION_TYPES)[number];

export const INFERENCE_DERIVATION_TYPES = [
  "smoothed_prompt",
  "tool_result_summary",
  "smooth_turn_compression",
  "chunk_summary_brief",
] as const;
export type InferenceDerivationType = (typeof INFERENCE_DERIVATION_TYPES)[number];

// The prompt template a fixture assignment selects for a kind: the inference
// default when one exists, else the deterministic type's own template.
function fixturePrompt(kind: InferenceDerivationType): string {
  const inferenceDefault = DEFAULT_PROMPT_NAMES[kind];
  if (inferenceDefault !== undefined) return inferenceDefault;
  return "unknown-prompt";
}

// validAssignments gives every kind a distinct fake provider/model lane;
// recordingCall infers the kind back from the model string, so per-kind
// routing is observable from the log alone (TC-1.2).
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

// One distinct canned sentence per kind, so cross-kind bleed is visible in
// landed form content, never just in call counts.
export function cannedResponses(): Record<DerivationType, string> {
  const map = {} as Record<DerivationType, string>;
  for (const kind of DERIVATION_TYPES) {
    map[kind] = `canned ${kind} text from the fake host`;
  }
  return map;
}

// Resolves each call with its kind's canned text — the kind inferred from
// the model routing key validAssignments made unique per kind. Every input
// is cloned into `log` in call order. An unknown model is a test bug and
// throws loudly.
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

// Returns script entries in order; a call past the end of the script is a
// test bug and throws loudly.
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

// A host whose function throws — the AC-3.3 containment leg.
export function throwingCall(error: Error): ModelCall {
  return () => Promise.reject(error);
}

// A host that never settles — the DD-6 timeout leg (tests pass a small
// timeoutMs).
export function hangingCall(): ModelCall {
  return () => new Promise<ModelCallResult>(() => {});
}
