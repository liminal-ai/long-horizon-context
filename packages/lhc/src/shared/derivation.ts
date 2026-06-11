// Epic 02 shared vocabulary: the derived-form state machine's types, the
// provider seam, and the handler contract. Both owning domains (messages,
// turns) consume these; neither owns them — the repair report, the mutation
// cascade, and the drain all speak this vocabulary across domain lines, so it
// lives in shared/ (tech design §Interfaces, DD-2/DD-7).
import type { DatabaseSync } from "node:sqlite";

export type SubjectKind = "message" | "turn" | "chunk";

export type FormKind =
  | "smoothed_prompt"
  | "tool_call_summary"
  | "tool_result_summary"
  | "turn_rendering"
  | "lower_band_projection"
  | "chunk_summary_detailed"
  | "chunk_summary_brief";

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
  metadata?: { outcome?: ToolOutcome }; // mechanically stamped fields; never provider-authored
  derivedAt?: string;
}

// ── provider seam (DD-7) ─────────────────────────────────────────
// Every operation returns content or a structured failure carrying
// retryable-or-not; classification is the adapter's duty.
export type ProviderResult =
  | { ok: true; text: string }
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
  summarizeChunkDetailed(i: { memberProjections: string[] }): Promise<ProviderResult>;
  summarizeChunkBrief(i: { memberProjections: string[] }): Promise<ProviderResult>;
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
export interface SdkConfig {
  provider: DerivationProvider;
  mode: "background" | "manual";
  clock?: () => Date;
  retry?: { budget: number; backoffBaseMs: number; backoffCapMs: number }; // 3 / 5000 / 60000
  lease?: { durationMs: number }; // 120000
  chunkPolicy?: { targetProjectedTokens: number; maxProjectedTokens: number }; // 2200 / 4400
}

// Every optional filled by createSdk's central defaults.
export interface ResolvedSdkConfig {
  provider: DerivationProvider;
  mode: "background" | "manual";
  clock: () => Date;
  retry: { budget: number; backoffBaseMs: number; backoffCapMs: number };
  lease: { durationMs: number };
  chunkPolicy: { targetProjectedTokens: number; maxProjectedTokens: number };
}

// ── handler contract (DD-6; the map's value type) ────────────────
export interface HandlerRunContext {
  openDb(): DatabaseSync; // short-txn access; NEVER held across provider calls
  provider: DerivationProvider;
  clock: () => Date;
  config: ResolvedSdkConfig;
}

export type HandlerOutcome =
  | { ok: true } // forms written by handler, version-checked
  | { ok: false; retryable: boolean; reason: string }
  | { ok: false; blocked: true; reason: string }; // source damage → form blocked, item terminal

// item is the queue util's WorkItemRecord; typed structurally here so the
// shared layer does not depend on the util's module (and vice versa stays
// one-directional: tech-utils imports shared).
export type WorkHandler = (
  run: HandlerRunContext,
  item: { workItemId: string; kind: string; sourceRef: Record<string, string> },
) => Promise<HandlerOutcome>;
