import type { ApiBlock, ApiBlockType } from "./content-blocks.js";

export type Band = "brief" | "detailed" | "smooth";

export interface ViewProfile {
  name: string;
  lowerBound: number;
  percentages: { full: number; smooth: number; detailed: number; brief: number };
  newestClosedProtection: number;
}

export interface ViewProfileOverride {
  name: string;
  lowerBound?: number;
  percentages?: Partial<ViewProfile["percentages"]>;
  newestClosedProtection?: number;
}

export interface ViewCompactParams {
  lowerBound?: number;
  percentages?: Partial<ViewProfile["percentages"]>;
  newestClosedProtection?: number;
}

export interface VisibilityBudgets {
  maxTokens: number;
  targetTokens: number;
}

export interface SdkViewConfig {
  profiles?: ViewProfileOverride[];
  visibility?: Partial<VisibilityBudgets>;
  compactThreshold?: number;
}

export interface ResolvedViewConfig {
  profiles: Readonly<Record<string, ViewProfile>>;
  visibility: VisibilityBudgets;
  compactThreshold: number;
}

export interface LlmRequestContextPart {
  type: "text";
  text: string;
}

export interface LlmRequestContextMessage {
  role: "user" | "assistant";
  content: LlmRequestContextPart[];
}

export interface LlmRequestContext {
  threadId: string;
  messages: LlmRequestContextMessage[];
}

export interface SessionAssistantPart {
  type: "text" | "thinking" | "toolCall" | ApiBlockType;
  text?: string;
  thinking?: string;
  thinkingSignature?: string;
  toolCallId?: string;
  toolName?: string;
  arguments?: Record<string, unknown>;
  block?: ApiBlock;
}

export interface SessionThreadViewEntrySource {
  messageId: string;
  idempotencyKey: string | null;
}

export interface SessionUserMessage {
  role: "user";
  content: string;
  blocks?: ApiBlock[];
  sourceMessages: SessionThreadViewEntrySource[];
}

export interface SessionAssistantMessage {
  role: "assistant";
  content: SessionAssistantPart[];
  sourceMessages: SessionThreadViewEntrySource[];
  provider?: string;
  model?: string;
  api?: string;
}

export interface SessionToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName?: string;
  content: string;
  blocks?: ApiBlock[];
  isError?: boolean;
  sourceMessages: SessionThreadViewEntrySource[];
}

export interface SessionModelChangeEntry {
  kind: "model_change";
  provider: string;
  modelId: string;
  sourceMessages: SessionThreadViewEntrySource[];
}

export interface SessionThinkingLevelChangeEntry {
  kind: "thinking_level_change";
  level: string;
  sourceMessages: SessionThreadViewEntrySource[];
}

export type SessionThreadViewMessage = SessionUserMessage | SessionAssistantMessage | SessionToolResultMessage;

export type SessionThreadViewEntry =
  | SessionThreadViewMessage
  | SessionModelChangeEntry
  | SessionThinkingLevelChangeEntry;

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
  config: { lowerBound: number; percentages: Record<string, number>; newestClosedProtection?: number };
  arrangement: Array<{
    band: Band;
    subjectKind: "chunk" | "turn";
    subjectId: string;
    derivationUsed: string;
    degraded: boolean;
    part?: { fromStep: number; toStep: number };
  }>;
  gaps: Array<{ band: Band; subjectId: string; reason: string }>;
  sourceState: { maxEventOrder: number; derivationCounts: Record<string, number> };
  bands: Array<{ band: Band; storedTokens: number }>;
}

export interface HostMetadata {
  activeTurn: {
    turnId: string;
    estimatedTokens: number;
    completeSteps: number;
    lastStepEdge: number | null;
    splittable: boolean;
  } | null;
  unsettledTurn: { turnId: string } | null;
}

export interface ViewStatus {
  tailTokens: number;
  threshold: number;
  compactRecommended: boolean;
  derivation: { pending: number; failed: number; blocked: number };
  view: { degraded: number; gaps: number; builtAt: string } | null;
  visibility: { boundaryPosition: number; zoneTokens: number; maxTokens: number };
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

export interface PreviewCompactResult {
  compactPoint: number;
  wouldProduceBands: boolean;
  tailTokens: number;
  firstKeptMessageId: string | null;
}

export type PreviewCompactOutcome = { kind: "ok"; preview: PreviewCompactResult } | { kind: "error"; reason: string };

export type SkippedRecord =
  | { kind: "orphaned_message"; messageId: string; turnId: string; reason: string }
  | { kind: "dangling_chunk_member"; chunkId: string; turnId: string; reason: string };

export interface CompactReceipt {
  viewId: string;
  profile: string | null;
  config: ViewProfile["percentages"] & { lowerBound: number; newestClosedProtection?: number };
  bands: Record<Band, { entries: number; tokens: number }>;
  tailTokens: number;
  totalTokens: number;
  coveredFrom: number;
  compactPoint: number;
  degraded: Array<{ band: Band; subjectId: string; usedDerivation: string }>;
  gaps: Array<{ band: Band; subjectId: string; reason: string }>;
  warnings?: Array<{
    band: Band;
    subjectId: string;
    derivationType: "chunk_summary_detailed" | "chunk_summary_brief";
    reason: string;
  }>;
  skippedRecords: SkippedRecord[];
  tokenFamily: string;
  renderedBands: Array<{ band: Band; text: string }>;
  firstKeptMessageId: string | null;
  parts?: Array<{ turnId: string; fromStep: number; toStep: number }>;
  splitPoint?: { turnId: string; stepIndex: number };
  settled?: { turnId: string; construction: SettleConstruction };
  protectedTurn?: { turnId: string; representation: "full" | "whole_rendering" };
}

export type SettleConstruction =
  | { kind: "stored"; subjectId: string; derivationType: "turn_rendering"; sourceVersion: number }
  | { kind: "composed_in_walk"; turnId: string };
