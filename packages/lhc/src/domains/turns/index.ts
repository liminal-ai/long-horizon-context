import { notImplemented, type OpResult } from "../../shared/errors.js";
import type { WorkItemRecord } from "../../tech-utils/work-queue/index.js";
import type { ThreadRef } from "../threads/index.js";

export interface TurnRecord {
  turnId: string;
  status: "open" | "closed";
  memberMessageIds: string[];
  openedAtEventOrder: number;
  closedAtEventOrder?: number;
}

export async function listTurns(
  _thread: ThreadRef,
): Promise<OpResult<TurnRecord[]>> {
  return notImplemented("turns.list");
}

export async function listQueuedWork(
  _thread: ThreadRef,
): Promise<OpResult<WorkItemRecord[]>> {
  return notImplemented("turns.list-queued-work");
}
