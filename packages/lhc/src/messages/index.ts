import { existsSync } from "node:fs";
import {
  runInTransaction,
  runWithThreadTouchSuppressed,
  type OperationContext,
} from "../shared-tech/index.js";
import type { DerivationReportEntry, WorkHandler } from "../shared-tech/index.js";
import { storageFailure, type ErrorResult, type OpResult } from "../shared-tech/index.js";
import {
  enqueue,
  hasLiveItem,
  listItems,
  type WorkItemRecord,
  type WorkKind,
} from "../shared-tech/work-queue/index.js";
import type { EventKind, EventRecord } from "../intake-stream/index.js";
import {
  openThreadDatabase,
  resolveThreadRef,
  type ThreadRef,
} from "../threads/index.js";
import type { Derivation, ResolvedSdkConfig } from "../shared-tech/index.js";
import { truncateForFallback } from "../shared-tech/index.js";
import { estimateTokens } from "../shared-tech/token-counting/index.js";
import { readMessageDerivationRow, readMessageDerivations, reportMessageDerivations } from "./internal/derivations.js";
import { messageWorkHandlers } from "./internal/handlers.js";
export { cleanPrompt } from "./internal/smoothing.js";
import { projectEvent } from "./internal/project.js";
import {
  cascadeFromMessage,
  cascadeMessageDelete,
  cascadeTurnDelete,
  type CascadeClear,
  type CascadeOutcome,
} from "./internal/cascade.js";
import {
  applyMessageEdit,
  insertMessage,
  markMessageDeleted,
  markTurnMessagesDeleted,
  readMessageById,
  readMessages,
  readMutableMessage,
} from "./internal/store.js";

export type BlockType =
  | "text"
  | "tool_call"
  | "tool_result"
  | "model_change"
  | "thinking_level_change";

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
  turnId?: string;
  // The message's derived derivations as stored (Epic 02 Story 2): present only
  // for messages that are derivation sources — kinds with no derivable derivation
  // carry no rows and no key (AC-2.7). Stored state returned verbatim,
  // never re-derived on read.
  derivations?: Derivation[];
  // The deleted-audit marker (Epic 04 AC-3.3): present (true) only on
  // deleted records, which only the includeDeleted listing and the show
  // read ever surface — a default list never carries the key.
  deleted?: boolean;
}

// The event as the walk holds it after recording: the validated input plus
// its server-stamped order and timestamp.
export type RecordedEvent = EventRecord;

export type MessageCreated = {
  messageId: string;
  kind: Exclude<EventKind, "turn_end">;
  // Carried for tool activity only: the pairing key the queue sites need —
  // tool_result projection runs the AC-2.8 late-result lookup against it.
  toolCallId?: string;
} | null;

// Cross-domain surface, called by intake-stream inside the batch transaction
// (the first such call through the operation context; turns.applyEvent
// follows the pattern in Story 4). Synchronous and throwing by design: a
// projection failure propagates to the pipeline's catch and rejects the
// whole batch — recorded events without messages is the stranded state the
// transaction exists to prevent. Returns null for turn_end (no message).
// turnId is the membership stamp, settled by the pipeline before this call:
// the turn open *after* this event's transition (so a prompt belongs to the
// turn it just opened), or null in a gap — written once, never updated.
export function createFromEvent(
  ctx: OperationContext,
  event: RecordedEvent,
  turnId: string | null,
): MessageCreated {
  const projected = projectEvent(event);
  if (projected === null) return null;
  const kind = event.eventKind as Exclude<EventKind, "turn_end">;
  const messageId = `m${event.eventOrder}`;
  insertMessage(ctx.db, {
    messageId,
    sourceEventOrder: event.eventOrder,
    kind,
    tokenEstimate: projected.tokenEstimate,
    actor: event.actor,
    harness: event.harness,
    turnId,
    blocks: projected.blocks,
  });
  if (event.eventKind === "tool_call" || event.eventKind === "tool_result") {
    return { messageId, kind, toolCallId: event.payload.toolCallId };
  }
  return { messageId, kind };
}

