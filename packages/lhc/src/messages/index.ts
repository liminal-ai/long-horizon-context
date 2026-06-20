import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { EventKind, EventRecord } from "../intake-stream/index.js";
import type { Derivation, DerivationReportEntry, HandlerOutcome, ResolvedSdkConfig } from "../shared-tech/index.js";
import {
  type ErrorResult,
  type OperationContext,
  type OpResult,
  resolveInstanceConfig,
  runInTransaction,
  runWithThreadTouchSuppressed,
  storageFailure,
  truncateForFallback,
} from "../shared-tech/index.js";
import { estimateTokens } from "../shared-tech/token-counting/index.js";
import {
  type ClaimedWorkItem,
  complete,
  enqueue,
  failTerminal,
  hasLiveItem,
  type WorkItemRecord,
  type WorkKind,
} from "../shared-tech/work-queue/index.js";
import { openThreadDatabase, resolveThreadRef, type ThreadRef } from "../threads/index.js";
import { readMessageDerivationRow, readMessageDerivations, reportMessageDerivations } from "./internal/derivations.js";
import { messageWorkHandlers } from "./internal/handlers.js";

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

export interface MessageCreateResult {
  message: MessageCreated;
  queuedWork: WorkItemRecord[];
}

// Cross-domain surface, called by intake-stream inside the batch transaction.
// Synchronous and throwing by design: a
// projection failure propagates to the pipeline's catch and rejects the
// whole batch — recorded events without messages is the stranded state the
// transaction exists to prevent. Returns null for turn_end (no message).
// turnId is the membership stamp, settled by the pipeline before this call:
// the current open turn after this event's turn intake. Written once, never
// updated.
export function create(
  ctx: OperationContext,
  recordedEvent: RecordedEvent,
  turnId: string,
  toolResultConfig: ResolvedSdkConfig["toolResult"] = DEFAULT_TOOL_RESULT_CONFIG,
): MessageCreateResult {
  const projected = projectEvent(recordedEvent);
  if (projected === null) return { message: null, queuedWork: [] };
  const kind = recordedEvent.eventKind as Exclude<EventKind, "turn_end">;
  const messageId = `m${recordedEvent.eventOrder}`;
  insertMessage(ctx.db, {
    messageId,
    sourceEventOrder: recordedEvent.eventOrder,
    kind,
    tokenEstimate: projected.tokenEstimate,
    actor: recordedEvent.actor,
    harness: recordedEvent.harness,
    turnId,
    blocks: projected.blocks,
  });
  const message =
    recordedEvent.eventKind === "tool_call" || recordedEvent.eventKind === "tool_result"
      ? { messageId, kind, toolCallId: recordedEvent.payload.toolCallId }
      : { messageId, kind };
  return { message, queuedWork: queueMessageWork(ctx, message, toolResultConfig) };
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

function queueMessageWork(
  ctx: OperationContext,
  message: MessageCreated,
  toolResultConfig: ResolvedSdkConfig["toolResult"] = DEFAULT_TOOL_RESULT_CONFIG,
): WorkItemRecord[] {
  if (message === null) return [];
  const items: WorkItemRecord[] = [];
  const kind = MESSAGE_WORK_KINDS[message.kind];
  if (kind !== undefined) {
    if (message.kind === "tool_result" && writeLargeToolResultSummaryReady(ctx, message.messageId, toolResultConfig)) {
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
// and the inference call that drain would make — off this read. A list calls
// no inference and schedules no work in either host mode.
export function list(threadRef: ThreadRef, filter?: MessageListOptions): Promise<OpResult<MessageRecord[]>> {
  return runWithThreadTouchSuppressed(() => listInner(threadRef, filter));
}

async function listInner(threadRef: ThreadRef, filter?: MessageListOptions): Promise<OpResult<MessageRecord[]>> {
  if (filter !== undefined) {
    const badBounds = validateListOptions(filter);
    if (badBounds !== undefined) return { ok: false, error: badBounds };
  }
  const resolved = await resolveThreadRef(threadRef);
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
    const records = readMessages(db, filter ?? {});
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

// Reads-only is structural (DD-6, SV-01-001), exactly as list: the
// open announcement that would let a background scheduler hang a first-touch
// catch-up drain (and its inference call) off this show is suppressed for the
// whole operation. show on a deleted message stays the audit read; neither
// path touches the queue or inference callbacks.
export function show(threadRef: ThreadRef, messageId: string): Promise<OpResult<MessageDetail>> {
  return runWithThreadTouchSuppressed(() => showInner(threadRef, messageId));
}

async function showInner(threadRef: ThreadRef, messageId: string): Promise<OpResult<MessageDetail>> {
  const resolved = await resolveThreadRef(threadRef);
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

// ── report and repair (Epic 02 Story 4, Flow 4) ──────────────────

// This owner's repair report: every message-owned derivation's durable state
// joined with live queue detail in one query — the five operational
// situations (waiting, retrying, ready, failed, blocked) read from the rows
// without any queue API. Needs no inference; reads degrade, never block.
export async function report(
  threadRef: ThreadRef,
  opts?: { notReady?: boolean; messageId?: string },
): Promise<OpResult<DerivationReportEntry[]>> {
  const resolved = await resolveThreadRef(threadRef);
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

export type MessageDeriveResult =
  | {
      messageId: string;
      outcome: "derived";
      derivationType: "smoothed_prompt" | "tool_result_summary";
      sourceVersion: number;
    }
  | { messageId: string; outcome: "already_queued"; derivationType: "smoothed_prompt" | "tool_result_summary" }
  | { messageId: string; outcome: "not_derivable" }
  | { messageId: string; outcome: "failed"; error: ErrorResult };

function derivationForKind(
  kind: Exclude<EventKind, "turn_end">,
): { workKind: WorkKind; derivationType: "smoothed_prompt" | "tool_result_summary" } | undefined {
  const workKind = MESSAGE_WORK_KINDS[kind];
  if (workKind === undefined) return undefined;
  const derivationType = MESSAGE_WORK_DERIVATIONS[workKind] as "smoothed_prompt" | "tool_result_summary" | undefined;
  if (derivationType === undefined) {
    throw new Error(`no derived derivation mapped for message work kind ${workKind}`);
  }
  return { workKind, derivationType };
}

function sourceVersionForDerive(row: { sourceVersion: number; state: string } | undefined): number {
  if (row === undefined) return 1;
  return row.state === "pending" ? row.sourceVersion : row.sourceVersion + 1;
}

function prepareSyntheticItem(
  ctx: OperationContext,
  messageId: string,
  workKind: WorkKind,
  derivationType: "smoothed_prompt" | "tool_result_summary",
  sourceVersion: number,
): ClaimedWorkItem {
  ctx.db
    .prepare(
      `INSERT INTO derivation (subject_kind, subject_id, derivation_type, state, source_version)
       VALUES ('message', ?, ?, 'pending', ?)
       ON CONFLICT (subject_kind, subject_id, derivation_type) DO UPDATE SET
         state = 'pending', content = NULL, reason = NULL, metadata = NULL,
         gaps = NULL, derived_at = NULL, source_version = excluded.source_version`,
    )
    .run(messageId, derivationType, sourceVersion);
  return {
    workItemId: `sync-${messageId}-${workKind}-v${sourceVersion}`,
    owner: "messages",
    kind: workKind,
    sourceRef: { messageId },
    attempts: 0,
    queuedAt: ctx.clock().toISOString(),
    sourceVersion,
    derivations: [{ subjectKind: "message", subjectId: messageId, derivationType }],
  };
}

function failedDerive(messageId: string, error: ErrorResult): MessageDeriveResult {
  return { messageId, outcome: "failed", error };
}

async function runMessageDerivation(
  db: DatabaseSync,
  config: ResolvedSdkConfig,
  messageId: string,
): Promise<MessageDeriveResult> {
  const record = readMessageById(db, messageId);
  if (record === undefined || record.deleted === true) {
    return failedDerive(messageId, {
      errorClass: "caller_error",
      code: "message_not_found",
      reason: `no message ${messageId} exists in this thread`,
    });
  }
  const mapped = derivationForKind(record.kind);
  if (mapped === undefined) return { messageId, outcome: "not_derivable" };
  const row = readMessageDerivationRow(db, messageId, mapped.derivationType);
  if (row?.state === "blocked") {
    return failedDerive(messageId, {
      errorClass: "state_corruption",
      code: "source_damaged",
      reason: row.reason ?? `derivation ${mapped.derivationType} for message ${messageId} is blocked`,
    });
  }
  const sourceVersion = sourceVersionForDerive(row);
  if (hasLiveItem(db, mapped.workKind, { messageId }, sourceVersion)) {
    return { messageId, outcome: "already_queued", derivationType: mapped.derivationType };
  }

  const item = prepareSyntheticItem(
    {
      db,
      clock: config.clock,
      threadId: "",
      onCommit: () => {},
      poke: () => {},
    },
    messageId,
    mapped.workKind,
    mapped.derivationType,
    sourceVersion,
  );
  const handler = messageWorkHandlers[mapped.workKind];
  if (handler === undefined) {
    return failedDerive(messageId, {
      errorClass: "state_corruption",
      code: "unknown_work_kind",
      reason: `no handler registered for work kind "${mapped.workKind}"`,
    });
  }
  let outcome: HandlerOutcome;
  try {
    outcome = await handler(
      { openDb: () => db, inferenceCallbacks: config.inferenceCallbacks, clock: config.clock, config },
      { workItemId: item.workItemId, kind: item.kind, sourceRef: item.sourceRef as Record<string, string> },
    );
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    outcome = { ok: false, retryable: false, reason: `handler threw: ${reason}` };
  }
  if (outcome.ok) {
    complete(db, item, outcome.derivations ?? [], config.clock().toISOString(), outcome.onApplied);
    return { messageId, outcome: "derived", derivationType: mapped.derivationType, sourceVersion };
  }
  const reason = "blocked" in outcome ? outcome.reason : outcome.reason;
  failTerminal(db, item, {
    reason,
    formState: "blocked" in outcome ? "blocked" : "failed",
    attempts: 1,
    now: config.clock().toISOString(),
  });
  return failedDerive(messageId, {
    errorClass: "system_error",
    code: "provider_failure",
    reason,
  });
}

// Synchronous message-owned derivation. For each message id, the domain
// selects the one message-owned derivation implied by the stored message kind
// (`user_prompt` -> `smoothed_prompt`, `tool_result` -> `tool_result_summary`),
// runs the existing handler, and lands the normal version-checked derivation
// write before returning. Non-derivable message kinds return `not_derivable`;
// queued live work at the same source version returns `already_queued`.
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
    const results: MessageDeriveResult[] = [];
    for (const messageId of messageIds) {
      results.push(await runMessageDerivation(db, config, messageId));
    }
    return { ok: true, value: results };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return storageFailure(`derive failed: ${reason}`);
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
  threadRef: ThreadRef,
  edit: { messageId: string; content: string },
): Promise<OpResult<MutationResult>> {
  const resolved = await resolveThreadRef(threadRef);
  if (!resolved.ok) return resolved;
  const { filePath } = resolved.value;
  if (!existsSync(filePath)) return threadNotFound(filePath);

  const opened = openThreadDatabase(filePath);
  if (!opened.ok) return opened;
  const db = opened.value;
  try {
    const meta = db.prepare(`SELECT thread_id FROM thread_metadata WHERE id = 1`).get() as
      | { thread_id: string }
      | undefined;
    const threadId = meta?.thread_id ?? "";
    return runInTransaction(
      db,
      () => new Date(),
      threadId,
      (ctx): OpResult<MutationResult> => {
        const target = readMutableMessage(ctx.db, edit.messageId);
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
                  ? `message ${edit.messageId} belongs to open turn ${target.turnId ?? ""}; open-turn messages cannot be edited (v1 boundary)`
                  : `message ${edit.messageId} has no turn membership; only closed-turn messages can be edited (v1 boundary)`,
            },
          };
        }
        applyMessageEdit(ctx.db, edit.messageId, edit.content);
        const cascade = cascadeFromMessage(ctx, edit.messageId);
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
      },
    );
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
// protection: deleting the turn's initiating prompt is refused because
// initiating-prompt and whole-turn delete are unsupported in this slice.
export async function remove(threadRef: ThreadRef, removal: { messageId: string }): Promise<OpResult<MutationResult>> {
  const resolved = await resolveThreadRef(threadRef);
  if (!resolved.ok) return resolved;
  const { filePath } = resolved.value;
  if (!existsSync(filePath)) return threadNotFound(filePath);

  const opened = openThreadDatabase(filePath);
  if (!opened.ok) return opened;
  const db = opened.value;
  try {
    const meta = db.prepare(`SELECT thread_id FROM thread_metadata WHERE id = 1`).get() as
      | { thread_id: string }
      | undefined;
    const threadId = meta?.thread_id ?? "";
    return runInTransaction(
      db,
      () => new Date(),
      threadId,
      (ctx): OpResult<MutationResult> => {
        const target = readMutableMessage(ctx.db, removal.messageId);
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
                  ? `message ${removal.messageId} belongs to open turn ${target.turnId ?? ""}; open-turn messages cannot be deleted (v1 boundary)`
                  : `message ${removal.messageId} has no turn membership; only closed-turn messages can be deleted (v1 boundary)`,
            },
          };
        }
        if (target.initiatesTurn) {
          return {
            ok: false,
            error: {
              errorClass: "caller_error",
              code: "message_initiates_turn",
              reason: `message ${removal.messageId} is the prompt that initiates turn ${target.turnId ?? ""}; deleting the initiating prompt or whole turn is not supported in this slice`,
            },
          };
        }
        markMessageDeleted(ctx.db, removal.messageId, ctx.clock().toISOString());
        const cascade = cascadeMessageDelete(ctx, removal.messageId);
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
      },
    );
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return storageFailure(`delete failed: ${reason}`);
  } finally {
    db.close();
  }
}
