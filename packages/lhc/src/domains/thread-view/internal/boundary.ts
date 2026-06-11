// Visibility-boundary read path (Story 1). The boundary is a source event
// order shared with the compact point's coordinate system; tool results
// at-or-behind it render short. Writes — the post-commit advance and
// compact's reset — land in Stories 4 and 2; this module reads only.
import type { DatabaseSync } from "node:sqlite";

// The singleton row exists from migration v6 on (seeded at position 0,
// everything full). A missing row is a damaged thread file, surfaced as a
// throw for the operation boundary's storage_failure wrap.
export function readBoundaryPosition(db: DatabaseSync): number {
  const row = db
    .prepare(`SELECT position FROM view_boundary WHERE thread_singleton = 1`)
    .get() as { position: number | bigint } | undefined;
  if (row === undefined) {
    throw new Error("view_boundary singleton row missing (migration v6 seeds it)");
  }
  return Number(row.position);
}

// The visibility zone's token sum: live (deleted-filtered) tool results ahead
// of both the boundary position and the compact point, one indexed query.
// Parameterized by position on purpose (story Technical Notes): Story 4's
// advance consumes this same function instead of re-deriving the sum, so
// "the advance's sum equals what status reports" is structural — the design
// requires the two sums equal, and sharing the query makes that a fact of
// the code rather than a discipline.
export function visibilityZoneTokens(
  db: DatabaseSync,
  position: number,
  compactPoint: number,
): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(token_estimate), 0) AS zone FROM message
       WHERE kind = 'tool_result' AND deleted_at IS NULL
         AND source_event_order > ? AND source_event_order > ?`,
    )
    .get(position, compactPoint) as { zone: number | bigint };
  return Number(row.zone);
}