// The kind gate, exact by design: a prompt queues prompt_smoothing, a tool
// result queues tool_result_summary, nothing else queues anything —
// text, thinking, and note messages are not derivation sources (Epic 01
// AC-2.8/TC-2.9; Epic 02 AC-2.2/AC-2.7). Cross-domain surface, called by
// intake-stream inside the batch transaction for every recorded message, so
// the item commits (or rolls back) with the batch.
const MESSAGE_WORK_KINDS: Partial<Record<EventKind, WorkKind>> = {
  user_prompt: "prompt_smoothing",
  tool_result: "tool_result_summary",
};

// Which derived derivation each message-owned kind produces — the owning domain's
// knowledge, handed to the meaning-blind enqueue so the derivation's pending row
// rides the same transaction (DD-5).
const MESSAGE_WORK_DERIVATIONS: Partial<Record<WorkKind, string>> = {
  prompt_smoothing: "smoothed_prompt",
  tool_result_summary: "tool_result_summary",
};

const DEFAULT_TOOL_RESULT_CONFIG: ResolvedSdkConfig["toolResult"] = {
  smallTierTokens: 1000,
  largeTierTokens: 5000,
  smallTargetRatio: 0.15,
  midTargetRatio: 0.04,
};

function writeLargeToolResultSummaryReady(
  ctx: OperationContext,
  messageId: string,
  config: ResolvedSdkConfig["toolResult"],
): boolean {
  const row = ctx.db
    .prepare(
      `SELECT content FROM message_block
       WHERE message_id = ? AND block_type = 'tool_result'
       ORDER BY block_index LIMIT 1`,
    )
    .get(messageId) as { content: string } | undefined;
  if (row === undefined) return false;
  const block = JSON.parse(row.content) as Record<string, unknown>;
  const content = block["content"];
  if (typeof content !== "string") return false;
  if (estimateTokens(content) <= config.largeTierTokens) return false;
  const metadata = JSON.stringify({ outcome: block["isError"] === true ? "failed" : "succeeded" });
  ctx.db
    .prepare(
      `INSERT INTO derivation
         (subject_kind, subject_id, derivation_type, state, content, metadata, source_version, derived_at)
       VALUES ('message', ?, 'tool_result_summary', 'ready', ?, ?, 1, ?)`,
    )
    .run(messageId, truncateForFallback(content), metadata, ctx.clock().toISOString());
  return true;
}

// Message-owned work handlers, merged into the SDK's dispatch map at
// construction (DD-6): prompt smoothing and tool-result summaries.
export const workHandlers: Readonly<Partial<Record<WorkKind, WorkHandler>>> =
  messageWorkHandlers;

