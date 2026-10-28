import type { DatabaseSync } from "node:sqlite";
import type { RollbackPayload } from "../../intake-stream/index.js";
import { type ChainSubject, cascadeRollback } from "../../messages/internal/cascade.js";
import type { DbWriteTransaction } from "../../shared-tech/index.js";
import type { WorkItemRecord } from "../../shared-tech/work-queue/index.js";
import { dropStoredViewPast } from "../../thread-view/internal/snapshot.js";
import { countTurnMembers, markTurnDeleted } from "./store.js";

export class RollbackAnchorError extends Error {
  readonly errorClass = "caller_error" as const;
  readonly code = "invalid_event" as const;
}

export interface RecordedRollbackEvent {
  eventOrder: number;
  recordedAt: string;
  payload: RollbackPayload;
}

function hasLiveMemberTurn(db: DatabaseSync, chunkId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM chunk_member cm
       JOIN turns t ON t.turn_id = cm.turn_id AND t.deleted_at IS NULL
       WHERE cm.chunk_id = ? LIMIT 1`,
    )
    .get(chunkId);
  return row !== undefined;
}

export function applyRollback(
  transaction: DbWriteTransaction,
  recordedEvent: RecordedRollbackEvent,
): { queuedWork: WorkItemRecord[] } {
  const keepThrough = recordedEvent.payload.keepThroughEventOrder;
  if (keepThrough >= recordedEvent.eventOrder) {
    throw new RollbackAnchorError(
      `rollback keepThroughEventOrder ${keepThrough} must name a position recorded before event ${recordedEvent.eventOrder}`,
    );
  }
  const { db } = transaction;
  dropStoredViewPast(db, keepThrough);
  const hidden = db
    .prepare(
      `UPDATE message SET deleted_at = ? WHERE deleted_at IS NULL AND source_event_order > ?
       RETURNING message_id, turn_id`,
    )
    .all(recordedEvent.recordedAt, keepThrough) as unknown as Array<{ message_id: string; turn_id: string }>;
  if (hidden.length === 0) return { queuedWork: [] };

  const turnStatus = db.prepare(`SELECT status FROM turns WHERE turn_id = ?`);
  const chunkOf = db.prepare(`SELECT chunk_id FROM chunk_member WHERE turn_id = ?`);
  const drop: ChainSubject[] = hidden.map((row) => ({ subjectKind: "message", subjectId: row.message_id }));
  const clear: ChainSubject[] = [];
  const chunkIds = new Set<string>();
  for (const turnId of new Set(hidden.map((row) => row.turn_id))) {
    const { status } = turnStatus.get(turnId) as { status: string };
    if (status !== "closed") continue;
    if (countTurnMembers(db, turnId) > 0) {
      clear.push({ subjectKind: "turn", subjectId: turnId });
    } else {
      markTurnDeleted(db, turnId, recordedEvent.recordedAt);
      drop.push({ subjectKind: "turn", subjectId: turnId });
    }
    const chunk = chunkOf.get(turnId) as { chunk_id: string } | undefined;
    if (chunk !== undefined) chunkIds.add(chunk.chunk_id);
  }
  for (const chunkId of chunkIds) {
    (hasLiveMemberTurn(db, chunkId) ? clear : drop).push({ subjectKind: "chunk", subjectId: chunkId });
  }
  return { queuedWork: cascadeRollback(transaction, drop, clear) };
}
