// The scripted-host builders (Epic 05 test plan §Fixture Contracts): fake
// ModelCall implementations every Flow 1–3 test uses. These are boundary
// doubles, not internal mocks — the ModelCall function is where LHC's code
// ends (tech design §Testing Strategy). All builders return
// contract-conformant shapes (AC-1.2); seam-conformance.ts asserts that of
// recordingCall in its own test so fixture drift is caught by the suite.
import { FORM_KINDS, type FormKind } from "../../src/shared/derivation.js";
import { DEFAULT_PROMPT_NAMES } from "../../src/inference/prompts/index.js";
import type {
  ModelAssignment,
  ModelCall,
  ModelCallInput,
  ModelCallResult,
} from "../../src/inference/types.js";

export { FORM_KINDS, type FormKind };

// validAssignments gives every kind a distinct fake provider/model lane;
// recordingCall infers the kind back from the model string, so per-kind
// routing is observable from the log alone (TC-1.2).
export const FAKE_PROVIDER_PREFIX = "prov-";
export const FAKE_MODEL_PREFIX = "model-";

export function validAssignments(
  overrides: Partial<Record<FormKind, Partial<ModelAssignment>>> = {},
): Record<FormKind, ModelAssignment> {
  const map = {} as Record<FormKind, ModelAssignment>;
  for (const kind of FORM_KINDS) {
    map[kind] = {
      provider: `${FAKE_PROVIDER_PREFIX}${kind}`,
      model: `${FAKE_MODEL_PREFIX}${kind}`,
      prompt: DEFAULT_PROMPT_NAMES[kind],
      ...(overrides[kind] ?? {}),
    };
  }
  return map;
}

// One distinct canned sentence per kind, so cross-kind bleed is visible in
// landed form content, never just in call counts.
export function cannedResponses(): Record<FormKind, string> {
  const map = {} as Record<FormKind, string>;
  for (const kind of FORM_KINDS) {
    map[kind] = `canned ${kind} text from the fake host`;
  }
  return map;
}

// Resolves each call with its kind's canned text — the kind inferred from
// the model routing key validAssignments made unique per kind. Every input
// is cloned into `log` in call order. An unknown model is a test bug and
// throws loudly.
export function recordingCall(responses: Record<FormKind, string>): {
  call: ModelCall;
  log: ModelCallInput[];
} {
  const log: ModelCallInput[] = [];
  const known = new Set<string>(FORM_KINDS);
  const call: ModelCall = (input) => {
    log.push(structuredClone(input));
    const kind = input.model.startsWith(FAKE_MODEL_PREFIX)
      ? input.model.slice(FAKE_MODEL_PREFIX.length)
      : input.model;
    if (!known.has(kind)) {
      throw new Error(`recordingCall: no canned response for model "${input.model}"`);
    }
    return Promise.resolve({ ok: true, text: responses[kind as FormKind] });
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
      throw new Error(
        `scriptedCall: script exhausted after ${String(script.length)} calls (model "${input.model}")`,
      );
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
