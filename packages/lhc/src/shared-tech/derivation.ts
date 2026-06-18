// Epic 02 shared vocabulary: the derivation state machine's types, the
// inference callback seam, and the handler contract. Both owning domains
// (messages, turns) consume these; neither owns them — the repair report, the
// mutation cascade, and the drain all speak this vocabulary across domain
// lines, so it lives in shared-tech/ (tech design §Interfaces, DD-2/DD-7).
import type { DatabaseSync } from "node:sqlite";
import type { InferenceConfig } from "./inference-types.js";
import type { ResolvedViewConfig, SdkViewConfig } from "./view.js";

export type SubjectKind = "message" | "turn" | "chunk";

export type DerivationState = "pending" | "ready" | "failed" | "blocked";

// Outcome on tool-activity summaries — mechanically stamped from the record
// (isError/presence), never authored by model text (AC-2.4).
export type ToolOutcome = "succeeded" | "failed" | "unknown";

// A composed derivation's record of a dependency that fell back during composition:
// names the source record and the derivation type that was not ready (AC-3.2/3.3).
export interface DependencyGap {
  subjectKind: SubjectKind;
  subjectId: string;
  derivationType: string;
}

// The read shape for one derivation's state row (DD-2, DD-3).
export interface Derivation {
  subjectKind: SubjectKind;
  subjectId: string;
  derivationType: string;
  state: DerivationState;
  content?: string; // ready only
  reason?: string; // failed | blocked
  sourceVersion: number; // which version of the source this derivation derives from (DD-3)
  gaps?: DependencyGap[]; // composed derivations; landed-with-fallback record
  metadata?: DerivationMetadata; // mechanically stamped fields; never model-authored
  derivedAt?: string;
}

// One tool call's or result's receipt within a turn's composed account
// (AC-3.8): the account text — what changed, as composed — plus the
// mechanically derived outcome. Derived from the composition input, never
// from model prose; stamped on the turn_rendering form so the chunk
// summaries can read receipts machine-readably in turn order.
export interface ToolRunReceipt {
  messageId: string;
  activity: "tool_call" | "tool_result";
  account: string;
  outcome: ToolOutcome;
}

// Mechanically stamped derivation metadata: tool outcomes (AC-2.4), the turn
// rendering's tool-run receipts (AC-3.8), plus — at retry exhaustion — the
// final attempts/last-error copied from the work item before its row is
// deleted (DD-1: the queue is not an audit table; durable outcome detail
// lives here).
export interface DerivationMetadata {
  outcome?: ToolOutcome;
  receipts?: ToolRunReceipt[];
  attempts?: number;
  lastError?: string;
  // Epic 05 (DD-4): which provider/model/prompt produced the content —
  // copied from the InferenceResult's config-known strings, never authored
  // from model output. Deterministic domain assembly never sets it.
  provenance?: ProviderProvenance;
}

// One row of an owner's repair report (Flow 4): the derivation's durable state
// joined with the queue's mechanical detail for the live item still working
// toward it, if any. The five operational situations read from this one row:
// never-attempted (pending, no queue), retrying (pending + queue with
// attempts > 0), ready, failed (+ reason), blocked (+ reason) — no caller
// ever needs a queue API.
export interface DerivationReportEntry extends Derivation {
  queue?: {
    status: "queued" | "claimed";
    attempts: number;
    lastError?: string;
    eligibleAt?: string;
  };
}

// ── inference callback seam (DD-7) ───────────────────────────────
// Every operation returns content or a structured failure carrying
// retryable-or-not; classification is the adapter's duty.
// Provenance: the three config-known assignment strings, stamped by the
// inference adapter (it alone knows the assignment) and copied by handlers
// into derivation metadata (Epic 05 DD-4). Never derived from model output.
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
    guidance?: string;
  }): Promise<InferenceResult>;
  composeTurnRendering(i: { parts: RenderingPart[] }): Promise<InferenceResult>;
  compressSmoothTurn(i: { rendering: string }): Promise<InferenceResult>;
  // The two summary inputs differ by contract (AC-3.8): detailed receives
  // the members' tool-run receipts (what changed, outcome) alongside the
  // projections; brief receives outcomes only — receipt text is stripped
  // before the provider is called, so brief structurally cannot leak it.
  // The receipt fields are optional in the type for callers without member
  // context (the production chunk handlers always pass them).
  summarizeChunkDetailed(i: {
    memberProjections: string[];
    memberReceipts?: ToolRunReceipt[][];
  }): Promise<InferenceResult>;
  summarizeChunkBrief(i: {
    memberProjections: string[];
    memberOutcomes?: ToolOutcome[][];
  }): Promise<InferenceResult>;
}

