// Epic 05 boundary vocabulary (tech design §Interface Definitions): the one
// function a host supplies, its structured result shapes, and the config that
// arrives at initLhc as the alternative to direct inference callback injection
// (DD-1, DD-5). LHC treats provider/model strings as opaque routing keys —
// the host's ModelCall implementation is the only code that interprets them.

/** The one function a host supplies. Single-turn completion; provider/model
 *  are opaque routing keys the host's implementation interprets. (AC-1.2) */
export type ModelCall = (input: ModelCallInput) => Promise<ModelCallResult>;

export interface ModelCallInput {
  provider: string;
  model: string;
  messages: { role: "system" | "user"; content: string }[];
}

export type ModelCallResult = { ok: true; text: string } | { ok: false; kind: ModelCallFailureKind; message: string };

/** `empty_output` is adapter-generated (AC-2.4); hosts never return it.
 *  Thrown exceptions classify as `other` (AC-3.3). */
export type ModelCallFailureKind =
  | "rate_limit"
  | "timeout"
  | "network"
  | "empty_output"
  | "other"
  | "auth"
  | "invalid_request";

// ModelAssignment extended with target ranges for compression types (AC-6.1)
export interface ModelAssignment {
  provider: string;
  model: string;
  prompt: string; // must name a PROMPT_REGISTRY entry (AC-1.3)
  // Optional target range for compression derivations (AC-6.1)
  targetMinRatio?: number;
  targetMaxRatio?: number;
  targetAimRatio?: number;
  thinking?: "none" | "minimal" | "medium" | "high"; // optional thinking level
}

// DerivationGuards config for operational limits (AC-6.2)
export interface DerivationGuards {
  smoothedPrompt?: {
    maxInferenceTokens?: number; // default 700
    suspiciousOutputRatio?: number; // default 0.15
  };
  toolResultSummary?: {
    timeoutMs?: number; // default 60_000
  };
  smoothTurnCompression?: {
    tinyTurnTokens?: number; // default 80
  };
}

export interface ResolvedDerivationGuards {
  smoothedPrompt: {
    maxInferenceTokens: number;
    suspiciousOutputRatio: number;
  };
  toolResultSummary: {
    timeoutMs: number;
  };
  smoothTurnCompression: {
    tinyTurnTokens: number;
  };
}

/** SdkConfig.inference — the alternative to SdkConfig.inferenceCallbacks (DD-5). */
export interface InferenceConfig {
  call: ModelCall;
  // Partial by design (AC-0.3, AC-6.2, AC-6.3): inference derivation types the
  // host omits are filled from DEFAULT_INFERENCE_ASSIGNMENTS; deterministic
  // types are optional. Unknown keys are rejected at construction.
  assignments?: Record<string, ModelAssignment>;
  timeoutMs?: number; // default 60_000 (DD-6)
  maxInputChars?: number; // default 200_000 (DD-7)
}

/** InferenceConfig after initLhc validation: every optional filled. */
export interface ResolvedInferenceConfig {
  call: ModelCall;
  assignments: Record<string, ModelAssignment>;
  guards: ResolvedDerivationGuards;
  timeoutMs: number;
  maxInputChars: number;
}

// Default guard values (AC-6.2, TC-6.2a): the documented operational limits
// applied when the host omits a guard. Centralized so construction and tests
// share one source of truth for the defaults.
export const DEFAULT_GUARDS: ResolvedDerivationGuards = {
  smoothedPrompt: { maxInferenceTokens: 700, suspiciousOutputRatio: 0.15 },
  toolResultSummary: { timeoutMs: 60_000 },
  smoothTurnCompression: { tinyTurnTokens: 80 },
};

// Fill a DerivationGuards with defaults for every omitted value (AC-6.2). A
// pure function: no defaults drift between construction and the values tests
// pin (TC-6.2a).
export function resolveGuards(guards?: DerivationGuards): ResolvedDerivationGuards {
  const g = guards ?? {};
  return {
    smoothedPrompt: {
      maxInferenceTokens: g.smoothedPrompt?.maxInferenceTokens ?? DEFAULT_GUARDS.smoothedPrompt.maxInferenceTokens,
      suspiciousOutputRatio:
        g.smoothedPrompt?.suspiciousOutputRatio ?? DEFAULT_GUARDS.smoothedPrompt.suspiciousOutputRatio,
    },
    toolResultSummary: {
      timeoutMs: g.toolResultSummary?.timeoutMs ?? DEFAULT_GUARDS.toolResultSummary.timeoutMs,
    },
    smoothTurnCompression: {
      tinyTurnTokens: g.smoothTurnCompression?.tinyTurnTokens ?? DEFAULT_GUARDS.smoothTurnCompression.tinyTurnTokens,
    },
  };
}
