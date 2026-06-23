// Shared derivation vocabulary: state machine types, the inference callback
// boundary, and the handler contract. Both owning domains consume these;
// neither owns them. Repair reports, mutation cascade, and drain all speak this
// vocabulary across domain lines, so it lives in shared-tech.
import type { DatabaseSync } from "node:sqlite";
import type { DerivationGuards, InferenceConfig, ResolvedDerivationGuards } from "./inference-types.js";
import type { ResolvedViewConfig, SdkViewConfig } from "./view.js";

export type SubjectKind = "message" | "turn" | "chunk";

export type DerivationState = "pending" | "ready" | "failed" | "blocked";

// Outcome on tool-activity summaries — mechanically stamped from the record
// (isError/presence), never authored by model text.
export type ToolOutcome = "succeeded" | "failed" | "unknown";

// A composed derivation's record of a dependency that fell back during composition:
// names the source record and the derivation type that was not ready.
export interface DependencyGap {
  subjectKind: SubjectKind;
  subjectId: string;
  derivationType: string;
}

// The read shape for one derivation's state row.
export interface Derivation {
  subjectKind: SubjectKind;
  subjectId: string;
  derivationType: string;
  state: DerivationState;
  content?: string; // ready only
  reason?: string; // failed | blocked
  sourceVersion: number; // which version of the source this derivation derives from
  gaps?: DependencyGap[]; // composed derivations; landed-with-fallback record
  metadata?: DerivationMetadata; // mechanically stamped fields; never model-authored
  derivedAt?: string;
}

// One tool call's or result's receipt within a turn's composed account: the
// account text, as composed, plus the mechanically derived outcome. Derived
// from composition input, never from model prose; stamped on turn_rendering so
// chunk summaries can read receipts machine-readably in turn order.
export interface ToolRunReceipt {
  messageId: string;
  activity: "tool_call" | "tool_result";
  account: string;
  outcome: ToolOutcome;
}

// Mechanically stamped derivation metadata: tool outcomes, turn rendering's
// tool-run receipts, and retry-exhaustion attempts/last-error copied from the
// work item before its row is deleted. The queue is not an audit table; durable
// outcome detail lives here.
export interface DerivationMetadata {
  outcome?: ToolOutcome;
  receipts?: ToolRunReceipt[];
  attempts?: number;
  lastError?: string;
  discardReason?: string;
  sizeDisposition?: "in_range" | "under_min" | "over_max";
  // Which provider/model/prompt produced the content, copied from the
  // InferenceResult's config-known strings, never authored from model output.
  // Deterministic domain assembly never sets it.
  provenance?: ProviderProvenance;
}

// One row of an owner's repair report: the derivation's durable state joined
// with the queue's mechanical detail for the live item still working toward it,
// if any. The five operational situations read from this one row:
// never-attempted, retrying, ready, failed, blocked. No caller ever needs a
// queue API.
export interface DerivationReportEntry extends Derivation {
  queue?: {
    status: "queued" | "claimed";
    attempts: number;
    lastError?: string;
    eligibleAt?: string;
  };
}

// ── inference callback boundary ──────────────────────────────────
// Every operation returns content or a structured failure carrying
// retryable-or-not; classification is the adapter's duty.
// Provenance: the three config-known assignment strings, stamped by the
// inference adapter (it alone knows the assignment) and copied by handlers
// into derivation metadata. Never derived from model output.
export interface ProviderProvenance {
  provider: string;
  model: string;
  prompt: string;
}

export type InferenceResult =
  | { ok: true; text: string; provenance?: ProviderProvenance }
  | { ok: false; retryable: boolean; reason: string };

/** @deprecated Use InferenceResult. */
export type ProviderResult = InferenceResult;

// Message kinds a rendering part can carry — mirrors the intake event-kind
// vocabulary minus turn_end (turn_end never projects a message). Mirrored
// rather than imported: shared-tech/ may not import the domains.
export type RenderingPartKind =
  | "user_prompt"
  | "assistant_text"
  | "assistant_thinking"
  | "runtime_note"
  | "model_change"
  | "thinking_level_change"
  | "tool_call"
  | "tool_result";

