// Inference boundary vocabulary: the one function a host supplies, its
// structured result shapes, and the config that arrives at initLhc as the
// alternative to direct inference callback injection. LHC treats provider/model
// strings as host routing keys; the host's ModelCall implementation is the only
// code that interprets them.

/** The one function a host supplies. Single-turn completion; provider/model
 *  are host routing keys the host's implementation interprets. */
export type ModelCall = (input: ModelCallInput) => Promise<ModelCallResult>;

export interface ModelCallInput {
  provider: string;
  model: string;
  messages: { role: "system" | "user"; content: string }[];
  thinking?: ModelAssignment["thinking"];
}

export type ModelCallResult = { ok: true; text: string } | { ok: false; kind: ModelCallFailureKind; message: string };

/** `empty_output` is adapter-generated; hosts never return it.
 *  Thrown exceptions classify as `other`. */
export type ModelCallFailureKind =
  | "rate_limit"
  | "timeout"
  | "network"
  | "empty_output"
  | "other"
  | "auth"
  | "invalid_request";

// ModelAssignment includes target ranges for compression types.
export interface ModelAssignment {
  provider: string;
  model: string;
  prompt: string; // must name a PROMPT_REGISTRY entry
  // Optional target range for compression derivations.
  targetMinRatio?: number;
  targetMaxRatio?: number;
  targetAimRatio?: number;
  thinking?: "none" | "minimal" | "medium" | "high"; // optional thinking level
}

// DerivationGuards config for operational limits.
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

/** SdkConfig.inference: the alternative to SdkConfig.inferenceCallbacks. */
export interface InferenceConfig {
  call: ModelCall;
  // Partial by design: inference derivation types the host omits are filled
  // from DEFAULT_INFERENCE_ASSIGNMENTS; deterministic types are optional.
  // Unknown keys are rejected at construction.
  assignments?: Record<string, ModelAssignment>;
  timeoutMs?: number; // default 60_000
  maxInputChars?: number; // default 200_000
}

/** InferenceConfig after initLhc validation: every optional filled. */
export interface ResolvedInferenceConfig {
  call: ModelCall;
  assignments: Record<string, ModelAssignment>;
  guards: ResolvedDerivationGuards;
  timeoutMs: number;
  maxInputChars: number;
}

// Default guard values: documented operational limits applied when the host
// omits a guard. Centralized so construction and tests share one source of
// truth for the defaults.
export const DEFAULT_GUARDS: ResolvedDerivationGuards = {
  smoothedPrompt: { maxInferenceTokens: 700, suspiciousOutputRatio: 0.15 },
  toolResultSummary: { timeoutMs: 60_000 },
  smoothTurnCompression: { tinyTurnTokens: 80 },
};

// Fill a DerivationGuards with defaults for every omitted value. A pure
// function: no defaults drift between construction and the values tests pin.
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
