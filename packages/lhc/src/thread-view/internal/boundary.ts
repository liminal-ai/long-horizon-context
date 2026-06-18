// Visibility boundary (Epic 03 Stories 1 + 4, decision reshaped by Epic 05
// Story 6). The boundary is a source event order shared with the compact
// point's coordinate system; tool results at-or-behind it render short. Its
// writers are exactly two: the post-commit advance below — gated by intake
// to turn-end batches since Epic 05 — and compact's reset, which lands
// inside compact's own transaction (snapshot.ts, Story 2).
import type { DatabaseSync } from "node:sqlite";
import type { VisibilityBudgets } from "../../shared-tech/index.js";

// The singleton row exists from migration v6 on (seeded at position 0,
// everything full). A missing row is a damaged thread file, surfaced as a
// throw for the operation boundary's storage_failure wrap.
export function readBoundaryPosition(db: DatabaseSync): number {
  const row = db.prepare(`SELECT position FROM view_boundary WHERE thread_singleton = 1`).get() as
    | { position: number | bigint }
    | undefined;
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

// ── the post-commit advance (Story 4, AC-4.3–4.6, 4.9) ───────────

// The compact point for the advance's zone predicate: the stored view's, or
// the zero origin when the thread has never compacted — the same default the
// pull uses, read without dragging band bytes along.
function readCompactPoint(db: DatabaseSync): number {
  const row = db.prepare(`SELECT compact_point FROM thread_view WHERE singleton = 1`).get() as
    | { compact_point: number | bigint }
    | undefined;
  return row === undefined ? 0 : Number(row.compact_point);
}

// One zone member as the decision walks it. Rows come back oldest-first by
// source event order — the flip order AC-4.3 pins. turn_id carries the
// whole-turn grouping key (Epic 05 AC-5.2); NULL means turnless intake.
export interface ZoneToolResult {
  sourceEventOrder: number;
  tokenEstimate: number;
  turnId: string | null;
}

// The zone's member rows: the same population visibilityZoneTokens sums —
// identical WHERE clause on purpose, so the decision's arithmetic and the
// status read's sum can never diverge (story Technical Notes; the amended
// boundary suite's status assertions are the canary).
function readZoneToolResults(db: DatabaseSync, position: number, compactPoint: number): ZoneToolResult[] {
  const rows = db
    .prepare(
      `SELECT source_event_order, token_estimate, turn_id FROM message
       WHERE kind = 'tool_result' AND deleted_at IS NULL
         AND source_event_order > ? AND source_event_order > ?
       ORDER BY source_event_order`,
    )
    .all(position, compactPoint) as unknown as Array<{
    source_event_order: number | bigint;
    token_estimate: number | bigint;
    turn_id: string | null;
  }>;
  return rows.map((row) => ({
    sourceEventOrder: Number(row.source_event_order),
    tokenEstimate: Number(row.token_estimate),
    turnId: row.turn_id,
  }));
}

// The open turn, if any, read for eviction candidacy: its tool results count
// in the zone sum (status must show a mid-turn over-budget condition) but its
// group can never be evicted. With the turn-end trigger this is normally
// vacuous — the just-closed turn left nothing open — but a batch may legally
// record a turn_end and then open a new turn with tool results before
// committing, and that open turn must not be eaten (Epic 05 AC-5.3's
// open-turn untouchability, made explicit rather than assumed).
function readOpenTurnId(db: DatabaseSync): string | null {
  const row = db.prepare(`SELECT turn_id FROM turns WHERE status = 'open' AND deleted_at IS NULL LIMIT 1`).get() as
    | { turn_id: string }
    | undefined;
  return row?.turn_id ?? null;
}

// One whole-turn eviction unit (Epic 05 DD-10): consecutive zone rows sharing
// a turn_id. A NULL turn_id row is its own singleton group — whole-turn
// semantics degenerate to whole-message for messages belonging to no turn.
export interface ZoneTurnGroup {
  turnId: string | null;
  tokenSum: number;
  // Highest source_event_order in the group: the boundary position an
  // eviction of this group lands on.
  lastSourceEventOrder: number;
}

export function groupZone(zone: readonly ZoneToolResult[]): ZoneTurnGroup[] {
  const groups: ZoneTurnGroup[] = [];
  for (const result of zone) {
    const current = groups[groups.length - 1];
    if (current !== undefined && current.turnId !== null && current.turnId === result.turnId) {
      current.tokenSum += result.tokenEstimate;
      current.lastSourceEventOrder = result.sourceEventOrder;
    } else {
      groups.push({
        turnId: result.turnId,
        tokenSum: result.tokenEstimate,
        lastSourceEventOrder: result.sourceEventOrder,
      });
    }
  }
  return groups;
}

// The pure decision (Epic 05 tech design §Flow 5): token sums from stored
// per-message estimates, no inference, no IO — same inputs, same answer
// (AC-5.5 determinism; the re-cut Boundary G1 golden drives the arithmetic,
// golden G2 the peek-ahead landing).
//
// Zone is the turn-grouped tool results oldest-first. Under-or-at max the
// boundary does not move. Over max, walk candidate groups oldest-first — the
// open turn's group (when one exists) is never a candidate, and the walk stops
// before the newest closed turn so that turn and everything after it (any
// trailing turnless singletons recorded after its close) are never evicted
// (AC-5.3: the newest closed turn is never evicted). The boundary lands on a
// group's last source event order, so an eviction reaching the newest closed
// turn — or any group past it — would render that turn short; stopping before
// it keeps it intact even when a later turnless singleton sits in the zone.
// With no closed turn present the newest remaining group is protected instead
// (whole-message degeneration for a turnless-only zone). A group is evicted
// only if the zone's sum after evicting it remains at-or-above target (the
// peek-ahead stop). The advance therefore lands in [target, target + one
// group), and the zone may legally sit above target or even max until a newer
// turn closes or a compact creates room.
export function advanceDecision(
  groups: readonly ZoneTurnGroup[],
  budgets: VisibilityBudgets,
  openTurnId: string | null,
): number | null {
  let total = 0;
  for (const group of groups) total += group.tokenSum;
  if (total <= budgets.maxTokens) return null;

  // The open turn's group is never evictable; its tokens still count in the sum.
  const candidates = groups.filter((group) => group.turnId === null || group.turnId !== openTurnId);

  // Stop the walk before the newest closed turn — the last candidate carrying a
  // turn_id. It and everything after it (the turn itself plus any trailing
  // turnless singletons) are protected: the boundary lands on a group's last
  // order, so any landing there or beyond would flip the newest closed turn
  // short. With no closed turn in the zone, fall back to protecting the newest
  // candidate group (the turnless-only whole-message behavior).
  let stop = candidates.length - 1;
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    if (candidates[i]?.turnId !== null) {
      stop = i;
      break;
    }
  }

  let remaining = total;
  let newPosition: number | null = null;
  for (let i = 0; i < stop; i += 1) {
    const group = candidates[i];
    if (group === undefined) break;
    if (remaining - group.tokenSum < budgets.targetTokens) break;
    remaining -= group.tokenSum;
    newPosition = group.lastSourceEventOrder;
  }
  return newPosition;
}

// The advance executor: indexed sum → over max ⇒ decide → write the new
// position in its own short transaction (never inside intake's — AC-4.9's
// isolation; this runs at flush, strictly after intake's COMMIT). The
// position-forward guard in the UPDATE makes never-backward (AC-4.6) a
// property of the write, not just of the decision's inputs.
export function executeBoundaryAdvance(db: DatabaseSync, budgets: VisibilityBudgets, clock: () => Date): void {
  const position = readBoundaryPosition(db);
  const compactPoint = readCompactPoint(db);
  if (visibilityZoneTokens(db, position, compactPoint) <= budgets.maxTokens) return;

  const zone = readZoneToolResults(db, position, compactPoint);
  const newPosition = advanceDecision(groupZone(zone), budgets, readOpenTurnId(db));
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
