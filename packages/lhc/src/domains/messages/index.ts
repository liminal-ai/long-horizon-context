import { existsSync } from "node:fs";
import { runInTransaction, type OperationContext } from "../../shared/context.js";
import type { FormKind, FormReportEntry, WorkHandler } from "../../shared/derivation.js";
import { storageFailure, type ErrorResult, type OpResult } from "../../shared/errors.js";
import {
  enqueue,
  hasLiveItem,
  listItems,
  type WorkItemRecord,
  type WorkKind,
} from "../../tech-utils/work-queue/index.js";
import type { EventKind, EventRecord } from "../intake-stream/index.js";
import {
  openThreadDatabase,
  resolveThreadRef,
  type ThreadRef,
} from "../threads/index.js";
import type { DerivedForm } from "../../shared/derivation.js";
import {
  findUnknownOutcomeCallSummary,
  readMessageFormRow,
  readMessageForms,
  reportMessageForms,
} from "./internal/forms.js";
import { messageWorkHandlers } from "./internal/handlers.js";
import { projectEvent } from "./internal/project.js";
import { insertMessage, readMessages } from "./internal/store.js";

export type BlockType = "text" | "tool_call" | "tool_result";

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
  // The message's derived forms as stored (Epic 02 Story 2): present only
  // for messages that are derivation sources — kinds with no derivable form
  // carry no rows and no key (AC-2.7). Stored state returned verbatim,
  // never re-derived on read.
  forms?: DerivedForm[];
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
// call queues tool_call_summary (Epic 02 Story 2's additive extension), a
// tool result queues tool_result_summary, nothing else queues anything —
// text, thinking, and note messages are not derivation sources (Epic 01
// AC-2.8/TC-2.9; Epic 02 AC-2.2/AC-2.7). Cross-domain surface, called by
// intake-stream inside the batch transaction for every recorded message, so
// the item commits (or rolls back) with the batch.
const MESSAGE_WORK_KINDS: Partial<Record<EventKind, WorkKind>> = {
  user_prompt: "prompt_smoothing",
  tool_call: "tool_call_summary",
  tool_result: "tool_result_summary",
};

// Which derived form each message-owned kind produces — the owning domain's
// knowledge, handed to the meaning-blind enqueue so the form's pending row
// rides the same transaction (DD-5).
const MESSAGE_WORK_FORMS: Partial<Record<WorkKind, FormKind>> = {
  prompt_smoothing: "smoothed_prompt",
  tool_call_summary: "tool_call_summary",
  tool_result_summary: "tool_result_summary",
};

// Message-owned work handlers, merged into the SDK's dispatch map at
// construction (DD-6): prompt smoothing and the two tool-activity summaries.
export const workHandlers: Readonly<Partial<Record<WorkKind, WorkHandler>>> =
  messageWorkHandlers;

