// Epic 02 shared vocabulary: the derived-form state machine's types, the
// provider seam, and the handler contract. Both owning domains (messages,
// turns) consume these; neither owns them — the repair report, the mutation
// cascade, and the drain all speak this vocabulary across domain lines, so it
// lives in shared/ (tech design §Interfaces, DD-2/DD-7).
import type { DatabaseSync } from "node:sqlite";
// Type-only and erased at build: the runtime graph stays one-directional
// (inference/ imports shared/, never the reverse).
import type { InferenceConfig } from "../inference/types.js";
import type { ResolvedViewConfig, SdkViewConfig } from "./view.js";

export type SubjectKind = "message" | "turn" | "chunk";

// The kind set is a runtime constant with the type derived from it, so code
// that must cover every kind — assignment validation above all (Epic 05
// AC-1.3) — iterates the exported set instead of maintaining a second
// literal list that can drift.
export const FORM_KINDS = [
  "smoothed_prompt",
  "tool_call_summary",
  "tool_result_summary",
  "turn_rendering",
  "lower_band_projection",
  "chunk_summary_detailed",
  "chunk_summary_brief",
] as const;

export type FormKind = (typeof FORM_KINDS)[number];

export type DerivedFormState = "pending" | "ready" | "failed" | "blocked";

// Outcome on tool-activity summaries — mechanically stamped from the record
// (isError/presence), never authored by the provider (AC-2.4).
export type ToolOutcome = "succeeded" | "failed" | "unknown";

// A composed form's record of a dependency that fell back during composition:
// names the source record and the form that was not ready (AC-3.2/3.3).
export interface DependencyGap {
  subjectKind: SubjectKind;
  subjectId: string;
  form: FormKind;
}

// The read shape for one derived form's state row (DD-2, DD-3).
export interface DerivedForm {
  subjectKind: SubjectKind;
  subjectId: string;
  form: FormKind;
  state: DerivedFormState;
  content?: string; // ready only
  reason?: string; // failed | blocked
  sourceVersion: number; // which version of the source this form derives from (DD-3)
  gaps?: DependencyGap[]; // composed forms; landed-with-fallback record
  metadata?: DerivedFormMetadata; // mechanically stamped fields; never provider-authored
  derivedAt?: string;
}

// One tool call's or result's receipt within a turn's composed account
// (AC-3.8): the account text — what changed, as composed — plus the
// mechanically derived outcome. Derived from the composition input, never
// from provider prose; stamped on the turn_rendering form so the chunk
// summaries can read receipts machine-readably in turn order.
export interface ToolRunReceipt {
  messageId: string;
  activity: "tool_call" | "tool_result";
  account: string;
  outcome: ToolOutcome;
}

// Mechanically stamped form metadata: tool outcomes (AC-2.4), the turn
// rendering's tool-run receipts (AC-3.8), plus — at retry exhaustion — the
// final attempts/last-error copied from the work item before its row is
// deleted (DD-1: the queue is not an audit table; durable outcome detail
// lives here).
export interface DerivedFormMetadata {
  outcome?: ToolOutcome;
  receipts?: ToolRunReceipt[];
  attempts?: number;
  lastError?: string;
  // Epic 05 (DD-4): which provider/model/prompt produced the content —
  // copied from the ProviderResult's config-known strings, never authored
  // from model output. The deterministic provider never sets it.
  provenance?: ProviderProvenance;
}

// One row of an owner's repair report (Flow 4): the form's durable state
// joined with the queue's mechanical detail for the live item still working
// toward it, if any. The five operational situations read from this one row:
// never-attempted (pending, no queue), retrying (pending + queue with
// attempts > 0), ready, failed (+ reason), blocked (+ reason) — no caller
// ever needs a queue API.
export interface FormReportEntry extends DerivedForm {
  queue?: {
    status: "queued" | "claimed";
    attempts: number;
    lastError?: string;
    eligibleAt?: string;
  };
}

// ── provider seam (DD-7) ─────────────────────────────────────────
// Every operation returns content or a structured failure carrying
// retryable-or-not; classification is the adapter's duty.
// Provenance: the three config-known assignment strings, stamped by the
// inference adapter (it alone knows the assignment) and copied by handlers
// into form metadata (Epic 05 DD-4). Never derived from model output.
export interface ProviderProvenance {
  provider: string;
  model: string;
  prompt: string;
}

export type ProviderResult =
  | { ok: true; text: string; provenance?: ProviderProvenance }
  | { ok: false; retryable: boolean; reason: string };

// Message kinds a rendering part can carry — mirrors the intake event-kind
// vocabulary minus turn_end (turn_end never projects a message). Mirrored
// rather than imported: shared/ may not import domains/.
export type RenderingPartKind =
  | "user_prompt"
  | "assistant_text"
  | "assistant_thinking"
  | "runtime_note"
  | "tool_call"
  | "tool_result";

export interface RenderingPart {
  messageId: string;
  kind: RenderingPartKind;
  text: string; // ready form content, or raw/truncated fallback
  fallback: boolean; // true ⇒ gap recorded
  outcome?: ToolOutcome; // tool activity only
}

