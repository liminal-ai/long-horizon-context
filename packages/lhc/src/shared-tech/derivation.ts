import type { DatabaseSync } from "node:sqlite";
import type { DerivationGuards, InferenceConfig, ResolvedDerivationGuards } from "./inference-types.js";
import type { FamiliesOverlay, TokenEstimator, TokenFamily } from "./token-counting/index.js";
import type { ResolvedViewConfig, SdkViewConfig } from "./view.js";

export type SubjectKind = "message" | "turn" | "chunk";

export type DerivationState = "pending" | "ready" | "failed" | "blocked";

export type ToolOutcome = "succeeded" | "failed" | "unknown";

export interface DependencyGap {
  subjectKind: SubjectKind;
  subjectId: string;
  derivationType: string;
}

export interface Derivation {
  subjectKind: SubjectKind;
  subjectId: string;
  derivationType: string;
  state: DerivationState;
  content?: string;
  reason?: string;
  sourceVersion: number;
  gaps?: DependencyGap[];
  metadata?: DerivationMetadata;
  derivedAt?: string;
}

export interface DerivationMetadata {
  outcome?: ToolOutcome;
  lastError?: string;
  discardReason?: string;
  fallbackFloor?: string;
  fallbackUsed?: boolean;
  inferenceAttempted?: boolean;
  inferenceSucceeded?: boolean;
  sizeDisposition?: "in_range" | "under_min" | "over_max";
  provenance?: ProviderProvenance;
}

export interface DerivationReportEntry extends Derivation {
  queue?: {
    status: "queued" | "claimed";
  };
}

export interface ProviderProvenance {
  provider: string;
  model: string;
  prompt: string;
}

export type InferenceRequestMessage = { role: "system" | "user"; content: string };

export type InferenceResult =
  | {
      ok: true;
      text: string;
      provenance?: ProviderProvenance;
      requestMessages?: InferenceRequestMessage[];
      rawResponse?: string;
    }
  | { ok: false; reason: string; requestMessages?: InferenceRequestMessage[] };

export type RenderingPartKind =
  | "user_prompt"
  | "assistant_text"
  | "assistant_thinking"
  | "runtime_note"
  | "model_change"
  | "thinking_level_change"
  | "tool_call"
  | "tool_result"
  | "compact_continuation_marker";

export interface RenderingPart {
  messageId: string;
  kind: RenderingPartKind;
  text: string;
  fallback: boolean;
  blocks?: Array<{ blockType: string; content: Record<string, unknown> }>;
  outcome?: ToolOutcome;
  memberMessageIds?: string[];
}

export interface InferenceCallbacks {
  smoothPrompt(i: { text: string }): Promise<InferenceResult>;
  summarizeToolResult(i: {
    toolName: string;
    content: string;
    outcome?: ToolOutcome;
    targetTokens?: number;
    operationClass?: ToolResultOperationClass;
    responseShape?: ToolResultResponseShape;
    promptMode?: ToolResultPromptMode;
    facts?: ToolResultFacts;
  }): Promise<InferenceResult>;
  compressDetailedTurn(i: {
    dialogueText: string;
    inputTokens: number;
    targetMinTokens: number;
    targetAimTokens: number;
    targetMaxTokens: number;
  }): Promise<InferenceResult>;
  summarizeChunkBrief(i: {
    text: string;
    inputTokens: number;
    targetMinTokens: number;
    targetAimTokens: number;
    targetMaxTokens: number;
  }): Promise<InferenceResult>;
}

export type ToolResultOperationClass =
  | "read"
  | "mutation_write"
  | "mutation_edit"
  | "command"
  | "search_or_listing"
  | "verification"
  | "vcs_inspection"
  | "filesystem_mutation"
  | "multi_tool"
  | "unknown";

export type ToolResultResponseShape =
  | "structured_receipt"
  | "simple_failure"
  | "no_output"
  | "search_result"
  | "test_result"
  | "file_content"
  | "large_file_content"
  | "diff_output"
  | "large_log"
  | "multi_tool_result"
  | "unknown_content";

export type ToolResultPromptMode =
  | "receipt"
  | "failure"
  | "no_output"
  | "search_summary"
  | "test_summary"
  | "content_summary"
  | "diff_summary"
  | "large_log"
  | "multi_tool_summary"
  | "generic_summary";

export type ToolResultFacts = Record<string, unknown>;

export interface ToolResultClassification {
  operationClass: ToolResultOperationClass;
  responseShape: ToolResultResponseShape;
  promptMode: ToolResultPromptMode;
  facts: ToolResultFacts;
}

export const INFERENCE_CALLBACK_OPERATIONS = [
  "smoothPrompt",
  "summarizeToolResult",
  "compressDetailedTurn",
  "summarizeChunkBrief",
] as const;

export type InferenceCallbackName = (typeof INFERENCE_CALLBACK_OPERATIONS)[number];

export interface SdkConfig {
  inferenceCallbacks?: InferenceCallbacks;
  inference?: InferenceConfig;
  mode: "background" | "manual";
  clock?: () => Date;
  guards?: DerivationGuards;
  toolResult?: {
    smallTierTokens: number;
    smallTargetRatio: number;
    midTargetRatio: number;
  };
  lease?: { durationMs: number };
  chunkPolicy?: { targetProjectedTokens: number; maxProjectedTokens: number };
  view?: SdkViewConfig;
  tokenFamily: TokenFamily;
  tokenFamilies?: FamiliesOverlay;
}

export interface ResolvedSdkConfig {
  inferenceCallbacks: InferenceCallbacks;
  mode: "background" | "manual";
  clock: () => Date;
  guards: ResolvedDerivationGuards;
  compressionTargets: {
    minRatio: number;
    aimRatio: number;
    maxRatio: number;
  };
  briefTargets: {
    minRatio: number;
    aimRatio: number;
    maxRatio: number;
  };
  toolResult: {
    smallTierTokens: number;
    smallTargetRatio: number;
    midTargetRatio: number;
  };
  lease: { durationMs: number };
  chunkPolicy: { targetProjectedTokens: number; maxProjectedTokens: number };
  view: ResolvedViewConfig;
  tokenFamily: TokenFamily;
  tokenEstimator: TokenEstimator;
}

export interface HandlerRunContext {
  threadId: string;
  filePath: string;
  openDb(): DatabaseSync;
  inferenceCallbacks: InferenceCallbacks;
  clock: () => Date;
  config: ResolvedSdkConfig;
}

export interface HandlerDerivationWrite {
  subjectKind: SubjectKind;
  subjectId: string;
  derivationType: string;
  content: string;
  metadata?: DerivationMetadata;
  gaps?: DependencyGap[];
}

export interface CompletionTx {
  db: DatabaseSync;
  onCommit: (fn: () => void) => void;
}

export type HandlerOutcome =
  | { ok: true; derivations?: HandlerDerivationWrite[]; onApplied?: (transaction: CompletionTx) => void }
  | { ok: false; deferred: true; reason: string; onDeferred: (transaction: CompletionTx) => void }
  | { ok: false; reason: string }
  | { ok: false; blocked: true; reason: string };

export type WorkHandler = (
  run: HandlerRunContext,
  item: { workItemId: string; kind: string; sourceRef: Record<string, string> },
) => Promise<HandlerOutcome>;
