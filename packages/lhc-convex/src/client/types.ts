import type { FunctionHandle } from "convex/server";

export type ErrorClass = "caller_error" | "state_corruption" | "system_error";

export type ErrorCode =
  | "thread_not_found"
  | "path_exists"
  | "ambiguous_thread_id"
  | "invalid_thread_ref"
  | "invalid_event"
  | "empty_batch"
  | "turn_state_corrupt"
  | "storage_failure"
  | "turn_open"
  | "message_initiates_turn"
  | "message_not_found"
  | "turn_not_found"
  | "unknown_work_kind"
  | "provider_failure"
  | "source_damaged"
  | "inference_unavailable"
  | "derivation_work_in_flight"
  | "derivation_completion_mismatch"
  | "unknown_profile"
  | "invalid_view_config"
  | "compact_stopped"
  | "invalid_bounds"
  | "invalid_target_tokens";

export interface ErrorResult {
  errorClass: ErrorClass;
  code: ErrorCode;
  reason: string;
  eventIndex?: number;
}

export type OpResult<T> = { ok: true; value: T } | { ok: false; error: ErrorResult };

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

export interface ModelCallInput extends Record<string, unknown> {
  provider: string;
  model: string;
  messages: Array<{ role: "system" | "user"; content: string }>;
  thinking?: ModelAssignment["thinking"];
}

export type ModelCallResult = { ok: true; text: string } | { ok: false; kind: ModelCallFailureKind; message: string };

export type ModelCallHandle = FunctionHandle<"action", ModelCallInput, ModelCallResult>;

export interface InferenceConfig {
  call: ModelCallHandle;
  assignments?: Record<string, ModelAssignment>;
  timeoutMs?: number;
  maxInputChars?: number;
}

export interface ViewProfile {
  name: string;
  lowerBound: number;
  percentages: { full: number; smooth: number; detailed: number; brief: number };
}

export interface ViewProfileOverride {
  name: string;
  lowerBound?: number;
  percentages?: Partial<ViewProfile["percentages"]>;
}

export interface ViewCompactParams {
  lowerBound?: number;
  percentages?: Partial<ViewProfile["percentages"]>;
}

export interface SdkConfig {
  componentInstanceId: string;
  inference: InferenceConfig;
  mode: "background" | "manual";
  guards?: {
    smoothedPrompt?: { maxInferenceTokens?: number; suspiciousOutputRatio?: number };
    toolResultSummary?: { timeoutMs?: number };
    detailedTurnCompression?: { tinyTurnTokens?: number };
  };
  toolResult?: { smallTierTokens: number; smallTargetRatio: number; midTargetRatio: number };
  chunkPolicy?: { targetProjectedTokens: number; maxProjectedTokens: number };
  view?: {
    profiles?: ViewProfileOverride[];
    visibility?: { maxTokens?: number; targetTokens?: number };
    compactThreshold?: number;
  };
}

export type ThreadRef = { threadId: string } | { filePath: string };

export interface NewThreadInput {
  filePath: string;
  title?: string;
  cwd?: string;
}

export interface ThreadInfo {
  threadId: string;
  filePath: string;
  title?: string;
  cwd?: string;
  createdAt: string;
}

export interface ThreadFileInfo {
  threadId: string;
  createdAt: string;
}

interface BaseEvent<K extends string, P> {
  eventKind: K;
  idempotencyKey: string;
  actor: string;
  harness: string;
  payload: P;
}

// Host-observed turn outcome/timing on turn_end (schema v5 / D1). All optional;
// empty payload stays valid for hosts that do not report these facts.
export type TurnEndPayload = {
  outcome?: "completed" | "aborted";
  outcomeReason?: string;
  startedAt?: string;
  endedAt?: string;
};

// Provider usage is the host's verbatim JSON object for one model call — no
// fixed column set, no interpretation inside LHC (schema v5 / D1, D3).
export type AssistantTextPayload = {
  text: string;
  providerUsage?: Record<string, unknown>;
};

export type MessageEventInput =
  | BaseEvent<"user_prompt", { text: string }>
  | BaseEvent<"assistant_text", AssistantTextPayload>
  | BaseEvent<"assistant_thinking", { text: string }>
  | BaseEvent<"runtime_note", { text: string }>
  | BaseEvent<"model_change", { previousModel: string; newModel: string }>
  | BaseEvent<"thinking_level_change", { previousLevel: string; newLevel: string }>
  | BaseEvent<"tool_call", { toolCallId: string; toolName: string; arguments: Record<string, unknown> }>
  | BaseEvent<"tool_result", { toolCallId: string; content: string; isError?: boolean }>
  | BaseEvent<"turn_end", TurnEndPayload>;

export type EventKind = MessageEventInput["eventKind"];
export type EventRecord = MessageEventInput & { eventOrder: number; recordedAt: string };

