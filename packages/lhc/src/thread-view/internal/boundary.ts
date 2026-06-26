// Visibility boundary. The boundary is a source event order shared with the
// compact point's coordinate system; tool results at-or-behind it render short.
// Compact resets it inside compact's own transaction.
import type { DatabaseSync } from "node:sqlite";

// The singleton row is seeded at thread creation (position 0, everything full).
// A missing row is a damaged thread file, surfaced as a throw for the
// operation boundary's storage_failure wrap.
export function readBoundaryPosition(db: DatabaseSync): number {
  const row = db.prepare(`SELECT position FROM view_boundary WHERE thread_singleton = 1`).get() as
    | { position: number | bigint }
    | undefined;
  if (row === undefined) {
    throw new Error("view_boundary singleton row missing (thread creation seeds it)");
  }
  return Number(row.position);
}

// The visibility zone's token sum: live (deleted-filtered) tool results ahead
// of both the boundary position and the compact point, one indexed query.
export function visibilityZoneTokens(db: DatabaseSync, position: number, compactPoint: number): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(token_estimate), 0) AS zone FROM message
       WHERE kind = 'tool_result' AND deleted_at IS NULL
         AND source_event_order > ? AND source_event_order > ?`,
    )
    .get(position, compactPoint) as { zone: number | bigint };
  return Number(row.zone);
}
