import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { EventKind, EventRecord } from "../intake-stream/index.js";
import type { ApiBlockType, Derivation, DerivationReportEntry, HandlerRunContext } from "../shared-tech/index.js";
import {
  createDbReadTransaction,
  createDbWriteTransaction,
  type DbWriteTransaction,
  type ErrorResult,
  type OpResult,
  resolveInstanceConfig,
  resolveInstanceTokenEstimator,
  storageFailure,
} from "../shared-tech/index.js";
import { enqueue, type WorkItemRecord, type WorkKind } from "../shared-tech/work-queue/index.js";
import { openThreadDatabase, resolveThreadRef, type ThreadRef } from "../threads/index.js";
import { readMessageDerivations, reportMessageDerivations } from "./internal/derivations.js";
import { deriveMessageInThread, type MessageDeriveResult } from "./internal/derive.js";
import { MESSAGE_WORK_DERIVATIONS, MESSAGE_WORK_KINDS } from "./internal/work.js";

export { cleanPrompt } from "./internal/smoothing.js";

import { type CascadeClear, cascadeFromMessage, cascadeMessageDelete } from "./internal/cascade.js";
import { projectEvent } from "./internal/project.js";
import {
  applyMessageEdit,
  insertMessage,
  markMessageDeleted,
  readMessageById,
  readMessages,
  readMutableMessage,
} from "./internal/store.js";

export type BlockType =
  | "text"
  | "tool_call"
  | "tool_result"
  | "model_change"
  | "thinking_level_change"
  | "compact_continuation_marker"
  | ApiBlockType;

export interface Block {
  blockType: BlockType;
  content: Record<string, unknown>;
}

export interface MessageRecord {
  messageId: string;
  sourceEventOrder: number;
  kind: Exclude<EventKind, "turn_end" | "rollback">;
  blocks: Block[];
  tokenEstimate: number;
  actor: string;
  harness: string;
  recordedAt: string;
  turnId: string;
  providerUsage?: Record<string, unknown>;
  stepIndex?: number;
  derivations?: Derivation[];
  deleted?: boolean;
}

export type RecordedEvent = EventRecord;

export type MessageCreated = {
  messageId: string;
  kind: Exclude<EventKind, "turn_end" | "rollback">;
  toolCallId?: string;
} | null;

export interface MessageCreateResult {
  message: MessageCreated;
  queuedWork: WorkItemRecord[];
}

export function create(
  transaction: DbWriteTransaction,
  recordedEvent: RecordedEvent,
  turnId: string,
): MessageCreateResult {
  const projected = projectEvent(recordedEvent, resolveInstanceTokenEstimator("messages.create"));
  if (projected === null) return { message: null, queuedWork: [] };
  const kind = recordedEvent.eventKind as Exclude<EventKind, "turn_end" | "rollback">;
  const messageId = `m${recordedEvent.eventOrder}`;
  const row: Parameters<typeof insertMessage>[1] = {
    messageId,
    sourceEventOrder: recordedEvent.eventOrder,
    kind,
    tokenEstimate: projected.tokenEstimate,
    actor: recordedEvent.actor,
    harness: recordedEvent.harness,
    turnId,
    blocks: projected.blocks,
  };
  if (recordedEvent.eventKind === "assistant_text" && recordedEvent.payload.providerUsage !== undefined) {
    row.providerUsage = recordedEvent.payload.providerUsage;
  }
  if (
    (recordedEvent.eventKind === "assistant_text" ||
      recordedEvent.eventKind === "assistant_thinking" ||
      recordedEvent.eventKind === "tool_call" ||
      recordedEvent.eventKind === "tool_result") &&
    recordedEvent.payload.stepIndex !== undefined
  ) {
    row.stepIndex = recordedEvent.payload.stepIndex;
  }
  insertMessage(transaction.db, row);
  const message =
    recordedEvent.eventKind === "tool_call" || recordedEvent.eventKind === "tool_result"
      ? { messageId, kind, toolCallId: recordedEvent.payload.toolCallId }
      : { messageId, kind };
  return { message, queuedWork: queueMessageWork(transaction, message) };
}

function queueMessageWork(transaction: DbWriteTransaction, message: MessageCreated): WorkItemRecord[] {
  if (message === null) return [];
  const items: WorkItemRecord[] = [];
  const kind = MESSAGE_WORK_KINDS[message.kind];
  if (kind !== undefined) {
    const derivation = MESSAGE_WORK_DERIVATIONS[kind];
    if (derivation === undefined) {
      throw new Error(`no derived derivation mapped for message work kind ${kind}`);
    }
    items.push(
      enqueue(transaction, {
        owner: "messages",
        kind,
        sourceRef: { messageId: message.messageId },
        derivations: [{ subjectKind: "message", subjectId: message.messageId, derivationType: derivation }],
      }),
    );
  }
  return items;
}

