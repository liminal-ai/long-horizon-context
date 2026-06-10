import { DatabaseSync } from "node:sqlite";

// The one sanctioned below-SDK write in the test suite: inserts a second
// status='open' turn row, a state no public operation can produce.
// Shape only until Story 4 lands the turn schema; column names firm up there.
export function corruptTwoOpenTurns(path: string): void {
  const db = new DatabaseSync(path);
  try {
    const row = db
      .prepare("SELECT MAX(turn_order) AS max_order FROM turns")
      .get() as { max_order: number | bigint | null } | undefined;
    const nextOrder = Number(row?.max_order ?? 0) + 1;
    db.prepare(
      "INSERT INTO turns (turn_id, turn_order, status, opened_at_event_order) VALUES (?, ?, 'open', ?)",
    ).run(`t${nextOrder}`, nextOrder, 0);
  } finally {
    db.close();
  }
}
