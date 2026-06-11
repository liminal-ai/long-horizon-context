import { existsSync } from "node:fs";
import { runInTransaction, type OperationContext } from "../../shared/context.js";
import type {
  FormKind,
  FormReportEntry,
  WorkHandler,
} from "../../shared/derivation.js";
import { storageFailure, type ErrorResult, type OpResult } from "../../shared/errors.js";
import {
  enqueue,
  hasLiveItem,
  listItems,
  type EnqueueFormTarget,
  type WorkItemRecord,
  type WorkKind,
  type WorkSourceRef,
} from "../../tech-utils/work-queue/index.js";
import type { EventKind } from "../intake-stream/index.js";
import { openThreadDatabase, resolveThreadRef, type ThreadRef } from "../threads/index.js";
import { transition } from "./internal/state-machine.js";

// The pure rule table, re-exported for the golden supplemental suite (the
// test plan's one sanctioned direct entry besides the tokenizer); production
// callers go through applyEvent.
export { transition, type TurnEffect, type TurnState } from "./internal/state-machine.js";
import type { DerivedForm } from "../../shared/derivation.js";
import { turnWorkHandlers } from "./internal/derive.js";
import {
  readChunkRows,
  readOwnedForms,
  readTurnFormRow,
  reportTurnForms,
} from "./internal/forms.js";
import {
  closeTurn,
  insertOpenTurn,
  nextTurnOrder,
  readTurns,
  selectOpenTurnIds,
} from "./internal/store.js";

export interface TurnRecord {
  turnId: string;
  status: "open" | "closed";
  memberMessageIds: string[];
  openedAtEventOrder: number;
  closedAtEventOrder?: number;
  // Chunk placement (Epic 02 Story 3, AC-3.5): present once the turn's
  // derivation placed it — stored values read back, never recomputed.
  chunkId?: string;
  memberIdx?: number;
  // The turn's derived forms as stored (Epic 02 Story 4, AC-4.7 ruling 012):
  // present only when rows exist — a closed turn carries them from the
  // moment its derivation queues. Stored state returned verbatim, mirroring
  // the message read's forms key; reads degrade, never block.
  forms?: DerivedForm[];
}

// Chunk read-back (Epic 02 Story 4, AC-4.7 ruling 012): the stored chunk
// record with live membership and its summary forms' states attached —
// the chunk leg of "reading a message, turn, or chunk returns the record
// with form states".
export interface ChunkRecord {
  chunkId: string;
  chunkOrder: number;
  status: "open" | "closed";
  accumulatedProjectedTokens: number;
  memberTurnIds: string[];
  forms?: DerivedForm[];
}

export interface TurnTransitionOutcome {
  // Transitions in occurrence order: a close_then_open reports the close
  // first, then the open, exactly as the batch result surfaces them.
  transitions: Array<{ action: "opened" | "closed"; turnId: string }>;
  // Turn state after the transition — the stamp for this event's message.
  // Prompts see the turn they just opened (transition first, then stamp);
  // non-transition kinds see whatever is open, or null in a gap (AC-3.8).
  openTurnId: string | null;
  // Work queued by this transition: one turn_derivation item per closed
  // turn, by either close path (AC-3.6). Empty when nothing closed.
  queuedWork: WorkItemRecord[];
}

// Pipeline corruption check (AC-3.9): read at state load, after BEGIN
// IMMEDIATE and before any event is processed. Only the batch pipeline
// writes turn state, so more than one open turn means external interference.
export function listOpenTurnIds(ctx: OperationContext): string[] {
  return selectOpenTurnIds(ctx.db);
}

// Closing a turn — by either close path — durably queues that turn's
// derivation work in the same transaction (AC-3.6): the close update and the
// work item commit or roll back together.
function closeTurnAndQueueWork(
  ctx: OperationContext,
  turnId: string,
  eventOrder: number,
): WorkItemRecord {
  closeTurn(ctx.db, turnId, eventOrder);
  // One work item, two derived forms: the turn_derivation handler (Story 3)
  // lands the rendering and the lower-band projection as independent rows;
  // both go pending with the enqueue (DD-5).
  return enqueue(ctx, {
    owner: "turns",
    kind: "turn_derivation",
    sourceRef: { turnId },
    forms: [
      { subjectKind: "turn", subjectId: turnId, form: "turn_rendering" },
      { subjectKind: "turn", subjectId: turnId, form: "lower_band_projection" },
    ],
  });
}

