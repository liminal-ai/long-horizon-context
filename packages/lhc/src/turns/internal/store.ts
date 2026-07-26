// Turn row operations. Writes run on the caller's handle inside the batch
// transaction; reads run on a fresh handle per operation. A closed turn has
// no writer anywhere in this module: its membership and boundaries are stable
// because no UPDATE touches closed rows.
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

// Host facts (outcome/timing) project only from a turn_end payload. Closers
// that lack them (prompt-boundary close, empty turn_end) leave NULLs.
export interface TurnCloseHostFacts {
  outcome?: "completed" | "aborted";
  outcomeReason?: string;
  startedAt?: string;
  endedAt?: string;
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

// Membership is stored on the member (message.turn_id), never as a list on
// the turn: memberMessageIds is a query, ordered by event order, so there is
// exactly one source of truth. Both halves read deleted-filtered (tech
// design §Mechanics): a deleted turn leaves the listing entirely, and a
// deleted message leaves its turn's membership — the membership shrinks in
// place, the turn row and its boundaries untouched.
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
  // Chunk placement is stored in chunk_member once derivation places the turn.
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
      // Column CHECK + null filter: only completed|aborted remain.
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

// The turn structure for compact selection: every turn row in turn order,
// including tombstoned ones (the deleted flag carried through). Unlike
// readTurns, this keeps tombstoned rows because the consumer's referential
// checks treat a tombstoned turn as a legitimate reference target, not damage
// — it separates the live selection set from the referential universe itself.
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
