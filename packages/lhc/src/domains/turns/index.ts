import { existsSync } from "node:fs";
import type { OperationContext } from "../../shared/context.js";
import { storageFailure, type ErrorResult, type OpResult } from "../../shared/errors.js";
import {
  listItems,
  recordItem,
  type WorkItemRecord,
} from "../../tech-utils/work-queue/index.js";
import type { EventKind } from "../intake-stream/index.js";
import { openThreadDatabase, resolveThreadRef, type ThreadRef } from "../threads/index.js";
import { transition } from "./internal/state-machine.js";

// The pure rule table, re-exported for the golden supplemental suite (the
// test plan's one sanctioned direct entry besides the tokenizer); production
// callers go through applyEvent.
export { transition, type TurnEffect, type TurnState } from "./internal/state-machine.js";
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
  return recordItem(
    ctx.db,
    { owner: "turns", kind: "turn_derivation", sourceRef: { turnId } },
    ctx.clock().toISOString(),
  );
}

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
    return { ok: true, value: readTurns(db) };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return storageFailure(`turn read-back failed: ${reason}`);
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
