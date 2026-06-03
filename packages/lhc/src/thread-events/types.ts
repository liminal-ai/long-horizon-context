import type {
  AppendThreadEventsInput,
  JsonObject,
  PersistedThreadEvent,
  ThreadCreateInput,
  ThreadEventAppendInput,
} from "./schema.js";
import type { LhcSqliteHandle } from "./sqlite/open.js";

export interface ThreadEventStoreOptions {
  dbPath?: string;
  threadDbPath?: string;
  eventDbPath?: string;
  now?: () => Date;
  idGenerator?: () => string;
  smoothingProvider?: TurnSmoothingProvider;
  lowerBandProjectionTokenCounter?: TurnLowerBandProjectionTokenCounter;
  chunkCompressionProvider?: ChunkLowerBandCompressionProvider;
  chunkPolicy?: Partial<ChunkPolicy>;
}

export interface ProjectedThread {
  threadId: string;
  clientThreadId: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
}

export type MessageKind = "user" | "assistant" | "tool_result" | "system";
export type MessageStatus = "complete" | "incomplete" | "aborted" | "error";
export type MessageBlockKind = "text" | "thinking" | "tool_call" | "tool_result" | "image" | "file";

export interface ProjectedMessage {
  messageId: string;
  threadId: string;
  messageOrder: number;
  messageKind: MessageKind;
  actor: unknown;
  status: MessageStatus;
  createdAt: string;
  sourceEventId: string;
  sourceEventOrder: number;
}

export interface ProjectedMessageBlock {
  blockId: string;
  messageId: string;
  threadId: string;
  blockOrder: number;
  blockKind: MessageBlockKind;
  payload: JsonObject;
  sourceEventId: string;
  sourceEventOrder: number;
}

export interface ProjectedMessageWithBlocks extends ProjectedMessage {
  blocks: ProjectedMessageBlock[];
}

export interface ProjectedThreadRead {
  thread: ProjectedThread;
  events: PersistedThreadEvent[];
  messages: ProjectedMessageWithBlocks[];
  turns: CanonicalTurn[];
  chunks: CanonicalChunk[];
}

export type TurnProcessingTriggerStatus = "pending" | "claimed" | "completed" | "failed";

export interface TurnProcessingTrigger {
  triggerId: string;
  threadId: string;
  turnEndEventOrder: number;
  status: TurnProcessingTriggerStatus;
  createdAt: string;
  claimedAt?: string;
  completedAt?: string;
  lastError?: string;
}

export interface CanonicalTurn {
  turnId: string;
  threadId: string;
  turnOrder: number;
  lifecycleStatus: "closed" | "open";
  processingStatus: "ready" | "failed" | "degraded" | "pending";
  sourceEventRange: { start: number; end: number };
  sourceMessageIds: string[];
  smooth?: JsonObject;
  lowerBandProjection?: JsonObject;
}

export interface CanonicalChunk {
  chunkId: string;
  threadId: string;
  chunkOrder: number;
  lifecycleStatus: "open" | "closed";
  sourceTurnIds: string[];
  smoothText: string;
  lowerBand?: JsonObject;
}

export interface CreateThreadResult {
  thread: ProjectedThread;
  created: boolean;
  event?: PersistedThreadEvent;
}

export interface AppendThreadEventsResult {
  thread: ProjectedThread;
  events: PersistedThreadEvent[];
  messages: ProjectedMessage[];
  blocks: ProjectedMessageBlock[];
  trigger?: TurnProcessingTrigger;
  triggered?: boolean;
  reason?: string;
}

export interface TurnSmoothingProvider {
  smoothUserPrompt(input: { threadId: string; turnId: string; text: string }): Promise<{ text: string; metadata?: JsonObject }>;
}

export interface TurnLowerBandProjectionTokenCounter {
  countTurnLowerBandProjection(input: { threadId: string; turnId: string; text: string }): Promise<{ count: number; metadata?: JsonObject }>;
}

export interface ChunkLowerBandCompressionProvider {
  compressChunk(input: { threadId: string; chunkId: string; band: "detailed" | "brief"; text: string }): Promise<{ text: string; metadata?: JsonObject }>;
}

export interface ChunkPolicy {
  targetMinSmoothTokens: number;
  targetSoftMaxSmoothTokens: number;
  hardMaxSmoothTokens: number;
}

export interface ProcessTurnEndTriggerResult {
  trigger?: TurnProcessingTrigger;
  turn?: CanonicalTurn;
  updatedChunkIds: string[];
  completed: boolean;
  retryable: boolean;
  reason?: "no_pending_trigger" | "turn_not_ready";
}

export interface StoreRuntime {
  db: LhcSqliteHandle;
  dbPath: string;
  now: () => Date;
  idGenerator: () => string;
  options: ThreadEventStoreOptions;
}

export type { AppendThreadEventsInput, PersistedThreadEvent, ThreadCreateInput, ThreadEventAppendInput };
