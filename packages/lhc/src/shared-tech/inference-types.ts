export type ModelCall = (input: ModelCallInput) => Promise<ModelCallResult>;

export interface ModelCallInput {
  provider: string;
  model: string;
  messages: { role: "system" | "user"; content: string }[];
  thinking?: ModelAssignment["thinking"];
}

export type ModelCallResult =
  | {
      ok: true;
      text: string;
      actualProvider?: string;
      actualModel?: string;
    }
  | { ok: false; kind: ModelCallFailureKind; message: string };

export type ModelCallFailureKind =
  | "rate_limit"
  | "timeout"
  | "network"
  | "empty_output"
  | "other"
  | "auth"
  | "invalid_request";

export interface ModelAssignment {
  provider: string;
  model: string;
  prompt: string;
  targetMinRatio?: number;
  targetMaxRatio?: number;
  targetAimRatio?: number;
  thinking?: "none" | "minimal" | "medium" | "high";
}

export interface DerivationGuards {
  smoothedPrompt?: {
    maxInferenceTokens?: number;
    suspiciousOutputRatio?: number;
  };
  toolResultSummary?: {
    timeoutMs?: number;
  };
  detailedTurnCompression?: {
    tinyTurnTokens?: number;
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
  detailedTurnCompression: {
    tinyTurnTokens: number;
  };
}

export interface InferenceConfig {
  call: ModelCall;
  assignments?: Record<string, ModelAssignment>;
  timeoutMs?: number;
  maxInputChars?: number;
}

export interface ResolvedInferenceConfig {
  call: ModelCall;
  assignments: Record<string, ModelAssignment>;
  guards: ResolvedDerivationGuards;
  timeoutMs: number;
  maxInputChars: number;
}

export const DEFAULT_GUARDS: ResolvedDerivationGuards = {
  smoothedPrompt: { maxInferenceTokens: 700, suspiciousOutputRatio: 0.15 },
  toolResultSummary: { timeoutMs: 60_000 },
  detailedTurnCompression: { tinyTurnTokens: 80 },
};

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
    detailedTurnCompression: {
      tinyTurnTokens:
        g.detailedTurnCompression?.tinyTurnTokens ?? DEFAULT_GUARDS.detailedTurnCompression.tinyTurnTokens,
    },
  };
}
