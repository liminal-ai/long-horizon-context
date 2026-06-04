import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { ThreadEventValidationError, decodeAppendThreadEventsEnvelopeInput, decodeThreadCreateInput, decodeThreadEventAppendInput } from "./schema.js";
import { ThreadEventStoreError } from "./errors.js";
import { openLhcSqlite, type LhcSqliteHandle } from "./sqlite/open.js";
import { ensureLhcThreadEventsSchema } from "./sqlite/schema.js";
import { appendEventRecords, listEventRecords, listEventRecordsForThread } from "./persistence/events.js";
import { readProjectedMessagesForThread } from "./persistence/messages.js";
import { findThreadByClientThreadId, listThreadRecords, createThreadRecord } from "./persistence/threads.js";
import { readTurnRecords } from "./persistence/turns.js";
import { readChunkRecords } from "./persistence/chunks.js";
import { listTriggerRecords } from "./persistence/triggers.js";
import { processNextTurnTrigger, processTurnTrigger } from "./worker/turns.js";
import type {
  AppendThreadEventsInput,
  AppendThreadEventsResult,
  CanonicalChunk,
  CanonicalTurn,
  CreateThreadResult,
  PersistedThreadEvent,
  ProcessTurnEndTriggerResult,
  ProjectedThread,
  ProjectedThreadRead,
  StoreRuntime,
  ThreadCreateInput,
  ThreadEventAppendInput,
  ThreadEventStoreOptions,
  TurnProcessingTrigger,
} from "./types.js";

export class ThreadEventStore {
  readonly dbPath: string;
  /** @deprecated Use dbPath. Kept as a compatibility alias while CLI/options settle. */
  readonly eventDbPath: string;
  private readonly now: () => Date;
  private readonly idGenerator: () => string;
  private readonly options: ThreadEventStoreOptions;
  private readonly db: LhcSqliteHandle;

  constructor(options: ThreadEventStoreOptions) {
    const dbPath = options.dbPath ?? options.threadDbPath ?? options.eventDbPath;
    if (!dbPath) {
      throw new ThreadEventStoreError("ThreadEventStore requires dbPath.");
    }

    this.dbPath = resolve(dbPath);
    this.eventDbPath = this.dbPath;
    this.now = options.now ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? (() => randomUUID());
    this.options = options;
    this.db = openLhcSqlite(this.dbPath);
    ensureLhcThreadEventsSchema(this.db);
  }

  close(): void {
    this.db.close();
  }

  async createThread(input: ThreadCreateInput): Promise<CreateThreadResult> {
    const decoded = decodeThreadCreateInput(input);
    return await createThreadRecord(this.runtime(), decoded);
  }

  async append(clientThreadId: string, event: ThreadEventAppendInput): Promise<AppendThreadEventsResult>;
  async append(input: ThreadEventAppendInput & { clientThreadId: string }): Promise<AppendThreadEventsResult>;
  async append(inputOrClientThreadId: string | (ThreadEventAppendInput & { clientThreadId: string }), maybeEvent?: ThreadEventAppendInput): Promise<AppendThreadEventsResult> {
    if (typeof inputOrClientThreadId !== "string") {
      const { clientThreadId, ...event } = inputOrClientThreadId;
      return await this.appendMany(clientThreadId, [event as ThreadEventAppendInput]);
    }

    return await this.appendMany(inputOrClientThreadId, maybeEvent === undefined ? [] : [maybeEvent]);
  }

  async appendMany(input: AppendThreadEventsInput): Promise<AppendThreadEventsResult>;
  async appendMany(clientThreadId: string, events: readonly ThreadEventAppendInput[]): Promise<AppendThreadEventsResult>;
  async appendMany(inputOrClientThreadId: AppendThreadEventsInput | string, maybeEvents?: readonly ThreadEventAppendInput[]): Promise<AppendThreadEventsResult> {
    const envelope = typeof inputOrClientThreadId === "string"
      ? decodeAppendThreadEventsEnvelopeInput({ clientThreadId: inputOrClientThreadId, events: maybeEvents ?? [] })
      : decodeAppendThreadEventsEnvelopeInput(inputOrClientThreadId);
    const clientThreadId = envelope.clientThreadId;
    const events = envelope.events;
    if (typeof clientThreadId !== "string" || clientThreadId.length === 0) {
      throw new ThreadEventValidationError("appendMany requires a non-empty clientThreadId.");
    }
    if (!Array.isArray(events)) {
      throw new ThreadEventValidationError("appendMany requires an events array.");
    }

    let aggregate: AppendThreadEventsResult | undefined;
    let skipUntilUserPrompt = false;
    for (const event of events) {
      const eventKind = rawEventKind(event);
      if (skipUntilUserPrompt && eventKind !== "user_prompt") {
        continue;
      }
      if (eventKind === "user_prompt") {
        skipUntilUserPrompt = false;
      }

      const normalizedEvent = decodeThreadEventAppendInput(event);
      const result = await appendEventRecords(this.runtime(), clientThreadId, [normalizedEvent]);
      aggregate = mergeAppendResults(aggregate, result);
      if (result.triggered) {
        skipUntilUserPrompt = true;
      }
    }

    if (aggregate) {
      return aggregate;
    }

    return await appendEventRecords(this.runtime(), clientThreadId, []);
  }

