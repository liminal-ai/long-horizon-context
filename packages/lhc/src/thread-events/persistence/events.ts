import { THREAD_EVENT_SCHEMA_VERSION } from "../schema.js";
import type { NormalizedThreadEventAppendInput } from "../schema.js";
import type { AppendThreadEventsResult, StoreRuntime, PersistedThreadEvent, ProjectedThread } from "../types.js";

export async function appendEventRecords(
  runtime: StoreRuntime,
  clientThreadId: string,
  events: readonly NormalizedThreadEventAppendInput[],
): Promise<AppendThreadEventsResult> {
  const nowIso = runtime.now().toISOString();
  const thread: ProjectedThread = {
    threadId: runtime.idGenerator(),
    clientThreadId,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  const persisted: PersistedThreadEvent[] = events.map((event, index) => ({
    threadEventId: runtime.idGenerator(),
    threadId: thread.threadId,
    eventOrder: index,
    schemaVersion: THREAD_EVENT_SCHEMA_VERSION,
    eventKind: event.eventKind,
    idempotencyKey: event.idempotencyKey,
    actor: event.actor,
    harness: event.harness,
    ...(event.origin === undefined ? {} : { origin: event.origin }),
    recordedAt: nowIso,
    ...(event.occurredAt === undefined ? {} : { occurredAt: event.occurredAt }),
    payload: event.payload as PersistedThreadEvent["payload"],
  }));

  return {
    thread,
    events: persisted,
    messages: [],
    blocks: [],
    triggered: false,
    reason: "stub_not_implemented",
  };
}

export async function listEventRecords(_runtime: StoreRuntime): Promise<PersistedThreadEvent[]> {
  return [];
}