/** @deprecated Use InferenceCallbacks. */
export type DerivationProvider = InferenceCallbacks;

export const INFERENCE_CALLBACK_OPERATIONS = [
  "smoothPrompt",
  "summarizeToolResult",
  "composeTurnRendering",
  "compressSmoothTurn",
  "summarizeChunkDetailed",
  "summarizeChunkBrief",
] as const;

export type InferenceCallbackName = (typeof INFERENCE_CALLBACK_OPERATIONS)[number];

/** @deprecated Use INFERENCE_CALLBACK_OPERATIONS. */
export const PROVIDER_OPERATIONS = INFERENCE_CALLBACK_OPERATIONS;

/** @deprecated Use InferenceCallbackName. */
export type ProviderOperationName = InferenceCallbackName;

// ── SDK assembly config (tech design §Interfaces) ────────────────
// Provider arrival is exactly one of `provider` (direct injection,
// unchanged — the deterministic test default) or `inference` (host
// model-call function + per-kind assignments, Epic 05 DD-5). Both or
// neither is a construction TypeError naming the XOR rule (AC-1.1).
export interface SdkConfig {
  provider?: InferenceCallbacks;
  inference?: InferenceConfig;
  mode: "background" | "manual";
  clock?: () => Date;
  retry?: { budget: number; backoffBaseMs: number; backoffCapMs: number }; // 3 / 5000 / 60000
  smoothing?: { maxInferenceTokens: number }; // 4000
  toolResult?: {
    smallTierTokens: number;
    largeTierTokens: number;
    smallTargetRatio: number;
    midTargetRatio: number;
  }; // 1000 / 5000 / 0.15 / 0.04
  lease?: { durationMs: number }; // 120000
  chunkPolicy?: { targetProjectedTokens: number; maxProjectedTokens: number }; // 2200 / 4400
  view?: SdkViewConfig; // Epic 03: profiles, visibility budgets, compact threshold
}

// Every optional filled by createSdk's central defaults.
export interface ResolvedSdkConfig {
  provider: InferenceCallbacks;
  mode: "background" | "manual";
  clock: () => Date;
  retry: { budget: number; backoffBaseMs: number; backoffCapMs: number };
  smoothing: { maxInferenceTokens: number };
  toolResult: {
    smallTierTokens: number;
    largeTierTokens: number;
    smallTargetRatio: number;
    midTargetRatio: number;
  };
  lease: { durationMs: number };
  chunkPolicy: { targetProjectedTokens: number; maxProjectedTokens: number };
  view: ResolvedViewConfig;
}

// ── handler contract (DD-6; the map's value type) ────────────────
export interface HandlerRunContext {
  openDb(): DatabaseSync; // short-txn access; NEVER held across provider calls
  provider: InferenceCallbacks;
  clock: () => Date;
  config: ResolvedSdkConfig;
}

// A successful handler hands its derivation content back as data; the
// drain's completion transaction performs the version-checked UPDATE and the
// item-row deletion atomically (tech design §Mechanics: completion is one
// short BEGIN IMMEDIATE doing the derivation write and the delete). The handler
// never opens that transaction itself, so the version check and the
// done/stale_discarded disposition stay in one place — the queue util.
export interface HandlerDerivationWrite {
  subjectKind: SubjectKind;
  subjectId: string;
  derivationType: string;
  content: string;
  metadata?: DerivationMetadata;
  gaps?: DependencyGap[];
}

// The completion-transaction hook (Story 3): work that must land atomically
// with the version-checked derivation writes — chunk placement and the
// close→summary enqueues above all. The queue util invokes it inside the
// completion's BEGIN IMMEDIATE, after the derivation writes and only when they hit
// (a stale completion must not place a turn or enqueue summaries); onCommit
// registrations flush after that COMMIT succeeds and drop on rollback, so a
// crash leaves either a placed turn with its enqueues or nothing — never a
// derived-but-unplaced turn.
export interface CompletionTx {
  db: DatabaseSync;
  onCommit: (fn: () => void) => void;
}

export type HandlerOutcome =
  | { ok: true; derivations?: HandlerDerivationWrite[]; onApplied?: (tx: CompletionTx) => void }
  | { ok: false; retryable: boolean; reason: string }
  | { ok: false; blocked: true; reason: string }; // source damage → derivation blocked, item terminal

// item is the queue util's WorkItemRecord; typed structurally here so the
// shared layer does not depend on the util's module (and vice versa stays
// one-directional: tech-utils imports shared).
export type WorkHandler = (
  run: HandlerRunContext,
  item: { workItemId: string; kind: string; sourceRef: Record<string, string> },
) => Promise<HandlerOutcome>;
