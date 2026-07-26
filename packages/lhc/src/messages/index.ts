import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { EventKind, EventRecord } from "../intake-stream/index.js";
import type { Derivation, DerivationReportEntry, HandlerRunContext } from "../shared-tech/index.js";
import {
  createDbReadTransaction,
  createDbWriteTransaction,
  type DbWriteTransaction,
  type ErrorResult,
  type OpResult,
  resolveInstanceConfig,
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

export type BlockType = "text" | "tool_call" | "tool_result" | "model_change" | "thinking_level_change";

export interface Block {
  blockType: BlockType;
  content: Record<string, unknown>; // per-kind shape as projected, verbatim source content
}

export interface MessageRecord {
  messageId: string;
  sourceEventOrder: number;
  kind: Exclude<EventKind, "turn_end">;
  blocks: Block[];
  tokenEstimate: number;
  actor: string;
  harness: string;
  // The source event's recorded_at: when the event that produced this message
  // was durably recorded. Part of the message's source-event identity (it
  // pairs with sourceEventOrder), read from the durable event, never a
  // read-time clock.
  recordedAt: string;
  turnId: string;
  // Host-observed provider usage from assistant_text (schema v5). Absent when
  // the source event did not carry it (other kinds, pre-v5 rows, hosts that omit).
  providerUsage?: Record<string, unknown>;
  // Stored derivations for messages that are derivation sources. Kinds with no
  // derivable output carry no rows and no key. Stored state is returned
  // verbatim, never re-derived on read.
  derivations?: Derivation[];
  // The deleted-audit marker is present only on deleted records, which only
  // the includeDeleted listing and show read ever surface. A default list never
  // carries the key.
  deleted?: boolean;
}

// The event as the walk holds it after recording: the validated input plus
// its server-stamped order and timestamp.
export type RecordedEvent = EventRecord;

export type MessageCreated = {
  messageId: string;
  kind: Exclude<EventKind, "turn_end">;
  // Carried for tool activity only: the pairing key the queue sites need —
  // tool_result handling runs late-result lookup against it.
  toolCallId?: string;
} | null;

export interface MessageCreateResult {
  message: MessageCreated;
  queuedWork: WorkItemRecord[];
}

// Cross-domain surface, called by intake-stream inside the batch transaction.
// Synchronous and throwing by design: message creation failure propagates to the
// pipeline's catch and rejects the whole batch. Recorded events without
// messages is the stranded state the transaction exists to prevent. Returns
// null for turn_end (no message).
// turnId is the membership stamp, settled by the pipeline before this call:
// the current open turn after this event's turn intake. Written once, never
// updated.
export function create(
  transaction: DbWriteTransaction,
  recordedEvent: RecordedEvent,
  turnId: string,
): MessageCreateResult {
  const projected = projectEvent(recordedEvent);
  if (projected === null) return { message: null, queuedWork: [] };
  const kind = recordedEvent.eventKind as Exclude<EventKind, "turn_end">;
  const messageId = `m${recordedEvent.eventOrder}`;
  // providerUsage rides assistant_text only; projectEvent leaves it on the
  // event payload and storage writes it as a message column (not a block).
  // exactOptionalPropertyTypes: omit the key when absent — do not pass undefined.
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
  insertMessage(transaction.db, row);
  const message =
    recordedEvent.eventKind === "tool_call" || recordedEvent.eventKind === "tool_result"
      ? { messageId, kind, toolCallId: recordedEvent.payload.toolCallId }
      : { messageId, kind };
  return { message, queuedWork: queueMessageWork(transaction, message) };
}

// The kind gate, exact by design: a prompt queues prompt_smoothing, a tool
// result queues tool_result_summary, nothing else queues anything —
// text, thinking, and note messages are not derivation sources. Cross-domain
// surface, called by intake-stream inside the batch transaction for every
// recorded message, so the item commits (or rolls back) with the batch.
function queueMessageWork(transaction: DbWriteTransaction, message: MessageCreated): WorkItemRecord[] {
  if (message === null) return [];
  const items: WorkItemRecord[] = [];
  const kind = MESSAGE_WORK_KINDS[message.kind];
  if (kind !== undefined) {
    const derivation = MESSAGE_WORK_DERIVATIONS[kind];
    if (derivation === undefined) {
      // Every queuing kind names its derivation above; a miss is a wiring bug.
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

// Bounded-listing options: from/to are source-event-order bounds, limit caps
// the count after bounds, includeDeleted is the audit opt-in. All optional:
// existing callers see visible messages, unbounded, in record order.
export interface MessageListOptions {
  from?: number;
  to?: number;
  limit?: number;
  includeDeleted?: boolean;
}

function invalidBounds(reason: string): ErrorResult {
  return { errorClass: "caller_error", code: "invalid_bounds", reason };
}

// Bounds mistakes are operational caller errors returned as results, never a
// silent empty list a caller could mistake for an empty window.
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
      // Bounds resolve the window first, then derivation read-back rides only
      // that window: each record carries its stored derivations, attached from
      // one grouped query scoped to the listed ids, never every message-owned
      // derivation in a large thread.
      const records = readMessages(transaction.db, filter ?? {});
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

// In-transaction read for coordinators that already hold an open thread
// handle (thread-view's compact selection): the live message records in
// source order with their projected blocks, so thread-view asks the messages
// owner for its records instead of reading the message tables itself. The
// async `list` is the threadRef-scoped surface for normal callers; this is
// the same record set on a caller-owned handle, mirroring turns.getChunkText.
export function readLiveMessages(db: DatabaseSync): MessageRecord[] {
  return readMessages(db, {});
}

// The single-message view returns the canonical record: every block with
// complete content, full tool results, never view-shortened derivations. It
// also joins message derivations with their states and mechanically stamped
// metadata from the owner's report read.
export interface MessageDetail extends Omit<MessageRecord, "derivations"> {
  // Always present and honest: show on a deleted message returns the record
  // flagged, never not-found.
  deleted: boolean;
  // The owner report's queue-joined entries, never synthesized here: the same
  // `reportMessageDerivations` read messages.report serves, scoped by id.
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

// ── report and repair ────────────────────────────────────────────

// This owner's repair report: every message-owned derivation's durable state
// joined with live queue detail in one query — the five operational
// situations (pending, ready, failed, blocked) read from the rows
// without any queue API. Needs no inference; reads degrade, never block.
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

// Synchronous message-owned derivation. For each message id, the domain
// selects the one message-owned derivation implied by the stored message kind
// (`user_prompt` -> `smoothed_prompt`, `tool_result` -> `tool_result_summary`),
// runs the existing handler, and lands the normal version-checked derivation
// write before returning. Non-derivable message kinds return `not_derivable`;
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

// ── mutations ────────────────────────────────────────────────────

// The mutation result contract: what changed in the record, which dependent
// derivations cleared, which dropped (delete only), what replacement work
// queued, and which still-queued old items the cascade tidied away. Shared by
// edit and delete.
export interface MutationResult {
  changed: { messageIds: string[]; turnIds: string[] };
  cleared: CascadeClear[];
  dropped: CascadeClear[];
  queued: Array<{ workItemId: string; kind: WorkKind }>;
  superseded: string[];
}

// Editing changes a closed-turn message's content and blocks, re-stamps the
// token estimate, and walks the full dependent chain: clear to pending,
// supersede queued old work, and enqueue replacements at the next source
// version in one transaction.
// Synchronous and local by contract: everything above commits before this
// returns; the re-queued rebuilds run through the normal drain (background
// mode needs no further call — the enqueue pokes ride the commit). Events
// are never touched, and no generated thread-view is either — visibility
// arrives at the next compact/rebuild.
// Refusals read through the deleted-filtered view and enforce the closed-turn
// target boundary: only a message in a closed turn is editable. An open-turn
// message is refused as turn_open, a missing or deleted message is
// message_not_found, and a refusal changes nothing.
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
      applyMessageEdit(transaction.db, edit.messageId, edit.content);
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

// ── delete ───────────────────────────────────────────────────────

// Delete is message-record level: the deleted_at stamp plus the delete cascade
// (own derivations dropped, turn and chunk cleared and re-queued for minus-one
// composition) land in one transaction. The source events are never touched;
// event read-back keeps returning them. Validation reads the same filtered view
// as edit, so a missing, deleted, or double-deleted target is message_not_found
// and an open-turn target is turn_open. The delete-specific refusal is prompt
// protection: deleting the turn's initiating prompt is refused because
// initiating-prompt and whole-turn delete are unsupported.
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