export function queueMessageWork(
  ctx: OperationContext,
  message: MessageCreated,
): WorkItemRecord[] {
  if (message === null) return [];
  const items: WorkItemRecord[] = [];
  const kind = MESSAGE_WORK_KINDS[message.kind];
  if (kind !== undefined) {
    const form = MESSAGE_WORK_FORMS[kind];
    if (form === undefined) {
      // Every queuing kind names its form above; a miss is a wiring bug.
      throw new Error(`no derived form mapped for message work kind ${kind}`);
    }
    items.push(
      enqueue(ctx, {
        owner: "messages",
        kind,
        sourceRef: { messageId: message.messageId },
        forms: [{ subjectKind: "message", subjectId: message.messageId, form }],
      }),
    );
  }
  // Late-result repair (AC-2.8): a tool result landing after its call's
  // summary already derived with outcome "unknown" means the summary's
  // source — the call+result pair — completed underneath it; clear and
  // regenerate at the next source version, in this same batch transaction.
  // One indexed lookup; pending summaries (metadata NULL) never match, so
  // the common call-and-result-in-one-batch case never triggers, and the
  // version-scoped item id keeps the requeue idempotent.
  if (message.kind === "tool_result" && message.toolCallId !== undefined) {
    const stale = findUnknownOutcomeCallSummary(ctx.db, message.toolCallId);
    if (stale !== undefined) {
      items.push(
        enqueue(ctx, {
          owner: "messages",
          kind: "tool_call_summary",
          sourceRef: { messageId: stale.messageId },
          sourceVersion: stale.sourceVersion + 1,
          forms: [
            {
              subjectKind: "message",
              subjectId: stale.messageId,
              form: "tool_call_summary",
            },
          ],
        }),
      );
    }
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

export async function listMessages(
  thread: ThreadRef,
): Promise<OpResult<MessageRecord[]>> {
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
    // Form read-back rides the message read (AC-2.1): each record carries
    // its stored derived forms, attached from one grouped query — the
    // production path for "readable alongside the message".
    const formsByMessage = readMessageForms(db);
    const records = readMessages(db).map((record) => {
      const forms = formsByMessage.get(record.messageId);
      return forms === undefined ? record : { ...record, forms };
    });
    return { ok: true, value: records };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return storageFailure(`message read-back failed: ${reason}`);
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

// This owner's repair report: every message-owned form's durable state
// joined with live queue detail in one query — the five operational
// situations (waiting, retrying, ready, failed, blocked) read from the rows
// without any queue API. Needs no provider; reads degrade, never block.
export async function report(
  thread: ThreadRef,
  opts?: { notReady?: boolean; messageId?: string },
): Promise<OpResult<FormReportEntry[]>> {
  const resolved = await resolveThreadRef(thread);
  if (!resolved.ok) return resolved;
  const { filePath } = resolved.value;
  if (!existsSync(filePath)) return threadNotFound(filePath);

  const opened = openThreadDatabase(filePath);
  if (!opened.ok) return opened;
  const db = opened.value;
  try {
    return { ok: true, value: reportMessageForms(db, opts ?? {}) };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return storageFailure(`report read failed: ${reason}`);
  } finally {
    db.close();
  }
}

export type RequeueOutcome = { workItemId: string } | { noop: "already_queued" };

// Which work kind rebuilds each message-owned form — MESSAGE_WORK_FORMS
// inverted; the requeue's join from the named form back to its queue site.
const MESSAGE_FORM_KINDS: Partial<Record<FormKind, WorkKind>> = {
  smoothed_prompt: "prompt_smoothing",
  tool_call_summary: "tool_call_summary",
  tool_result_summary: "tool_result_summary",
};

// Explicit re-queue through the owning surface (AC-4.4): the public,
// supported rebuild act. Refused for blocked forms with the form's stored
// damage reason (AC-4.6) and for missing rows; a no-op against work already
// queued or in flight at the form's current source version (AC-4.5).
// Otherwise the form clears to pending and re-enqueues at the next source
// version — the same enqueue path intake uses, poke-on-commit included, so
// background mode processes the repair with no further call. The no-op check
// and the enqueue commit in one transaction (anti-shim: a split would
// reintroduce the duplicate-work race).
export async function requeue(
  thread: ThreadRef,
  target: { messageId: string; form: FormKind },
): Promise<OpResult<RequeueOutcome>> {
  const kind = MESSAGE_FORM_KINDS[target.form];
  if (kind === undefined) {
    return {
      ok: false,
      error: {
        errorClass: "caller_error",
        code: "message_not_found",
        reason: `form ${target.form} is not message-owned; messages.requeue repairs smoothed_prompt, tool_call_summary, tool_result_summary`,
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
      const row = readMessageFormRow(ctx.db, target.messageId, target.form);
      if (row === undefined) {
        return {
          ok: false,
          error: {
            errorClass: "caller_error",
            code: "message_not_found",
            reason: `no derived form ${target.form} exists for message ${target.messageId}`,
          },
        };
      }
      if (row.state === "blocked") {
        // The refusal carries the form's stored reason — the damage named at
        // blocking time, not a generic string (AC-4.6).
        return {
          ok: false,
          error: {
            errorClass: "state_corruption",
            code: "source_damaged",
            reason: row.reason ?? `form ${target.form} for message ${target.messageId} is blocked`,
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
        forms: [{ subjectKind: "message", subjectId: target.messageId, form: target.form }],
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