export interface RenderingPart {
  messageId: string;
  kind: RenderingPartKind;
  text: string; // ready derivation content, or raw/truncated fallback
  fallback: boolean; // true ⇒ gap recorded
  blocks?: Array<{ blockType: string; content: Record<string, unknown> }>;
  outcome?: ToolOutcome; // tool activity only
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
  compressSmoothTurn(i: {
    rendering: string;
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

/** @deprecated Use InferenceCallbacks. */
export type DerivationProvider = InferenceCallbacks;

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
  "compressSmoothTurn",
  "summarizeChunkBrief",
] as const;

export type InferenceCallbackName = (typeof INFERENCE_CALLBACK_OPERATIONS)[number];

/** @deprecated Use INFERENCE_CALLBACK_OPERATIONS. */
export const PROVIDER_OPERATIONS = INFERENCE_CALLBACK_OPERATIONS;

/** @deprecated Use InferenceCallbackName. */
export type ProviderOperationName = InferenceCallbackName;

// ── LHC initialization config ────────────────────────────────────
// Inference callbacks arrive exactly one way: direct callback injection
// (`inferenceCallbacks`) or `inference` (host model-call function + per-kind
// assignments). `provider` remains only as a deprecated spelling for direct
// callbacks.
export interface SdkConfig {
  inferenceCallbacks?: InferenceCallbacks;
  /** @deprecated Use inferenceCallbacks. */
  provider?: InferenceCallbacks;
  inference?: InferenceConfig;
  mode: "background" | "manual";
  clock?: () => Date;
  retry?: { budget: number; backoffBaseMs: number; backoffCapMs: number }; // 3 / 5000 / 60000
  guards?: DerivationGuards;
  toolResult?: {
    smallTierTokens: number;
    smallTargetRatio: number;
    midTargetRatio: number;
  }; // 1000 / 0.15 / 0.04
  lease?: { durationMs: number }; // 120000
  chunkPolicy?: { targetProjectedTokens: number; maxProjectedTokens: number }; // 2200 / 4400
  view?: SdkViewConfig; // profiles, visibility budgets, compact threshold
}

// Every optional filled by initLhc's central defaults.
export interface ResolvedSdkConfig {
  inferenceCallbacks: InferenceCallbacks;
  /** @deprecated Use inferenceCallbacks. */
  provider: InferenceCallbacks;
  mode: "background" | "manual";
  clock: () => Date;
  retry: { budget: number; backoffBaseMs: number; backoffCapMs: number };
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
}

// ── handler contract ─────────────────────────────────────────────
export interface HandlerRunContext {
  threadId: string;
  filePath: string;
  openDb(): DatabaseSync; // short-txn access; NEVER held across inference calls
  inferenceCallbacks: InferenceCallbacks;
  clock: () => Date;
  config: ResolvedSdkConfig;
}

// A successful handler hands its derivation content back as data; the
// drain's completion transaction performs the version-checked UPDATE and the
// item-row deletion atomically. The handler never opens that transaction
// itself, so the version check and the done/stale_discarded disposition stay in
// one place: the queue util.
export interface HandlerDerivationWrite {
  subjectKind: SubjectKind;
  subjectId: string;
  derivationType: string;
  content: string;
  metadata?: DerivationMetadata;
  gaps?: DependencyGap[];
}

// Completion-transaction hook for work that must land atomically with
// version-checked derivation writes: chunk placement and close→summary enqueues
// above all. The queue util invokes it inside completion's BEGIN IMMEDIATE,
// after derivation writes and only when they hit. A stale completion must not
// place a turn or enqueue summaries. onCommit registrations flush after that
// COMMIT succeeds and drop on rollback, so a crash leaves either a placed turn
// with its enqueues or nothing, never a derived-but-unplaced turn.
export interface CompletionTx {
  db: DatabaseSync;
  onCommit: (fn: () => void) => void;
}

export type HandlerOutcome =
  | { ok: true; derivations?: HandlerDerivationWrite[]; onApplied?: (transaction: CompletionTx) => void }
  | { ok: false; deferred: true; reason: string; onDeferred: (transaction: CompletionTx) => void }
  | { ok: false; retryable: boolean; reason: string }
  | { ok: false; blocked: true; reason: string }; // source damage → derivation blocked, item terminal

// item is the queue util's WorkItemRecord; typed structurally here so the
// shared layer does not depend on the util's module (and vice versa stays
// one-directional: tech-utils imports shared).
export type WorkHandler = (
  run: HandlerRunContext,
  item: { workItemId: string; kind: string; sourceRef: Record<string, string> },
) => Promise<HandlerOutcome>;
