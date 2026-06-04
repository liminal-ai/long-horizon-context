import { THREAD_EVENT_SCHEMA_VERSION, decodePersistedThreadEvent, type NormalizedThreadEventAppendInput } from "../schema.js";
import type { EventRow } from "../sqlite/rows.js";
import { withImmediateTransaction } from "../sqlite/transaction.js";
import { ThreadEventStoreError } from "../errors.js";
import { materializeMessageRecords } from "./messages.js";
import { findThreadByClientThreadId, rowToPersistedEvent } from "./threads.js";
import type { AppendThreadEventsResult, PersistedThreadEvent, StoreRuntime } from "../types.js";

export async function appendEventRecords(
  runtime: StoreRuntime,
  clientThreadId: string,
  events: readonly NormalizedThreadEventAppendInput[],
): Promise<AppendThreadEventsResult> {
  return withImmediateTransaction(runtime.db, () => {
    const thread = findThreadByClientThreadId(runtime, clientThreadId);
    if (!thread) {
      throw new ThreadEventStoreError(`Thread not found for clientThreadId: ${clientThreadId}`);
    }

    const persisted: PersistedThreadEvent[] = [];
    for (const event of events) {
      const existing = findEventByIdempotencyKey(runtime, thread.threadId, event.idempotencyKey);
      if (existing) {
        persisted.push(existing);
        continue;
      }

      const eventOrder = nextEventOrder(runtime, thread.threadId);
      const recordedAt = runtime.now().toISOString();
      const persistedEvent = decodePersistedThreadEvent({
        threadEventId: runtime.idGenerator(),
        threadId: thread.threadId,
        eventOrder,
        schemaVersion: THREAD_EVENT_SCHEMA_VERSION,
        eventKind: event.eventKind,
        idempotencyKey: event.idempotencyKey,
        actor: event.actor,
        harness: event.harness,
        ...(event.origin === undefined ? {} : { origin: event.origin }),
        recordedAt,
        ...(event.occurredAt === undefined ? {} : { occurredAt: event.occurredAt }),
        payload: event.payload,
      });

      insertEvent(runtime, persistedEvent);
      persisted.push(persistedEvent);
    }

    const materialized = materializeMessageRecords(runtime, persisted);
    return {
      thread,
      events: persisted,
      messages: materialized.messages,
      blocks: materialized.blocks,
      triggered: false,
      reason: "triggers_not_implemented",
    };
  });
}

export async function listEventRecords(runtime: StoreRuntime): Promise<PersistedThreadEvent[]> {
  const rows = runtime.db.db.prepare(`
    SELECT *
    FROM event
    ORDER BY thread_id ASC, event_order ASC
  `).all() as unknown as EventRow[];
  return rows.map(rowToPersistedEvent);
}

export async function listEventRecordsForThread(runtime: StoreRuntime, threadId: string): Promise<PersistedThreadEvent[]> {
  const rows = runtime.db.db.prepare(`
    SELECT *
    FROM event
    WHERE thread_id = ?
    ORDER BY event_order ASC
  `).all(threadId) as unknown as EventRow[];
  return rows.map(rowToPersistedEvent);
}

function findEventByIdempotencyKey(runtime: StoreRuntime, threadId: string, idempotencyKey: string): PersistedThreadEvent | undefined {
  const row = runtime.db.db.prepare(`
    SELECT *
    FROM event
    WHERE thread_id = ? AND idempotency_key = ?
  `).get(threadId, idempotencyKey) as EventRow | undefined;
  return row === undefined ? undefined : rowToPersistedEvent(row);
}

function nextEventOrder(runtime: StoreRuntime, threadId: string): number {
  const row = runtime.db.db.prepare(`
    SELECT MAX(event_order) AS max_event_order
    FROM event
    WHERE thread_id = ?
  `).get(threadId) as { max_event_order: number | null } | undefined;
  return (row?.max_event_order ?? 0) + 1;
}

function insertEvent(runtime: StoreRuntime, event: PersistedThreadEvent): void {
  runtime.db.db.prepare(`
    INSERT INTO event (
      thread_event_id,
      thread_id,
      event_order,
      schema_version,
      event_kind,
      idempotency_key,
      actor_json,
      harness_json,
      origin_json,
      recorded_at,
      occurred_at,
      payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.threadEventId,
    event.threadId,
    event.eventOrder,
    event.schemaVersion,
    event.eventKind,
    event.idempotencyKey,
    JSON.stringify(event.actor),
    JSON.stringify(event.harness),
    event.origin === undefined ? null : JSON.stringify(event.origin),
    event.recordedAt,
    event.occurredAt ?? null,
    JSON.stringify(event.payload),
  );
}