  async list(): Promise<PersistedThreadEvent[]> {
    return await listEventRecords(this.runtime());
  }

  async listThreads(): Promise<ProjectedThread[]> {
    return await listThreadRecords(this.runtime());
  }

  async readThread(clientThreadId: string): Promise<ProjectedThreadRead | undefined> {
    const runtime = this.runtime();
    const thread = findThreadByClientThreadId(runtime, clientThreadId);
    if (!thread) {
      return undefined;
    }
    return {
      thread,
      events: await listEventRecordsForThread(runtime, thread.threadId),
      messages: readProjectedMessagesForThread(runtime, thread.threadId),
      turns: await readTurnRecords(runtime, clientThreadId),
      chunks: await readChunkRecords(runtime, clientThreadId),
    };
  }

  async readTurns(clientThreadId?: string): Promise<CanonicalTurn[]> {
    return await readTurnRecords(this.runtime(), clientThreadId);
  }

  async readChunks(clientThreadId?: string): Promise<CanonicalChunk[]> {
    return await readChunkRecords(this.runtime(), clientThreadId);
  }

  async listTurnProcessingTriggers(): Promise<TurnProcessingTrigger[]> {
    return await listTriggerRecords(this.runtime());
  }

  async processNextTurnEndTrigger(): Promise<ProcessTurnEndTriggerResult> {
    return await processNextTurnTrigger(this.runtime());
  }

  async processTurnEndTrigger(triggerId: string): Promise<ProcessTurnEndTriggerResult> {
    return await processTurnTrigger(this.runtime(), triggerId);
  }

  private runtime(): StoreRuntime {
    return {
      db: this.db,
      dbPath: this.dbPath,
      now: this.now,
      idGenerator: this.idGenerator,
      options: this.options,
    };
  }
}

function mergeAppendResults(aggregate: AppendThreadEventsResult | undefined, result: AppendThreadEventsResult): AppendThreadEventsResult {
  if (aggregate === undefined) {
    return result;
  }
  const trigger = result.trigger ?? aggregate.trigger;
  const reason = result.reason ?? aggregate.reason;
  return {
    thread: result.thread,
    events: [...aggregate.events, ...result.events],
    messages: [...aggregate.messages, ...result.messages],
    blocks: [...aggregate.blocks, ...result.blocks],
    ...(trigger === undefined ? {} : { trigger }),
    triggered: Boolean(aggregate.triggered || result.triggered),
    ...(reason === undefined ? {} : { reason }),
  };
}

function rawEventKind(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null || Array.isArray(event)) {
    return undefined;
  }
  const value = (event as { eventKind?: unknown }).eventKind;
  return typeof value === "string" ? value : undefined;
}

export async function createThread(options: ThreadEventStoreOptions, input: ThreadCreateInput): Promise<CreateThreadResult> {
  const store = new ThreadEventStore(options);
  try {
    return await store.createThread(input);
  } finally {
    store.close();
  }
}

export async function appendThreadEvent(options: ThreadEventStoreOptions, clientThreadId: string, event: ThreadEventAppendInput): Promise<AppendThreadEventsResult> {
  const store = new ThreadEventStore(options);
  try {
    return await store.append(clientThreadId, event);
  } finally {
    store.close();
  }
}

export async function appendThreadEvents(options: ThreadEventStoreOptions, input: AppendThreadEventsInput): Promise<AppendThreadEventsResult> {
  const store = new ThreadEventStore(options);
  try {
    return await store.appendMany(input);
  } finally {
    store.close();
  }
}

export async function listThreadEvents(options: ThreadEventStoreOptions): Promise<PersistedThreadEvent[]> {
  const store = new ThreadEventStore(options);
  try {
    return await store.list();
  } finally {
    store.close();
  }
}

export async function listThreads(options: ThreadEventStoreOptions): Promise<ProjectedThread[]> {
  const store = new ThreadEventStore(options);
  try {
    return await store.listThreads();
  } finally {
    store.close();
  }
}

export async function readThread(options: ThreadEventStoreOptions, clientThreadId: string): Promise<ProjectedThreadRead | undefined> {
  const store = new ThreadEventStore(options);
  try {
    return await store.readThread(clientThreadId);
  } finally {
    store.close();
  }
}

export { ThreadEventStoreError } from "./errors.js";
export type {
  AppendThreadEventsResult,
  CanonicalChunk,
  CanonicalTurn,
  ChunkLowerBandCompressionProvider,
  ChunkPolicy,
  CreateThreadResult,
  ProcessTurnEndTriggerResult,
  ProjectedMessage,
  ProjectedMessageBlock,
  ProjectedMessageWithBlocks,
  ProjectedThread,
  ProjectedThreadRead,
  ThreadEventStoreOptions,
  TurnLowerBandProjectionTokenCounter,
  TurnProcessingTrigger,
  TurnSmoothingProvider,
} from "./types.js";
