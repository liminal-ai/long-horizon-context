import { notImplemented, type OpResult } from "../../shared/errors.js";
import type { WorkItemRecord } from "../../tech-utils/work-queue/index.js";
import type { EventKind } from "../intake-stream/index.js";
import type { ThreadRef } from "../threads/index.js";

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

export async function listMessages(
  _thread: ThreadRef,
): Promise<OpResult<MessageRecord[]>> {
  return notImplemented("messages.list");
}

export async function listQueuedWork(
  _thread: ThreadRef,
): Promise<OpResult<WorkItemRecord[]>> {
  return notImplemented("messages.list-queued-work");
}
