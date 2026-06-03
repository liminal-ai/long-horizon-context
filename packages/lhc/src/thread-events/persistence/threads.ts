import { THREAD_EVENT_SCHEMA_VERSION, decodePersistedThreadEvent } from "../schema.js";
import type { CreateThreadResult, PersistedThreadEvent, ProjectedThread, StoreRuntime } from "../types.js";
import type { EventRow, ThreadRow } from "../sqlite/rows.js";

export async function createThreadRecord(runtime: StoreRuntime, input: { clientThreadId: string; title?: string | undefined }): Promise<CreateThreadResult> {
  const { db } = runtime.db;
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = findThreadByClientThreadId(runtime, input.clientThreadId);
    if (existing) {
      db.exec("COMMIT");
      return { thread: existing, created: false };
    }

    const nowIso = runtime.now().toISOString();
    const threadId = runtime.idGenerator();
    const eventId = runtime.idGenerator();
    const thread: ProjectedThread = withOptionalTitle({
      threadId,
      clientThreadId: input.clientThreadId,
      createdAt: nowIso,
      updatedAt: nowIso,
    }, input.title);

    const event: PersistedThreadEvent = decodePersistedThreadEvent({
      threadEventId: eventId,
      threadId,
      eventOrder: 1,
      schemaVersion: THREAD_EVENT_SCHEMA_VERSION,
      eventKind: "thread_created",
      idempotencyKey: `thread_created:${input.clientThreadId}`,
      actor: { actorKind: "runtime", actorId: "lhc" },
      harness: makeCreateHarness(input.clientThreadId, threadId),
      recordedAt: nowIso,
      payload: { _tag: "thread_created", clientThreadId: input.clientThreadId, ...(input.title === undefined ? {} : { title: input.title }) },
    });

    db.prepare(`
      INSERT INTO thread (thread_id, client_thread_id, title, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(thread.threadId, thread.clientThreadId, thread.title ?? null, thread.createdAt, thread.updatedAt);

    db.prepare(`
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

    db.exec("COMMIT");
    return { thread, created: true, event };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export async function listThreadRecords(runtime: StoreRuntime): Promise<ProjectedThread[]> {
  const rows = runtime.db.db.prepare(`
    SELECT thread_id, client_thread_id, title, created_at, updated_at
    FROM thread
    ORDER BY created_at ASC, thread_id ASC
  `).all() as unknown as ThreadRow[];
  return rows.map(rowToThread);
}

export function findThreadByClientThreadId(runtime: StoreRuntime, clientThreadId: string): ProjectedThread | undefined {
  const row = runtime.db.db.prepare(`
    SELECT thread_id, client_thread_id, title, created_at, updated_at
    FROM thread
    WHERE client_thread_id = ?
  `).get(clientThreadId) as ThreadRow | undefined;
  return row === undefined ? undefined : rowToThread(row);
}

export function readThreadCreatedEvent(runtime: StoreRuntime, threadId: string): PersistedThreadEvent | undefined {
  const row = runtime.db.db.prepare(`
    SELECT *
    FROM event
    WHERE thread_id = ? AND event_kind = 'thread_created'
    ORDER BY event_order ASC
    LIMIT 1
  `).get(threadId) as EventRow | undefined;
  return row === undefined ? undefined : rowToPersistedEvent(row);
}

function rowToThread(row: ThreadRow): ProjectedThread {
  return {
    threadId: row.thread_id,
    clientThreadId: row.client_thread_id,
    ...(row.title === null ? {} : { title: row.title }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToPersistedEvent(row: EventRow): PersistedThreadEvent {
  return decodePersistedThreadEvent({
    threadEventId: row.thread_event_id,
    threadId: row.thread_id,
    eventOrder: row.event_order,
    schemaVersion: row.schema_version,
    eventKind: row.event_kind,
    idempotencyKey: row.idempotency_key,
    actor: JSON.parse(row.actor_json) as unknown,
    harness: JSON.parse(row.harness_json) as unknown,
    ...(row.origin_json === null ? {} : { origin: JSON.parse(row.origin_json) as unknown }),
    recordedAt: row.recorded_at,
    ...(row.occurred_at === null ? {} : { occurredAt: row.occurred_at }),
    payload: JSON.parse(row.payload_json) as unknown,
  });
}

function withOptionalTitle<T extends ProjectedThread>(thread: T, title: string | undefined): T {
  return title === undefined ? thread : { ...thread, title };
}

function makeCreateHarness(clientThreadId: string, threadId: string): { runtime: "lhc"; externalThreadId?: string } {
  return clientThreadId === threadId ? { runtime: "lhc" } : { runtime: "lhc", externalThreadId: clientThreadId };
}