function threadNotFound(filePath: string): { ok: false; error: ErrorResult } {
  return {
    ok: false,
    error: {
      errorClass: "caller_error",
      code: "thread_not_found",
      reason: `no thread file exists at ${filePath}`,
    },
  };
}

export interface MessageListOptions {
  from?: number;
  to?: number;
  limit?: number;
  includeDeleted?: boolean;
  forUserChat?: boolean;
}

/** Message kinds present in the canonical record but hidden from ordinary user chat. */
export const USER_CHAT_HIDDEN_KINDS = ["compact_continuation_marker"] as const;

function invalidBounds(reason: string): ErrorResult {
  return { errorClass: "caller_error", code: "invalid_bounds", reason };
}

function validateListOptions(opts: MessageListOptions): ErrorResult | undefined {
  const integers: ReadonlyArray<readonly [string, number | undefined]> = [
    ["from", opts.from],
    ["to", opts.to],
    ["limit", opts.limit],
  ];
  for (const [name, value] of integers) {
    if (value !== undefined && !Number.isInteger(value)) {
      return invalidBounds(`${name} must be an integer, got ${value}`);
    }
  }
  if (opts.from !== undefined && opts.to !== undefined && opts.from > opts.to) {
    return invalidBounds(`from (${opts.from}) must not exceed to (${opts.to})`);
  }
  if (opts.limit !== undefined && opts.limit < 1) {
    return invalidBounds(`limit must be at least 1, got ${opts.limit}`);
  }
  return undefined;
}

