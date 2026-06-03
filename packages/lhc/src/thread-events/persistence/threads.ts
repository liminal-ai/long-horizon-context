import { THREAD_EVENT_SCHEMA_VERSION } from "../schema.js";
import type { CreateThreadResult, ProjectedThread, StoreRuntime } from "../types.js";

export async function createThreadRecord(runtime: StoreRuntime, input: { clientThreadId: string; title?: string | undefined }): Promise<CreateThreadResult> {
  const nowIso = runtime.now().toISOString();
  const threadId = runtime.idGenerator();
  const thread = withOptionalTitle({
    threadId,
    clientThreadId: input.clientThreadId,
    createdAt: nowIso,
    updatedAt: nowIso,
  }, input.title);

  return {
    thread,
    created: false,
    event: {
      threadEventId: runtime.idGenerator(),
      threadId,
      eventOrder: 0,
      schemaVersion: THREAD_EVENT_SCHEMA_VERSION,
      eventKind: "thread_created",
      idempotencyKey: `thread_created:${input.clientThreadId}`,
      actor: { actorKind: "runtime", actorId: "lhc" },
      harness: { runtime: "lhc", externalThreadId: input.clientThreadId },
      recordedAt: nowIso,
      payload: { _tag: "thread_created", clientThreadId: input.clientThreadId, ...(input.title === undefined ? {} : { title: input.title }) },
    },
  };
}

export async function listThreadRecords(_runtime: StoreRuntime): Promise<ProjectedThread[]> {
  return [];
}

function withOptionalTitle<T extends ProjectedThread>(thread: T, title: string | undefined): T {
  return title === undefined ? thread : { ...thread, title };
}
