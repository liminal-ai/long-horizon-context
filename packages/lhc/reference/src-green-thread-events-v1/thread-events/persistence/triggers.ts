import { createHash } from "node:crypto";

import type { TriggerRow } from "../sqlite/rows.js";
import { withImmediateTransaction } from "../sqlite/transaction.js";
import type { PersistedThreadEvent } from "../schema.js";
import type { StoreRuntime, TurnProcessingTrigger } from "../types.js";

export function ensureTurnEndTriggerForEvent(runtime: StoreRuntime, event: PersistedThreadEvent): TurnProcessingTrigger {
  const existing = findTriggerForTurnEnd(runtime, event.threadId, event.eventOrder);
  if (existing) {
    return existing;
  }

  const trigger: TurnProcessingTrigger = {
    triggerId: deterministicTriggerId(event.threadId, event.eventOrder),
    threadId: event.threadId,
    turnEndEventId: event.threadEventId,
    turnEndEventOrder: event.eventOrder,
    status: "pending",
    createdAt: event.recordedAt,
  };

  runtime.db.db.prepare(`
    INSERT INTO turn_trigger (
      trigger_id,
      thread_id,
      turn_end_event_id,
      turn_end_event_order,
      status,
      created_at,
      claimed_at,
      completed_at,
      last_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    trigger.triggerId,
    trigger.threadId,
    trigger.turnEndEventId,
    trigger.turnEndEventOrder,
    trigger.status,
    trigger.createdAt,
    null,
    null,
    null,
  );

  return trigger;
}

export async function listTriggerRecords(runtime: StoreRuntime): Promise<TurnProcessingTrigger[]> {
  const rows = runtime.db.db.prepare(`
    SELECT *
    FROM turn_trigger
    ORDER BY thread_id ASC, turn_end_event_order ASC
  `).all() as unknown as TriggerRow[];
  return rows.map(rowToTrigger);
}

export function claimNextTrigger(runtime: StoreRuntime): TurnProcessingTrigger | undefined {
  return withImmediateTransaction(runtime.db, () => {
    const row = runtime.db.db.prepare(`
      SELECT *
      FROM turn_trigger candidate
      WHERE candidate.status IN ('pending', 'failed')
        AND NOT EXISTS (
          SELECT 1 FROM turn_trigger claimed
          WHERE claimed.thread_id = candidate.thread_id
            AND claimed.status = 'claimed'
        )
        AND NOT EXISTS (
          SELECT 1 FROM turn_trigger earlier
          WHERE earlier.thread_id = candidate.thread_id
            AND earlier.turn_end_event_order < candidate.turn_end_event_order
            AND earlier.status != 'completed'
        )
      ORDER BY candidate.created_at ASC, candidate.thread_id ASC, candidate.turn_end_event_order ASC
      LIMIT 1
    `).get() as TriggerRow | undefined;

    if (row === undefined) {
      return undefined;
    }

    const claimedAt = runtime.now().toISOString();
    runtime.db.db.prepare(`
      UPDATE turn_trigger
      SET status = 'claimed', claimed_at = ?, completed_at = NULL, last_error = NULL
      WHERE trigger_id = ?
    `).run(claimedAt, row.trigger_id);

    return { ...rowToTrigger(row), status: "claimed", claimedAt };
  });
}

export function claimTriggerById(runtime: StoreRuntime, triggerId: string): { trigger?: TurnProcessingTrigger; reason?: "no_pending_trigger" | "turn_not_ready" } {
  return withImmediateTransaction(runtime.db, () => {
    const row = runtime.db.db.prepare(`
      SELECT *
      FROM turn_trigger
      WHERE trigger_id = ?
    `).get(triggerId) as TriggerRow | undefined;

    if (row === undefined || row.status === "completed") {
      return { reason: "no_pending_trigger" };
    }

    const earlierIncomplete = runtime.db.db.prepare(`
      SELECT 1
      FROM turn_trigger
      WHERE thread_id = ?
        AND turn_end_event_order < ?
        AND status != 'completed'
      LIMIT 1
    `).get(row.thread_id, row.turn_end_event_order);
    if (earlierIncomplete !== undefined) {
      return { reason: "turn_not_ready" };
    }

    const otherClaimed = runtime.db.db.prepare(`
      SELECT 1
      FROM turn_trigger
      WHERE thread_id = ?
        AND status = 'claimed'
        AND trigger_id != ?
      LIMIT 1
    `).get(row.thread_id, row.trigger_id);
    if (otherClaimed !== undefined) {
      return { reason: "no_pending_trigger" };
    }

    if (row.status === "claimed") {
      return { trigger: rowToTrigger(row) };
    }

    const claimedAt = runtime.now().toISOString();
    runtime.db.db.prepare(`
      UPDATE turn_trigger
      SET status = 'claimed', claimed_at = ?, completed_at = NULL, last_error = NULL
      WHERE trigger_id = ?
    `).run(claimedAt, row.trigger_id);

    return { trigger: { ...rowToTrigger(row), status: "claimed", claimedAt } };
  });
}

export function markTriggerCompleted(runtime: StoreRuntime, triggerId: string): TurnProcessingTrigger | undefined {
  return withImmediateTransaction(runtime.db, () => {
    const completedAt = runtime.now().toISOString();
    runtime.db.db.prepare(`
      UPDATE turn_trigger
      SET status = 'completed', completed_at = ?, last_error = NULL
      WHERE trigger_id = ?
    `).run(completedAt, triggerId);
    return readTriggerById(runtime, triggerId);
  });
}

export function markTriggerFailed(runtime: StoreRuntime, triggerId: string, error: string): TurnProcessingTrigger | undefined {
  return withImmediateTransaction(runtime.db, () => {
    runtime.db.db.prepare(`
      UPDATE turn_trigger
      SET status = 'failed', completed_at = NULL, last_error = ?
      WHERE trigger_id = ?
    `).run(error, triggerId);
    return readTriggerById(runtime, triggerId);
  });
}

export function readTriggerById(runtime: StoreRuntime, triggerId: string): TurnProcessingTrigger | undefined {
  const row = runtime.db.db.prepare(`
    SELECT *
    FROM turn_trigger
    WHERE trigger_id = ?
  `).get(triggerId) as TriggerRow | undefined;
  return row === undefined ? undefined : rowToTrigger(row);
}

function findTriggerForTurnEnd(runtime: StoreRuntime, threadId: string, turnEndEventOrder: number): TurnProcessingTrigger | undefined {
  const row = runtime.db.db.prepare(`
    SELECT *
    FROM turn_trigger
    WHERE thread_id = ? AND turn_end_event_order = ?
  `).get(threadId, turnEndEventOrder) as TriggerRow | undefined;
  return row === undefined ? undefined : rowToTrigger(row);
}

function rowToTrigger(row: TriggerRow): TurnProcessingTrigger {
  return {
    triggerId: row.trigger_id,
    threadId: row.thread_id,
    turnEndEventId: row.turn_end_event_id,
    turnEndEventOrder: row.turn_end_event_order,
    status: row.status as TurnProcessingTrigger["status"],
    createdAt: row.created_at,
    ...(row.claimed_at === null ? {} : { claimedAt: row.claimed_at }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
  };
}

function deterministicTriggerId(threadId: string, turnEndEventOrder: number): string {
  const hash = createHash("sha256").update(`${threadId}:${turnEndEventOrder}`).digest("hex").slice(0, 24);
  return `turn_trigger_${hash}`;
}
