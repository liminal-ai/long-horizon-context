import type { DatabaseSync } from "node:sqlite";
import type { TurnRecord } from "../index.js";
import { readPlacements } from "./chunks.js";

export function selectOpenTurnIds(db: DatabaseSync): string[] {
  const rows = db
    .prepare("SELECT turn_id FROM turns WHERE status = 'open' ORDER BY turn_order")
    .all() as unknown as Array<{ turn_id: string }>;
  return rows.map((row) => row.turn_id);
}

export function countTurnMembers(db: DatabaseSync, turnId: string): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM message WHERE turn_id = ? AND deleted_at IS NULL").get(turnId) as
    | { n: number | bigint }
    | undefined;
  return Number(row?.n ?? 0);
}

export function nextTurnOrder(db: DatabaseSync): number {
  const row = db.prepare("SELECT MAX(turn_order) AS max_order FROM turns").get() as
    | { max_order: number | bigint | null }
    | undefined;
  return Number(row?.max_order ?? 0) + 1;
}

export function insertOpenTurn(db: DatabaseSync, turnOrder: number, openedAtEventOrder: number): string {
  const turnId = `t${turnOrder}`;
  db.prepare(
    `INSERT INTO turns (turn_id, turn_order, status, opened_at_event_order)
     VALUES (?, ?, 'open', ?)`,
  ).run(turnId, turnOrder, openedAtEventOrder);
  return turnId;
}

export interface TurnCloseHostFacts {
  outcome?: "completed" | "aborted";
  outcomeReason?: string;
  startedAt?: string;
  endedAt?: string;
}

export function markTurnDeleted(db: DatabaseSync, turnId: string, deletedAt: string): void {
  db.prepare(`UPDATE turns SET deleted_at = ? WHERE turn_id = ? AND deleted_at IS NULL`).run(deletedAt, turnId);
}

export function closeTurn(
  db: DatabaseSync,
  turnId: string,
  closedAtEventOrder: number,
  hostFacts: TurnCloseHostFacts = {},
): void {
  db.prepare(
    `UPDATE turns SET status = 'closed', closed_at_event_order = ?,
       outcome = ?, outcome_reason = ?, started_at = ?, ended_at = ?
     WHERE turn_id = ? AND status = 'open'`,
  ).run(
    closedAtEventOrder,
    hostFacts.outcome ?? null,
    hostFacts.outcomeReason ?? null,
    hostFacts.startedAt ?? null,
    hostFacts.endedAt ?? null,
    turnId,
  );
}

interface RawTurnRow {
  turn_id: string;
  turn_order: number | bigint;
  status: string;
  opened_at_event_order: number | bigint;
  closed_at_event_order: number | bigint | null;
  outcome: string | null;
  outcome_reason: string | null;
  started_at: string | null;
  ended_at: string | null;
}

export function readTurns(db: DatabaseSync): TurnRecord[] {
  const memberRows = db
    .prepare(
      `SELECT message_id, turn_id FROM message
       WHERE turn_id IS NOT NULL AND deleted_at IS NULL ORDER BY source_event_order`,
    )
    .all() as unknown as Array<{ message_id: string; turn_id: string }>;
  const membersByTurn = new Map<string, string[]>();
  for (const row of memberRows) {
    const members = membersByTurn.get(row.turn_id) ?? [];
    members.push(row.message_id);
    membersByTurn.set(row.turn_id, members);
  }

  const turnRows = db
    .prepare(
      `SELECT turn_id, turn_order, status, opened_at_event_order, closed_at_event_order,
              outcome, outcome_reason, started_at, ended_at
       FROM turns WHERE deleted_at IS NULL ORDER BY turn_order`,
    )
    .all() as unknown as RawTurnRow[];
  const placements = readPlacements(db);
  return turnRows.map((row) => {
    const record: TurnRecord = {
      turnId: row.turn_id,
      turnOrder: Number(row.turn_order),
      status: row.status as TurnRecord["status"],
      memberMessageIds: membersByTurn.get(row.turn_id) ?? [],
      openedAtEventOrder: Number(row.opened_at_event_order),
    };
    if (row.closed_at_event_order !== null) {
      record.closedAtEventOrder = Number(row.closed_at_event_order);
    }
    if (row.outcome !== null) {
      record.outcome = row.outcome as "completed" | "aborted";
    }
    if (row.outcome_reason !== null) {
      record.outcomeReason = row.outcome_reason;
    }
    if (row.started_at !== null) {
      record.startedAt = row.started_at;
    }
    if (row.ended_at !== null) {
      record.endedAt = row.ended_at;
    }
    const placement = placements.get(row.turn_id);
    if (placement !== undefined) {
      record.chunkId = placement.chunkId;
      record.memberIdx = placement.memberIdx;
    }
    return record;
  });
}

export interface TurnStructureRow {
  turnId: string;
  turnOrder: number;
  status: "open" | "closed";
  openedAtEventOrder: number;
  closedAtEventOrder: number | null;
  deleted: boolean;
}

export function readTurnStructure(db: DatabaseSync): TurnStructureRow[] {
  const rows = db
    .prepare(
      `SELECT turn_id, turn_order, status, opened_at_event_order, closed_at_event_order, deleted_at
       FROM turns ORDER BY turn_order`,
    )
    .all() as unknown as Array<RawTurnRow & { deleted_at: string | null }>;
  return rows.map((row) => ({
    turnId: row.turn_id,
    turnOrder: Number(row.turn_order),
    status: row.status as "open" | "closed",
    openedAtEventOrder: Number(row.opened_at_event_order),
    closedAtEventOrder: row.closed_at_event_order === null ? null : Number(row.closed_at_event_order),
    deleted: row.deleted_at !== null,
  }));
}