export async function list(threadRef: ThreadRef, filter?: MessageListOptions): Promise<OpResult<MessageRecord[]>> {
  if (filter !== undefined) {
    const badBounds = validateListOptions(filter);
    if (badBounds !== undefined) return { ok: false, error: badBounds };
  }
  try {
    return await createDbReadTransaction(threadRef, (transaction) => {
      let records = readMessages(transaction.db, filter ?? {});
      if (filter?.forUserChat === true) {
        const hidden = new Set<string>(USER_CHAT_HIDDEN_KINDS);
        records = records.filter((record) => !hidden.has(record.kind));
      }
      const derivationsByMessage = readMessageDerivations(
        transaction.db,
        records.map((record) => record.messageId),
      );
      return records.map((record) => {
        const derivations = derivationsByMessage.get(record.messageId);
        return derivations === undefined ? record : { ...record, derivations };
      });
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return storageFailure(`message read-back failed: ${reason}`);
  }
}

export function readLiveMessages(db: DatabaseSync): MessageRecord[] {
  return readMessages(db, {});
}

export interface MessageDetail extends Omit<MessageRecord, "derivations"> {
  deleted: boolean;
  derivations: DerivationReportEntry[];
}

export async function show(threadRef: ThreadRef, messageId: string): Promise<OpResult<MessageDetail>> {
  try {
    const result = await createDbReadTransaction(threadRef, (transaction): OpResult<MessageDetail> => {
      const record = readMessageById(transaction.db, messageId);
      if (record === undefined) {
        return {
          ok: false,
          error: {
            errorClass: "caller_error",
            code: "message_not_found",
            reason: `no message ${messageId} exists in this thread`,
          },
        };
      }
      const derivations = reportMessageDerivations(transaction.db, { messageId });
      return { ok: true, value: { ...record, derivations } };
    });
    return result.ok ? result.value : result;
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return storageFailure(`message show failed: ${reason}`);
  }
}

export async function report(
  threadRef: ThreadRef,
  opts?: { notReady?: boolean; messageId?: string },
): Promise<OpResult<DerivationReportEntry[]>> {
  try {
    return await createDbReadTransaction(threadRef, (transaction) =>
      reportMessageDerivations(transaction.db, opts ?? {}),
    );
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return storageFailure(`report read failed: ${reason}`);
  }
}

export async function derive(threadRef: ThreadRef, messageIds: string[]): Promise<OpResult<MessageDeriveResult[]>> {
  const config = resolveInstanceConfig();
  if (config === undefined) {
    return {
      ok: false,
      error: {
        errorClass: "caller_error",
        code: "inference_unavailable",
        reason: "messages.derive requires an initialized LHC SDK inference configuration",
      },
    };
  }
  const resolved = await resolveThreadRef(threadRef);
  if (!resolved.ok) return resolved;
  const { filePath } = resolved.value;
  if (!existsSync(filePath)) return threadNotFound(filePath);

  const opened = openThreadDatabase(filePath);
  if (!opened.ok) return opened;
  const db = opened.value;
  try {
    const threadId = db.prepare(`SELECT thread_id FROM thread_metadata WHERE id = 1`).get() as
      | { thread_id: string }
      | undefined;
    if (threadId === undefined) return storageFailure(`thread file at ${filePath} lost its metadata row`);
    const run: HandlerRunContext = {
      threadId: threadId.thread_id,
      filePath,
      openDb: () => db,
      inferenceCallbacks: config.inferenceCallbacks,
      clock: config.clock,
      config,
    };
    const results: MessageDeriveResult[] = [];
    for (const messageId of messageIds) {
      results.push(await deriveMessageInThread(run, messageId));
    }
    return { ok: true, value: results };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return storageFailure(`derive failed: ${reason}`);
  } finally {
    db.close();
  }
}

export interface MutationResult {
  changed: { messageIds: string[]; turnIds: string[] };
  cleared: CascadeClear[];
  dropped: CascadeClear[];
  queued: Array<{ workItemId: string; kind: WorkKind }>;
  superseded: string[];
}

export async function edit(
  threadRef: ThreadRef,
  edit: { messageId: string; content: string },
): Promise<OpResult<MutationResult>> {
  try {
    const result = await createDbWriteTransaction(threadRef, (transaction): OpResult<MutationResult> => {
      const target = readMutableMessage(transaction.db, edit.messageId);
      if (target === undefined) {
        return {
          ok: false,
          error: {
            errorClass: "caller_error",
            code: "message_not_found",
            reason: `no message ${edit.messageId} exists in this thread`,
          },
        };
      }
      if (target.turnStatus !== "closed") {
        return {
          ok: false,
          error: {
            errorClass: "caller_error",
            code: "turn_open",
            reason:
              target.turnStatus === "open"
                ? `message ${edit.messageId} belongs to open turn ${target.turnId}; open-turn messages cannot be edited (v1 boundary)`
                : `message ${edit.messageId} references no readable turn; only closed-turn messages can be edited (v1 boundary)`,
          },
        };
      }
      applyMessageEdit(transaction.db, edit.messageId, edit.content, resolveInstanceTokenEstimator("messages.edit"));
      const cascade = cascadeFromMessage(transaction, edit.messageId);
      return {
        ok: true,
        value: {
          changed: { messageIds: [edit.messageId], turnIds: [] },
          cleared: cascade.cleared,
          dropped: cascade.dropped,
          queued: cascade.queued,
          superseded: cascade.superseded,
        },
      };
    });
    return result.ok ? result.value : result;
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return storageFailure(`edit failed: ${reason}`);
  }
}

export async function remove(threadRef: ThreadRef, removal: { messageId: string }): Promise<OpResult<MutationResult>> {
  try {
    const result = await createDbWriteTransaction(threadRef, (transaction): OpResult<MutationResult> => {
      const target = readMutableMessage(transaction.db, removal.messageId);
      if (target === undefined) {
        return {
          ok: false,
          error: {
            errorClass: "caller_error",
            code: "message_not_found",
            reason: `no message ${removal.messageId} exists in this thread`,
          },
        };
      }
      if (target.turnStatus !== "closed") {
        return {
          ok: false,
          error: {
            errorClass: "caller_error",
            code: "turn_open",
            reason:
              target.turnStatus === "open"
                ? `message ${removal.messageId} belongs to open turn ${target.turnId}; open-turn messages cannot be deleted (v1 boundary)`
                : `message ${removal.messageId} references no readable turn; only closed-turn messages can be deleted (v1 boundary)`,
          },
        };
      }
      if (target.initiatesTurn) {
        return {
          ok: false,
          error: {
            errorClass: "caller_error",
            code: "message_initiates_turn",
            reason: `message ${removal.messageId} is the prompt that initiates turn ${target.turnId}; deleting the initiating prompt or whole turn is not supported in this slice`,
          },
        };
      }
      markMessageDeleted(transaction.db, removal.messageId, transaction.clock().toISOString());
      const cascade = cascadeMessageDelete(transaction, removal.messageId);
      return {
        ok: true,
        value: {
          changed: { messageIds: [removal.messageId], turnIds: [] },
          cleared: cascade.cleared,
          dropped: cascade.dropped,
          queued: cascade.queued,
          superseded: cascade.superseded,
        },
      };
    });
    return result.ok ? result.value : result;
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return storageFailure(`delete failed: ${reason}`);
  }
}
