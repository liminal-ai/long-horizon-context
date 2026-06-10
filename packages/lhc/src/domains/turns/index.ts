import { existsSync } from "node:fs";
import type { OperationContext } from "../../shared/context.js";
import {
  notImplemented,
  storageFailure,
  type ErrorResult,
  type OpResult,
} from "../../shared/errors.js";
import type { WorkItemRecord } from "../../tech-utils/work-queue/index.js";
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
}

// Pipeline corruption check (AC-3.9): read at state load, after BEGIN
// IMMEDIATE and before any event is processed. Only the batch pipeline
// writes turn state, so more than one open turn means external interference.
export function listOpenTurnIds(ctx: OperationContext): string[] {
  return selectOpenTurnIds(ctx.db);
}

// Cross-domain surface, called by intake-stream inside the batch transaction
// for every recorded event. Synchronous and throwing by design, like
// messages.createFromEvent: a turn-storage failure rejects the whole batch.
// Closing a turn queues nothing here — Story 5 adds the turn_derivation work
// item to this already-working close path inside the same transaction.
export function applyEvent(
  ctx: OperationContext,
  eventKind: EventKind,
  eventOrder: number,
): TurnTransitionOutcome {
  const openTurnId = selectOpenTurnIds(ctx.db)[0] ?? null;
  const effect = transition({ openTurnId }, eventKind);
  switch (effect.kind) {
    case "none":
      return { transitions: [], openTurnId };
    case "open": {
      const turnId = insertOpenTurn(ctx.db, nextTurnOrder(ctx.db), eventOrder);
      return { transitions: [{ action: "opened", turnId }], openTurnId: turnId };
    }
    case "close": {
      closeTurn(ctx.db, openTurnId as string, eventOrder);
      return {
        transitions: [{ action: "closed", turnId: openTurnId as string }],
        openTurnId: null,
      };
    }
    case "close_then_open": {
      closeTurn(ctx.db, openTurnId as string, eventOrder);
      const turnId = insertOpenTurn(ctx.db, nextTurnOrder(ctx.db), eventOrder);
      return {
        transitions: [
          { action: "closed", turnId: openTurnId as string },
          { action: "opened", turnId },
        ],
        openTurnId: turnId,
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
  _thread: ThreadRef,
): Promise<OpResult<WorkItemRecord[]>> {
  return notImplemented("turns.list-queued-work");
}
