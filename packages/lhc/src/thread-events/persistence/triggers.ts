import { createHash } from "node:crypto";

import type { TriggerRow } from "../sqlite/rows.js";
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
