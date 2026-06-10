import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { OperationContext } from "../../shared/context.js";
import {
  notImplemented,
  storageFailure,
  type ErrorResult,
  type OpResult,
} from "../../shared/errors.js";
import type { WorkItemRecord } from "../../tech-utils/work-queue/index.js";
import type { EventKind, EventRecord } from "../intake-stream/index.js";
import {
  openThreadDatabase,
  resolveThreadRef,
  type ThreadRef,
} from "../threads/index.js";
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
}

// The event as the walk holds it after recording: the validated input plus
// its server-stamped order and timestamp.
export type RecordedEvent = EventRecord;

export type MessageCreated = {
  messageId: string;
  kind: Exclude<EventKind, "turn_end">;
} | null;

// Cross-domain surface, called by intake-stream inside the batch transaction
// (the first such call through the operation context; turns.applyEvent
// follows the pattern in Story 4). Synchronous and throwing by design: a
// projection failure propagates to the pipeline's catch and rejects the
// whole batch — recorded events without messages is the stranded state the
// transaction exists to prevent. Returns null for turn_end (no message).
export function createFromEvent(
  ctx: OperationContext,
  event: RecordedEvent,
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
    blocks: projected.blocks,
  });
  return { messageId, kind };
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
    return { ok: true, value: readMessages(db) };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return storageFailure(`message read-back failed: ${reason}`);
  } finally {
    db.close();
  }
}

export async function listQueuedWork(
  _thread: ThreadRef,
): Promise<OpResult<WorkItemRecord[]>> {
  return notImplemented("messages.list-queued-work");
}