export interface DerivationProvider {
  smoothPrompt(i: { text: string }): Promise<ProviderResult>;
  summarizeToolCall(i: {
    toolName: string;
    argsJson: string;
    pairedResult?: { content: string; isError: boolean };
  }): Promise<ProviderResult>;
  summarizeToolResult(i: { toolName: string; content: string }): Promise<ProviderResult>;
  composeTurnRendering(i: { parts: RenderingPart[] }): Promise<ProviderResult>;
  projectLowerBand(i: { rendering: string }): Promise<ProviderResult>;
  // The two summary inputs differ by contract (AC-3.8): detailed receives
  // the members' tool-run receipts (what changed, outcome) alongside the
  // projections; brief receives outcomes only — receipt text is stripped
  // before the provider is called, so brief structurally cannot leak it.
  // The receipt fields are optional in the type for callers without member
  // context (the production chunk handlers always pass them).
  summarizeChunkDetailed(i: {
    memberProjections: string[];
    memberReceipts?: ToolRunReceipt[][];
  }): Promise<ProviderResult>;
  summarizeChunkBrief(i: {
    memberProjections: string[];
    memberOutcomes?: ToolOutcome[][];
  }): Promise<ProviderResult>;
}

export const PROVIDER_OPERATIONS = [
  "smoothPrompt",
  "summarizeToolCall",
  "summarizeToolResult",
  "composeTurnRendering",
  "projectLowerBand",
  "summarizeChunkDetailed",
  "summarizeChunkBrief",
] as const;

export type ProviderOperationName = (typeof PROVIDER_OPERATIONS)[number];

// ── SDK assembly config (tech design §Interfaces) ────────────────
// Provider arrival is exactly one of `provider` (direct injection,
// unchanged — the deterministic test default) or `inference` (host
// model-call function + per-kind assignments, Epic 05 DD-5). Both or
// neither is a construction TypeError naming the XOR rule (AC-1.1).
export interface SdkConfig {
  provider?: DerivationProvider;
  inference?: InferenceConfig;
  mode: "background" | "manual";
  clock?: () => Date;
  retry?: { budget: number; backoffBaseMs: number; backoffCapMs: number }; // 3 / 5000 / 60000
  lease?: { durationMs: number }; // 120000
  chunkPolicy?: { targetProjectedTokens: number; maxProjectedTokens: number }; // 2200 / 4400
  view?: SdkViewConfig; // Epic 03: profiles, visibility budgets, compact threshold
}

// Every optional filled by createSdk's central defaults.
export interface ResolvedSdkConfig {
  provider: DerivationProvider;
  mode: "background" | "manual";
  clock: () => Date;
  retry: { budget: number; backoffBaseMs: number; backoffCapMs: number };
  lease: { durationMs: number };
  chunkPolicy: { targetProjectedTokens: number; maxProjectedTokens: number };
  view: ResolvedViewConfig;
}

// ── handler contract (DD-6; the map's value type) ────────────────
export interface HandlerRunContext {
  openDb(): DatabaseSync; // short-txn access; NEVER held across provider calls
  provider: DerivationProvider;
  clock: () => Date;
  config: ResolvedSdkConfig;
}

// A successful handler hands its derived-form content back as data; the
// drain's completion transaction performs the version-checked UPDATE and the
// item-row deletion atomically (tech design §Mechanics: completion is one
// short BEGIN IMMEDIATE doing the form write and the delete). The handler
// never opens that transaction itself, so the version check and the
// done/stale_discarded disposition stay in one place — the queue util.
export interface HandlerFormWrite {
  subjectKind: SubjectKind;
  subjectId: string;
  form: FormKind;
  content: string;
  metadata?: DerivedFormMetadata;
  gaps?: DependencyGap[];
}

// The completion-transaction hook (Story 3): work that must land atomically
// with the version-checked form writes — chunk placement and the
// close→summary enqueues above all. The queue util invokes it inside the
// completion's BEGIN IMMEDIATE, after the form writes and only when they hit
// (a stale completion must not place a turn or enqueue summaries); onCommit
// registrations flush after that COMMIT succeeds and drop on rollback, so a
// crash leaves either a placed turn with its enqueues or nothing — never a
// derived-but-unplaced turn.
export interface CompletionTx {
  db: DatabaseSync;
  onCommit: (fn: () => void) => void;
}

export type HandlerOutcome =
  | { ok: true; forms?: HandlerFormWrite[]; onApplied?: (tx: CompletionTx) => void }
  | { ok: false; retryable: boolean; reason: string }
  | { ok: false; blocked: true; reason: string }; // source damage → form blocked, item terminal

// item is the queue util's WorkItemRecord; typed structurally here so the
// shared layer does not depend on the util's module (and vice versa stays
// one-directional: tech-utils imports shared).
export type WorkHandler = (
  run: HandlerRunContext,
  item: { workItemId: string; kind: string; sourceRef: Record<string, string> },
) => Promise<HandlerOutcome>;
