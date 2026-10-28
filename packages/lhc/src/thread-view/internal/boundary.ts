import type { DatabaseSync } from "node:sqlite";
import { resolveInstanceTokenEstimator } from "../../shared-tech/index.js";

export function readBoundaryPosition(db: DatabaseSync): number {
  const row = db.prepare(`SELECT position FROM view_boundary WHERE thread_singleton = 1`).get() as
    | { position: number | bigint }
    | undefined;
  if (row === undefined) {
    throw new Error("view_boundary singleton row missing (thread creation seeds it)");
  }
  return Number(row.position);
}

export function visibilityZoneTokens(db: DatabaseSync, position: number, compactPoint: number): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(token_estimate), 0) AS zone FROM message
       WHERE kind = 'tool_result' AND deleted_at IS NULL
         AND source_event_order > ? AND source_event_order > ?`,
    )
    .get(position, compactPoint) as { zone: number | bigint };
  return resolveInstanceTokenEstimator("threadView.status").weigh(Number(row.zone));
}
