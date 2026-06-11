// Visibility boundary (Stories 1 + 4). The boundary is a source event
// order shared with the compact point's coordinate system; tool results
// at-or-behind it render short. Its writers are exactly two: the
// post-commit advance below (Story 4) and compact's reset, which lands
// inside compact's own transaction (snapshot.ts, Story 2).
import type { DatabaseSync } from "node:sqlite";
import type { VisibilityBudgets } from "../../../shared/view.js";

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

// ── the post-commit advance (Story 4, AC-4.3–4.6, 4.9) ───────────

// The compact point for the advance's zone predicate: the stored view's, or
// the zero origin when the thread has never compacted — the same default the
// pull uses, read without dragging band bytes along.
function readCompactPoint(db: DatabaseSync): number {
  const row = db
    .prepare(`SELECT compact_point FROM thread_view WHERE singleton = 1`)
    .get() as { compact_point: number | bigint } | undefined;
  return row === undefined ? 0 : Number(row.compact_point);
}

// One zone member as the decision walks it. Rows come back oldest-first by
// source event order — the flip order AC-4.3 pins.
export interface ZoneToolResult {
  sourceEventOrder: number;
  tokenEstimate: number;
}

// The zone's member rows: the same population visibilityZoneTokens sums —
// identical WHERE clause on purpose, so the decision's arithmetic and the
// status read's sum can never diverge (story Technical Notes; TC-4.6's
// status assertion is the canary).
function readZoneToolResults(
  db: DatabaseSync,
  position: number,
  compactPoint: number,
): ZoneToolResult[] {
  const rows = db
    .prepare(
      `SELECT source_event_order, token_estimate FROM message
       WHERE kind = 'tool_result' AND deleted_at IS NULL
         AND source_event_order > ? AND source_event_order > ?
       ORDER BY source_event_order`,
    )
    .all(position, compactPoint) as unknown as Array<{
    source_event_order: number | bigint;
    token_estimate: number | bigint;
  }>;
  return rows.map((row) => ({
    sourceEventOrder: Number(row.source_event_order),
    tokenEstimate: Number(row.token_estimate),
  }));
}

// The pure decision (tech design §Boundary advance): token sums from stored
// per-message estimates, no inference, no IO — same inputs, same answer
// (AC-4.4; Boundary G1's trajectory golden drives the arithmetic).
//
// Zone is the full-rendering tool results oldest-first. Under-or-at max the
// boundary does not move. Over max, walk oldest-first accumulating flips
// until the remaining sum is at-or-under target OR the next flip would touch
// the protected set. The floor protects whole messages: walking
// newest-backward, results join the protected set until its sum first
// reaches or exceeds the floor — so the newest result is always protected
// when any exists, an oversized newest result is protected alone, and the
// zone may legally sit above target (or max) until newer batches or a
// compact create room (AC-4.5).
export function advanceDecision(
  zone: readonly ZoneToolResult[],
  budgets: VisibilityBudgets,
): number | null {
  let total = 0;
  for (const result of zone) total += result.tokenEstimate;
  if (total <= budgets.maxTokens) return null;

  // protectedStart: index of the oldest member of the protected set.
  let protectedStart = zone.length;
  let protectedSum = 0;
  while (protectedStart > 0 && protectedSum < budgets.floorTokens) {
    protectedStart -= 1;
    protectedSum += zone[protectedStart]?.tokenEstimate ?? 0;
  }

  let remaining = total;
  let newPosition: number | null = null;
  for (let i = 0; i < protectedStart && remaining > budgets.targetTokens; i += 1) {
    const flipped = zone[i];
    if (flipped === undefined) break;
    remaining -= flipped.tokenEstimate;
    newPosition = flipped.sourceEventOrder;
  }
  return newPosition;
}

// The advance executor: indexed sum → over max ⇒ decide → write the new
// position in its own short transaction (never inside intake's — AC-4.9's
// isolation; this runs at flush, strictly after intake's COMMIT). The
// position-forward guard in the UPDATE makes never-backward (AC-4.6) a
// property of the write, not just of the decision's inputs.
export function executeBoundaryAdvance(
  db: DatabaseSync,
  budgets: VisibilityBudgets,
  clock: () => Date,
): void {
  const position = readBoundaryPosition(db);
  const compactPoint = readCompactPoint(db);
  if (visibilityZoneTokens(db, position, compactPoint) <= budgets.maxTokens) return;

  const zone = readZoneToolResults(db, position, compactPoint);
  const newPosition = advanceDecision(zone, budgets);
  if (newPosition === null || newPosition <= position) return;

  db.exec("BEGIN IMMEDIATE;");
  try {
    db.prepare(
      `UPDATE view_boundary SET position = ?, updated_at = ?
       WHERE thread_singleton = 1 AND position < ?`,
    ).run(newPosition, clock().toISOString(), newPosition);
    db.exec("COMMIT;");
  } catch (cause) {
    db.exec("ROLLBACK;");
    throw cause;
  }
}