// Turn-owned work handlers, merged into the SDK's dispatch map at
// construction (DD-6): turn derivation and the two chunk summaries.
export const workHandlers: Readonly<Partial<Record<WorkKind, WorkHandler>>> =
  turnWorkHandlers;

// Cross-domain surface, called by intake-stream inside the batch transaction
// for every recorded event. Synchronous and throwing by design, like
// messages.createFromEvent: a turn-storage failure rejects the whole batch.
export function applyEvent(
  ctx: OperationContext,
  eventKind: EventKind,
  eventOrder: number,
): TurnTransitionOutcome {
  const openTurnId = selectOpenTurnIds(ctx.db)[0] ?? null;
  const effect = transition({ openTurnId }, eventKind);
  switch (effect.kind) {
    case "none":
      return { transitions: [], openTurnId, queuedWork: [] };
    case "open": {
      const turnId = insertOpenTurn(ctx.db, nextTurnOrder(ctx.db), eventOrder);
      return {
        transitions: [{ action: "opened", turnId }],
        openTurnId: turnId,
        queuedWork: [],
      };
    }
    case "close": {
      const item = closeTurnAndQueueWork(ctx, openTurnId as string, eventOrder);
      return {
        transitions: [{ action: "closed", turnId: openTurnId as string }],
        openTurnId: null,
        queuedWork: [item],
      };
    }
    case "close_then_open": {
      const item = closeTurnAndQueueWork(ctx, openTurnId as string, eventOrder);
      const turnId = insertOpenTurn(ctx.db, nextTurnOrder(ctx.db), eventOrder);
      return {
        transitions: [
          { action: "closed", turnId: openTurnId as string },
          { action: "opened", turnId },
        ],
        openTurnId: turnId,
        queuedWork: [item],
      };
    }
  }
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

export async function listTurns(thread: ThreadRef): Promise<OpResult<TurnRecord[]>> {
  const resolved = await resolveThreadRef(thread);
  if (!resolved.ok) return resolved;
  const { filePath } = resolved.value;
  if (!existsSync(filePath)) return threadNotFound(filePath);

  const opened = openThreadDatabase(filePath);
  if (!opened.ok) return opened;
  const db = opened.value;
  try {
    // Form read-back rides the turn read (AC-4.7): each record carries its
    // stored derived forms, attached from one grouped query — mirroring the
    // message read's production path for "readable alongside the record".
    const formsByTurn = readOwnedForms(db, "turn");
    const records = readTurns(db).map((record) => {
      const forms = formsByTurn.get(record.turnId);
      return forms === undefined ? record : { ...record, forms };
    });
    return { ok: true, value: records };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return storageFailure(`turn read-back failed: ${reason}`);
  } finally {
    db.close();
  }
}

// Chunk read-back with summary-form states attached (AC-4.7 ruling 012):
// returns stored records whatever the forms' states — reads degrade, never
// block. Forms attach only where rows exist (a freshly opened chunk has no
// summary rows until close queues them).
export async function listChunks(thread: ThreadRef): Promise<OpResult<ChunkRecord[]>> {
  const resolved = await resolveThreadRef(thread);
  if (!resolved.ok) return resolved;
  const { filePath } = resolved.value;
  if (!existsSync(filePath)) return threadNotFound(filePath);

  const opened = openThreadDatabase(filePath);
  if (!opened.ok) return opened;
  const db = opened.value;
  try {
    const formsByChunk = readOwnedForms(db, "chunk");
    const records: ChunkRecord[] = readChunkRows(db).map((row) => {
      const forms = formsByChunk.get(row.chunkId);
      return forms === undefined ? row : { ...row, forms };
    });
    return { ok: true, value: records };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return storageFailure(`chunk read-back failed: ${reason}`);
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
    return { ok: true, value: listItems(db, "turns") };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return storageFailure(`queued-work read-back failed: ${reason}`);
  } finally {
    db.close();
  }
}

// ── report and repair (Epic 02 Story 4, Flow 4) ──────────────────

// This owner's repair report: every turn- and chunk-owned form's durable
// state joined with live queue detail in one query. Needs no provider;
// reads degrade, never block.
export async function report(
  thread: ThreadRef,
  opts?: { notReady?: boolean; turnId?: string; chunkId?: string },
): Promise<OpResult<FormReportEntry[]>> {
  const resolved = await resolveThreadRef(thread);
  if (!resolved.ok) return resolved;
  const { filePath } = resolved.value;
  if (!existsSync(filePath)) return threadNotFound(filePath);

  const opened = openThreadDatabase(filePath);
  if (!opened.ok) return opened;
  const db = opened.value;
  try {
    return { ok: true, value: reportTurnForms(db, opts ?? {}) };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return storageFailure(`report read failed: ${reason}`);
  } finally {
    db.close();
  }
}

export type RequeueOutcome = { workItemId: string } | { noop: "already_queued" };

// The queue site each turn-owned form rebuilds through. Both turn forms ride
// the one turn_derivation item (the handler lands rendering and projection
// together, so a rebuild of either re-derives both — the rebuild rule from
// Flow 3); each chunk summary rides its same-named kind alone (AC-3.8's
// independent lifecycles).
function turnRequeueTarget(target: {
  subjectKind: "turn" | "chunk";
  subjectId: string;
  form: FormKind;
}): { kind: WorkKind; sourceRef: WorkSourceRef; forms: EnqueueFormTarget[] } | undefined {
  if (
    target.subjectKind === "turn" &&
    (target.form === "turn_rendering" || target.form === "lower_band_projection")
  ) {
    return {
      kind: "turn_derivation",
      sourceRef: { turnId: target.subjectId },
      forms: [
        { subjectKind: "turn", subjectId: target.subjectId, form: "turn_rendering" },
        { subjectKind: "turn", subjectId: target.subjectId, form: "lower_band_projection" },
      ],
    };
  }
  if (
    target.subjectKind === "chunk" &&
    (target.form === "chunk_summary_detailed" || target.form === "chunk_summary_brief")
  ) {
    return {
      kind: target.form,
      sourceRef: { chunkId: target.subjectId },
      forms: [{ subjectKind: "chunk", subjectId: target.subjectId, form: target.form }],
    };
  }
  return undefined;
}

// Explicit re-queue through the owning surface (AC-4.4): same contract as
// messages.requeue — blocked refused with the stored damage reason, missing
// rows refused, no-op against live work at the current source version, and
// the no-op check + enqueue in one transaction. A successful requeue rebuilds
// at the next source version: composed forms recompute their gaps from
// current dependency states (Flow 3's rebuild rule).
export async function requeue(
  thread: ThreadRef,
  target: { subjectKind: "turn" | "chunk"; subjectId: string; form: FormKind },
): Promise<OpResult<RequeueOutcome>> {
  const mapped = turnRequeueTarget(target);
  if (mapped === undefined) {
    return {
      ok: false,
      error: {
        errorClass: "caller_error",
        code: "turn_not_found",
        reason: `form ${target.form} is not a ${target.subjectKind}-owned form; turns.requeue repairs turn_rendering and lower_band_projection (turn) or chunk_summary_detailed and chunk_summary_brief (chunk)`,
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
      const row = readTurnFormRow(ctx.db, target.subjectKind, target.subjectId, target.form);
      if (row === undefined) {
        return {
          ok: false,
          error: {
            errorClass: "caller_error",
            code: "turn_not_found",
            reason: `no derived form ${target.form} exists for ${target.subjectKind} ${target.subjectId}`,
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
            reason:
              row.reason ??
              `form ${target.form} for ${target.subjectKind} ${target.subjectId} is blocked`,
          },
        };
      }
      if (hasLiveItem(ctx.db, mapped.kind, mapped.sourceRef, row.sourceVersion)) {
        return { ok: true, value: { noop: "already_queued" } };
      }
      const item = enqueue(ctx, {
        owner: "turns",
        kind: mapped.kind,
        sourceRef: mapped.sourceRef,
        sourceVersion: row.sourceVersion + 1,
        forms: mapped.forms,
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