export type WorkOwner = "messages" | "turns";
export type WorkKind =
  | "prompt_smoothing"
  | "tool_result_summary"
  | "turn_derivation"
  | "detailed_turn_compression"
  | "chunk_summary_detailed"
  | "chunk_summary_brief";

export interface BatchResult {
  events: Array<{
    idempotencyKey: string;
    outcome: "recorded" | "skipped";
    messageId?: string;
    skipReason?: "duplicate_idempotency_key";
  }>;
  turnTransitions: Array<{ action: "opened" | "closed"; turnId: string }>;
  queuedWork: Array<{ workItemId: string; owner: WorkOwner; kind: WorkKind; sourceRef: Record<string, string> }>;
  threadPosition: { lastEventOrder: number };
}

export type SubjectKind = "message" | "turn" | "chunk";
export type DerivationState = "pending" | "ready" | "failed" | "blocked";
export type ToolOutcome = "succeeded" | "failed" | "unknown";

export interface ProviderProvenance {
  provider: string;
  model: string;
  prompt: string;
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

export interface DerivationReportEntry extends Derivation {
  queue?: { status: "queued" | "running" };
}

export interface Block {
  blockType: "text" | "tool_call" | "tool_result" | "model_change" | "thinking_level_change";
  content: Record<string, unknown>;
}

export type RenderingPartKind = Exclude<EventKind, "turn_end">;

export interface RenderingPart {
  messageId: string;
  kind: RenderingPartKind;
  text: string;
  fallback: boolean;
  blocks?: Array<{ blockType: string; content: Record<string, unknown> }>;
  outcome?: ToolOutcome;
}

export interface MessageRecord {
  messageId: string;
  sourceEventOrder: number;
  kind: Exclude<EventKind, "turn_end">;
  blocks: Block[];
  tokenEstimate: number;
  actor: string;
  harness: string;
  recordedAt: string;
  turnId: string;
  // Host-observed provider usage from assistant_text (schema v5). Absent when
  // the source event did not carry it (other kinds, pre-v5 docs, hosts that omit).
  providerUsage?: Record<string, unknown>;
  derivations?: Derivation[];
  deleted?: boolean;
}

export interface MessageDetail extends Omit<MessageRecord, "derivations"> {
  deleted: boolean;
  derivations: DerivationReportEntry[];
}

export interface MessageListOptions {
  from?: number;
  to?: number;
  limit?: number;
  includeDeleted?: boolean;
}

export interface TurnRecord {
  turnId: string;
  turnOrder: number;
  status: "open" | "closed";
  memberMessageIds: string[];
  openedAtEventOrder: number;
  closedAtEventOrder?: number;
  // Host-observed facts from turn_end (schema v5). Absent when unknown —
  // pre-v5 turns, prompt-boundary closes, or hosts that omit them.
  outcome?: "completed" | "aborted";
  outcomeReason?: string;
  startedAt?: string;
  endedAt?: string;
  chunkId?: string;
  memberIdx?: number;
  derivations?: Derivation[];
}

export interface ChunkRecord {
  chunkId: string;
  chunkOrder: number;
  status: "open" | "closed";
  accumulatedProjectedTokens: number;
  memberTurnIds: string[];
  derivations?: Derivation[];
}

export interface DrainReport {
  claimed: number;
  completed: number;
  failed: number;
  blocked: number;
  staleDiscarded: number;
  remaining: number;
}

export type Band = "brief" | "detailed" | "smooth";

export interface LlmRequestContext {
  threadId: string;
  messages: Array<{ role: "user" | "assistant"; content: Array<{ type: "text"; text: string }> }>;
}

export interface SessionThreadViewEntrySource {
  messageId: string;
  idempotencyKey: string | null;
}

export type SessionThreadViewEntry =
  | { role: "user"; content: string; sourceMessages: SessionThreadViewEntrySource[] }
  | {
      role: "assistant";
      content: Array<{
        type: "text" | "thinking" | "toolCall";
        text?: string;
        thinking?: string;
        toolCallId?: string;
        toolName?: string;
        arguments?: Record<string, unknown>;
      }>;
      sourceMessages: SessionThreadViewEntrySource[];
    }
  | {
      role: "toolResult";
      toolCallId: string;
      toolName?: string;
      content: string;
      isError?: boolean;
      sourceMessages: SessionThreadViewEntrySource[];
    }
  | { kind: "model_change"; provider: string; modelId: string; sourceMessages: SessionThreadViewEntrySource[] }
  | { kind: "thinking_level_change"; level: string; sourceMessages: SessionThreadViewEntrySource[] };

export interface SessionThreadView {
  threadId: string;
  entries: SessionThreadViewEntry[];
}

export interface StoredView {
  viewId: string;
  createdAt: string;
  compactPoint: number;
  coveredFrom: number;
  profileName: string | null;
  config: { lowerBound: number; percentages: ViewProfile["percentages"] };
  arrangement: Array<Record<string, unknown>>;
  gaps: Array<Record<string, unknown>>;
  sourceState: Record<string, unknown>;
  bands: Array<{ band: Band; storedTokens: number }>;
}

export interface ViewStatus {
  tailTokens: number;
  threshold: number;
  compactRecommended: boolean;
  derivation: { pending: number; failed: number; blocked: number };
  view: null | { degraded: number; gaps: number; builtAt: string };
  visibility: { boundaryPosition: number; zoneTokens: number; maxTokens: number };
}

export interface CompactReceipt {
  viewId: string;
  profile: string | null;
  config: ViewProfile["percentages"] & { lowerBound: number };
  bands: Record<Band, { entries: number; tokens: number }>;
  tailTokens: number;
  totalTokens: number;
  coveredFrom: number;
  compactPoint: number;
  degraded: Array<{ band: Band; subjectId: string; usedDerivation: string }>;
  gaps: Array<{ band: Band; subjectId: string; reason: string }>;
  warnings: Array<Record<string, unknown>>;
  renderedBands: Array<{ band: Band; text: string }>;
  firstKeptMessageId: string | null;
}

export interface PreviewCompactOutcome {
  kind: "ok" | "error";
  preview?: { compactPoint: number; wouldProduceBands: boolean; tailTokens: number; firstKeptMessageId: string | null };
  reason?: string;
}

export interface PruneReceipt {
  previousBoundary: number;
  newBoundary: number;
  compactPoint: number;
  targetTokens: number;
  toolResultsPruned: number;
  tokensBehindBoundary: number;
  zoneTokensBefore: number;
  zoneTokensAfter: number;
  noOp: boolean;
}

export interface LogEntry {
  level: "info" | "warning" | "error";
  message: string;
  derivationType?: string;
  subjectId?: string;
  reason?: string;
  floorUsed?: string;
}

export interface StoredLogEntry extends LogEntry {
  logId: number;
  recordedAt: string;
}

export interface StoredDerivationLogEntry {
  [key: string]: unknown;
}

export interface InspectOverview {
  thread: { id: string; createdAt: string; metadata?: Record<string, string> };
  events: { count: number; span: { first: number; last: number } | null };
  messages: { visible: number; byKind: Record<string, number>; deleted: number; visibleTokens: number };
  turns: { open: number; closed: number };
  chunks: { count: number; unchunkedTurns: number };
  derivation: { ready: number; pending: number; failed: number; blocked: number };
  view: { viewId: string; createdAt: string; compactPoint: number; coveredFrom: number } | null;
  visibility: { boundaryPosition: number; zoneTokens: number };
}

export interface HealthReport {
  owners: Array<{
    owner: "capture" | "messages" | "turns";
    kind: string;
    counts: { ready: number; pending: number; failed: number; blocked: number };
  }>;
  failures: Array<{
    owner: string;
    subjectKind: string;
    subjectId: string;
    derivationType: string;
    reason: string;
  }>;
  repairPreview: Array<{ owner: string; subjectKind: string; subjectId: string; derivationType: string }>;
  queue: { queued: number; claimed: number };
}

export interface ViewContentsReport {
  meta: {
    viewId: string;
    createdAt: string;
    profile: string | null;
    config: { lowerBound: number; percentages: Record<string, number> };
    compactPoint: number;
    coveredFrom: number;
  } | null;
  bands: Array<{
    band: Band;
    entries: Array<{ subjectKind: "chunk" | "turn"; subjectId: string; derivationUsed: string; degraded: boolean }>;
    storedTokens: number;
  }>;
  gaps: Array<{ band: Band; subjectId: string; reason: string }>;
  tail: { messageCount: number; tokens: number };
  loadCost: { bandTokens: number; tailTokens: number; total: number };
  sourceState: { maxEventOrder: number; derivationCounts: Record<string, number> } | null;
}

export interface MutationResult {
  changed: { messageIds: string[]; turnIds: string[] };
  cleared: Array<Record<string, unknown>>;
  dropped: Array<Record<string, unknown>>;
  queued: Array<{ workItemId: string; kind: WorkKind }>;
  superseded: string[];
}

export type MessageDeriveResult =
  | { messageId: string; outcome: "derived"; sourceVersion: number }
  | { messageId: string; outcome: "not_derivable" };

export type TurnDeriveResult =
  | { turnId: string; outcome: "derived"; sourceVersion: number }
  | { turnId: string; outcome: "failed"; error: ErrorResult };

export type ChunkDeriveResult =
  | {
      chunkId: string;
      outcome: "derived";
      derivationType: "chunk_summary_detailed" | "chunk_summary_brief";
      sourceVersion: number;
    }
  | { chunkId: string; outcome: "failed"; error: ErrorResult };