export function queueMessageWork(
  ctx: OperationContext,
  message: MessageCreated,
  toolResultConfig: ResolvedSdkConfig["toolResult"] = DEFAULT_TOOL_RESULT_CONFIG,
): WorkItemRecord[] {
  if (message === null) return [];
  const items: WorkItemRecord[] = [];
  const kind = MESSAGE_WORK_KINDS[message.kind];
  if (kind !== undefined) {
    if (
      message.kind === "tool_result" &&
      writeLargeToolResultSummaryReady(ctx, message.messageId, toolResultConfig)
    ) {
      return items;
    }
    const derivation = MESSAGE_WORK_DERIVATIONS[kind];
    if (derivation === undefined) {
      // Every queuing kind names its derivation above; a miss is a wiring bug.
      throw new Error(`no derived derivation mapped for message work kind ${kind}`);
    }
    items.push(
      enqueue(ctx, {
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

// Bounded-listing options (Epic 04 Story 1, DD-3): from/to are
// source-event-order bounds, limit caps the count after bounds,
// includeDeleted is the audit opt-in. All optional — existing callers see
// identical results (visible messages, unbounded, record order).
export interface MessageListOptions {
  from?: number;
  to?: number;
  limit?: number;
  includeDeleted?: boolean;
}

function invalidBounds(reason: string): ErrorResult {
  return { errorClass: "caller_error", code: "invalid_bounds", reason };
}

// Bounds mistakes are operational caller errors returned as results (tech
// design §Interface Definitions: from > to, limit < 1) — never a silent
// empty list a caller could mistake for an empty window.
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

// Reads-only is structural, not disciplined (DD-6, SV-01-001): the whole
// operation runs in the touch-suppressed scope, so openThreadDatabase's open
// announcement (openThreadDatabase → fireThreadTouch → scheduler.touch) can
// never let a background SDK's scheduler hang a first-touch catch-up drain —
// and the provider call that drain would make — off this read. A list calls
// no provider and schedules no work in either host mode.
export function listMessages(
  thread: ThreadRef,
  opts?: MessageListOptions,
): Promise<OpResult<MessageRecord[]>> {
  return runWithThreadTouchSuppressed(() => listMessagesInner(thread, opts));
}

async function listMessagesInner(
  thread: ThreadRef,
  opts?: MessageListOptions,
): Promise<OpResult<MessageRecord[]>> {
  if (opts !== undefined) {
    const badBounds = validateListOptions(opts);
    if (badBounds !== undefined) return { ok: false, error: badBounds };
  }
  const resolved = await resolveThreadRef(thread);
  if (!resolved.ok) return resolved;
  const { filePath } = resolved.value;
  if (!existsSync(filePath)) return threadNotFound(filePath);

  // openThreadDatabase verifies the file is a real thread file and migrates
  // a pre-Story-3 one before the read, so a thread recorded under an earlier
  // story lists cleanly (F-03-001) and a non-thread file is rejected
  // unmutated (F-03-002).
  const opened = openThreadDatabase(filePath);
  if (!opened.ok) return opened;
  const db = opened.value;
  try {
    // Bounds resolve the window first (AC-3.1 no-load-everything), then the
    // derivation read-back rides only that window (AC-2.1): each record carries its
    // stored derived derivations, attached from one grouped query scoped to the
    // listed ids — never every message-owned derivation in a large thread.
    const records = readMessages(db, opts ?? {});
    const derivationsByMessage = readMessageDerivations(
      db,
      records.map((record) => record.messageId),
    );
    const withDerivations = records.map((record) => {
      const derivations = derivationsByMessage.get(record.messageId);
      return derivations === undefined ? record : { ...record, derivations };
    });
    return { ok: true, value: withDerivations };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return storageFailure(`message read-back failed: ${reason}`);
  } finally {
    db.close();
  }
}

// The single-message view (Epic 04 AC-3.2): the canonical record — every
// block with complete content, full tool results, never the view-shortened
// derivations — plus the message's derivation derivations with their states and
// mechanically stamped metadata, joined from the owner's report read.
export interface MessageDetail extends Omit<MessageRecord, "derivations"> {
  // Always present and honest (AC-3.3): show on a deleted message returns
  // the record flagged — audit is the point — never a not-found.
  deleted: boolean;
  // The owner report's queue-joined entries (DD-2), never synthesized here:
  // the same `reportMessageDerivations` read messages.report serves, scoped by id.
  derivations: DerivationReportEntry[];
}

// Reads-only is structural (DD-6, SV-01-001), exactly as listMessages: the
// open announcement that would let a background scheduler hang a first-touch
// catch-up drain (and its provider call) off this show is suppressed for the
// whole operation. show on a deleted message stays the audit read; neither
// path touches the queue or the provider.
export function show(
  thread: ThreadRef,
  messageId: string,
): Promise<OpResult<MessageDetail>> {
  return runWithThreadTouchSuppressed(() => showInner(thread, messageId));
}

async function showInner(
  thread: ThreadRef,
  messageId: string,
): Promise<OpResult<MessageDetail>> {
  const resolved = await resolveThreadRef(thread);
  if (!resolved.ok) return resolved;
  const { filePath } = resolved.value;
  if (!existsSync(filePath)) return threadNotFound(filePath);

  const opened = openThreadDatabase(filePath);
  if (!opened.ok) return opened;
  const db = opened.value;
  try {
    const record = readMessageById(db, messageId);
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
    const derivations = reportMessageDerivations(db, { messageId });
    return { ok: true, value: { ...record, derivations } };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return storageFailure(`message show failed: ${reason}`);
  } finally {
    db.close();
  }
}

export async function listQueuedWork(
  thread: ThreadRef,
): Promise<OpResult<WorkItemRecord[]>> {
  const resolved = await resolveThreadRef(thread);
  if (!resolved.ok) return resolved;
  const { filePath } = resolved.value;
  if (!existsSync(filePath)) return threadNotFound(filePath);

  const opened = openThreadDatabase(filePath);
  if (!opened.ok) return opened;
  const db = opened.value;
  try {
    return { ok: true, value: listItems(db, "messages") };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return storageFailure(`queued-work read-back failed: ${reason}`);
  } finally {
    db.close();
  }
}

// ── report and repair (Epic 02 Story 4, Flow 4) ──────────────────

// This owner's repair report: every message-owned derivation's durable state
// joined with live queue detail in one query — the five operational
// situations (waiting, retrying, ready, failed, blocked) read from the rows
// without any queue API. Needs no provider; reads degrade, never block.
export async function report(
  thread: ThreadRef,
  opts?: { notReady?: boolean; messageId?: string },
): Promise<OpResult<DerivationReportEntry[]>> {
  const resolved = await resolveThreadRef(thread);
  if (!resolved.ok) return resolved;
  const { filePath } = resolved.value;
  if (!existsSync(filePath)) return threadNotFound(filePath);

  const opened = openThreadDatabase(filePath);
  if (!opened.ok) return opened;
  const db = opened.value;
  try {
    return { ok: true, value: reportMessageDerivations(db, opts ?? {}) };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return storageFailure(`report read failed: ${reason}`);
  } finally {
    db.close();
  }
}

export type RequeueOutcome = { workItemId: string } | { noop: "already_queued" };

// Which work kind rebuilds each message-owned derivation — MESSAGE_WORK_DERIVATIONS
// inverted; the requeue's join from the named derivation back to its queue site.
const MESSAGE_DERIVATION_KINDS: Partial<Record<string, WorkKind>> = {
  smoothed_prompt: "prompt_smoothing",
  tool_result_summary: "tool_result_summary",
};

// Explicit re-queue through the owning surface (AC-4.4): the public,
// supported rebuild act. Refused for blocked derivations with the derivation's stored
// damage reason (AC-4.6) and for missing rows; a no-op against work already
// queued or in flight at the derivation's current source version (AC-4.5).
// Otherwise the derivation clears to pending and re-enqueues at the next source
// version — the same enqueue path intake uses, poke-on-commit included, so
// background mode processes the repair with no further call. The no-op check
// and the enqueue commit in one transaction (anti-shim: a split would
// reintroduce the duplicate-work race).
export async function requeue(
  thread: ThreadRef,
  target: { messageId: string; derivationType: string },
): Promise<OpResult<RequeueOutcome>> {
  const kind = MESSAGE_DERIVATION_KINDS[target.derivationType];
  if (kind === undefined) {
    return {
      ok: false,
      error: {
        errorClass: "caller_error",
        code: "message_not_found",
        reason: `derivation ${target.derivationType} is not message-owned; messages.requeue repairs smoothed_prompt, tool_result_summary`,
      },
    };
  }
  const resolved = await resolveThreadRef(thread);
  if (!resolved.ok) return resolved;
  const { filePath } = resolved.value;
  if (!existsSync(filePath)) return threadNotFound(filePath);

  const opened = openThreadDatabase(filePath);
  if (!opened.ok) return opened;
  const db = opened.value;
  try {
    const meta = db
      .prepare(`SELECT thread_id FROM thread_metadata WHERE id = 1`)
      .get() as { thread_id: string } | undefined;
    const threadId = meta?.thread_id ?? "";
    return runInTransaction(db, () => new Date(), threadId, (ctx): OpResult<RequeueOutcome> => {
      const row = readMessageDerivationRow(ctx.db, target.messageId, target.derivationType);
      if (row === undefined) {
        return {
          ok: false,
          error: {
            errorClass: "caller_error",
            code: "message_not_found",
            reason: `no derived derivation ${target.derivationType} exists for message ${target.messageId}`,
          },
        };
      }
      if (row.state === "blocked") {
        // The refusal carries the derivation's stored reason — the damage named at
        // blocking time, not a generic string (AC-4.6).
        return {
          ok: false,
          error: {
            errorClass: "state_corruption",
            code: "source_damaged",
            reason: row.reason ?? `derivation ${target.derivationType} for message ${target.messageId} is blocked`,
          },
        };
      }
      const sourceRef = { messageId: target.messageId };
      if (hasLiveItem(ctx.db, kind, sourceRef, row.sourceVersion)) {
        return { ok: true, value: { noop: "already_queued" } };
      }
      const item = enqueue(ctx, {
        owner: "messages",
        kind,
        sourceRef,
        sourceVersion: row.sourceVersion + 1,
        derivations: [{ subjectKind: "message", subjectId: target.messageId, derivationType: target.derivationType }],
      });
      return { ok: true, value: { workItemId: item.workItemId } };
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return storageFailure(`requeue failed: ${reason}`);
  } finally {
    db.close();
  }
}

// ── mutations (Epic 02 Story 5, Flow 5) ──────────────────────────

// The mutation result contract (tech design §Interfaces): what changed in
// the record, which dependent derivations cleared, which dropped (delete only),
// what replacement work queued, and which still-queued old items the cascade
// tidied away (issue 1). Shared by edit and the Story 6 deletes.
export interface MutationResult {
  changed: { messageIds: string[]; turnIds: string[] };
  cleared: CascadeClear[];
  dropped: CascadeClear[];
  queued: Array<{ workItemId: string; kind: WorkKind }>;
  superseded: string[];
}

// The record's first sanctioned mutation (AC-5.1–5.5): change a closed-turn
// message's content and blocks, re-stamp the token estimate, and walk the
// full dependent chain — clear to pending, supersede queued old work,
// enqueue replacements at the next source version — in one transaction.
// Synchronous and local by contract: everything above commits before this
// returns; the re-queued rebuilds run through the normal drain (background
// mode needs no further call — the enqueue pokes ride the commit). Events
// are never touched (projection-level mutation, DD-12), and no generated
// thread-view is either — visibility arrives at the next compact/rebuild.
// Refusals read through the deleted-filtered view and enforce the closed-turn
// target boundary: only a message in a closed turn is editable, so an
// open-turn *or* a turnless (no-membership) gap target is refused turn_open —
// the boundary's one stable code — a missing or deleted message is
// message_not_found, and a refusal changes nothing.
export async function edit(
  thread: ThreadRef,
  input: { messageId: string; content: string },
): Promise<OpResult<MutationResult>> {
  const resolved = await resolveThreadRef(thread);
  if (!resolved.ok) return resolved;
  const { filePath } = resolved.value;
  if (!existsSync(filePath)) return threadNotFound(filePath);

  const opened = openThreadDatabase(filePath);
  if (!opened.ok) return opened;
  const db = opened.value;
  try {
    const meta = db
      .prepare(`SELECT thread_id FROM thread_metadata WHERE id = 1`)
      .get() as { thread_id: string } | undefined;
    const threadId = meta?.thread_id ?? "";
    return runInTransaction(db, () => new Date(), threadId, (ctx): OpResult<MutationResult> => {
      const target = readMutableMessage(ctx.db, input.messageId);
      if (target === undefined) {
        return {
          ok: false,
          error: {
            errorClass: "caller_error",
            code: "message_not_found",
            reason: `no message ${input.messageId} exists in this thread`,
          },
        };
      }
      // The closed-turn target boundary (story scope; AC-5.1): the edit's
      // editable class is a message in a *closed* turn. Both failing cases —
      // an open turn and a turnless gap message (no membership) — refuse under
      // the one stable code; the reason distinguishes them so the open-turn
      // message reads exactly as before. A deleted/missing target never gets
      // here (it misses the filtered read above as message_not_found).
      if (target.turnStatus !== "closed") {
        return {
          ok: false,
          error: {
            errorClass: "caller_error",
            code: "turn_open",
            reason:
              target.turnStatus === "open"
                ? `message ${input.messageId} belongs to open turn ${target.turnId ?? ""}; open-turn messages cannot be edited (v1 boundary)`
                : `message ${input.messageId} has no turn membership; only closed-turn messages can be edited (v1 boundary)`,
          },
        };
      }
      applyMessageEdit(ctx.db, input.messageId, input.content);
      const cascade = cascadeFromMessage(ctx, input.messageId);
      return {
        ok: true,
        value: {
          changed: { messageIds: [input.messageId], turnIds: [] },
          cleared: cascade.cleared,
          dropped: cascade.dropped,
          queued: cascade.queued,
          superseded: cascade.superseded,
        },
      };
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return storageFailure(`edit failed: ${reason}`);
  } finally {
    db.close();
  }
}

// ── delete (Epic 02 Story 6, Flow 6) ─────────────────────────────

// The record's removal mutation for one message (AC-6.1–6.3, 6.7):
// projection-level delete — the deleted_at stamp plus the delete cascade
// (own derivations dropped, turn and chunk cleared and re-queued for minus-one
// composition) in one transaction. The source events are never touched;
// event read-back keeps returning them (the audit surface). Validation
// reads the same filtered view as edit, so a missing, deleted, or
// double-deleted target is message_not_found and an open-turn or turnless
// gap target is turn_open. The one delete-specific refusal is prompt
// protection: a turn is a prompt and what came back for it, so deleting the
// turn's initiating prompt is refused toward turns.deleteTurn — the error
// names the turn and that path (AC-6.3).
export async function deleteMessage(
  thread: ThreadRef,
  input: { messageId: string },
): Promise<OpResult<MutationResult>> {
  const resolved = await resolveThreadRef(thread);
  if (!resolved.ok) return resolved;
  const { filePath } = resolved.value;
  if (!existsSync(filePath)) return threadNotFound(filePath);

  const opened = openThreadDatabase(filePath);
  if (!opened.ok) return opened;
  const db = opened.value;
  try {
    const meta = db
      .prepare(`SELECT thread_id FROM thread_metadata WHERE id = 1`)
      .get() as { thread_id: string } | undefined;
    const threadId = meta?.thread_id ?? "";
    return runInTransaction(db, () => new Date(), threadId, (ctx): OpResult<MutationResult> => {
      const target = readMutableMessage(ctx.db, input.messageId);
      if (target === undefined) {
        return {
          ok: false,
          error: {
            errorClass: "caller_error",
            code: "message_not_found",
            reason: `no message ${input.messageId} exists in this thread`,
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
                ? `message ${input.messageId} belongs to open turn ${target.turnId ?? ""}; open-turn messages cannot be deleted (v1 boundary)`
                : `message ${input.messageId} has no turn membership; only closed-turn messages can be deleted (v1 boundary)`,
          },
        };
      }
      if (target.initiatesTurn) {
        return {
          ok: false,
          error: {
            errorClass: "caller_error",
            code: "message_initiates_turn",
            reason: `message ${input.messageId} is the prompt that initiates turn ${target.turnId ?? ""}; a turn is a prompt and what came back for it — delete the whole exchange with turns.deleteTurn (lhc turns delete --turn-id ${target.turnId ?? ""})`,
          },
        };
      }
      markMessageDeleted(ctx.db, input.messageId, ctx.clock().toISOString());
      const cascade = cascadeMessageDelete(ctx, input.messageId);
      return {
        ok: true,
        value: {
          changed: { messageIds: [input.messageId], turnIds: [] },
          cleared: cascade.cleared,
          dropped: cascade.dropped,
          queued: cascade.queued,
          superseded: cascade.superseded,
        },
      };
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return storageFailure(`delete failed: ${reason}`);
  } finally {
    db.close();
  }
}

// Cross-domain surface for turns.deleteTurn (DD-8: one cascade module, two
// callers), called inside the turn delete's transaction after the turn row
// is stamped. The messages domain owns the message-table write — the member
// stamp, scoped to live rows — and the shared cascade entry; the turns
// operation owns its own validation and turn-row stamp. Returns the cascade
// outcome plus the member ids stamped now (record order), which the turn
// delete reports as its changed messages.
export function applyTurnDeleteCascade(
  ctx: OperationContext,
  turnId: string,
): CascadeOutcome & { memberMessageIds: string[] } {
  const memberMessageIds = markTurnMessagesDeleted(
    ctx.db,
    turnId,
    ctx.clock().toISOString(),
  );
  return { ...cascadeTurnDelete(ctx, turnId, memberMessageIds), memberMessageIds };
}
