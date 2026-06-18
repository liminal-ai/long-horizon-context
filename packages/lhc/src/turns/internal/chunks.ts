// Chunk mechanics (Flow 3, DD-9): open-chunk append, the accumulated close
// policy, and the close→summary enqueues. Placement is pure arithmetic over
// stored projected token counts — the caller hands in the incoming turn's
// count, the open chunk carries its accumulated count durably — so identical
// streams re-chunk identically (AC-3.9): no clock, no inference, no
// re-estimation at placement time. Everything here runs inside the
// turn-derivation completion transaction; a crash leaves either a placed
// turn (with any close's summary enqueues) or nothing.
import type { DatabaseSync } from "node:sqlite";
import type { OperationContext } from "../../shared-tech/index.js";
import { enqueue, type WorkItemRecord } from "../../shared-tech/work-queue/index.js";

export interface ChunkPolicy {
  targetProjectedTokens: number;
  maxProjectedTokens: number;
}

export interface PlacementResult {
  chunkId: string;
  memberIdx: number;
  // Chunks closed by this placement, in close order: at most the previous
  // open chunk (accumulation rule) and then the incoming turn's own chunk
  // (max rule) — a turn ≥ max arriving behind an open chunk closes both.
  closedChunkIds: string[];
  // An explicitly rebuilt turn keeps its placement (membership shrinks only
  // through Story 6's sanctioned mutation, never re-cuts): a turn already a
  // member is left exactly where it is and nothing closes.
  alreadyPlaced: boolean;
}

interface OpenChunkRow {
  chunk_id: string;
  accumulated_projected_tokens: number | bigint;
}

function memberCount(db: DatabaseSync, chunkId: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM chunk_member WHERE chunk_id = ?`).get(chunkId) as unknown as {
    n: number | bigint;
  };
  return Number(row.n);
}

function closeChunk(db: DatabaseSync, chunkId: string): void {
  db.prepare(`UPDATE chunk SET status = 'closed' WHERE chunk_id = ?`).run(chunkId);
}

function openNextChunk(db: DatabaseSync): string {
  const row = db.prepare(`SELECT MAX(chunk_order) AS max_order FROM chunk`).get() as
    | { max_order: number | bigint | null }
    | undefined;
  const order = Number(row?.max_order ?? 0) + 1;
  const chunkId = `c${order}`;
  db.prepare(
    `INSERT INTO chunk (chunk_id, chunk_order, status, accumulated_projected_tokens)
     VALUES (?, ?, 'open', 0)`,
  ).run(chunkId, order);
  return chunkId;
}

// The close policy, golden cases exact (DD-9): when the open chunk's
// accumulated count plus the incoming turn's would reach the target
// (inclusive — equality closes), the chunk closes holding its current
// members and the incoming turn opens the next chunk; a single projection
// ≥ max closes its own chunk immediately. An empty open chunk always accepts
// the incoming turn — a chunk never closes empty.
export function placeTurn(
  db: DatabaseSync,
  turnId: string,
  projectedTokens: number,
  policy: ChunkPolicy,
): PlacementResult {
  const existing = db
    .prepare(`SELECT chunk_id, member_idx FROM chunk_member WHERE turn_id = ?`)
    .get(turnId) as unknown as { chunk_id: string; member_idx: number | bigint } | undefined;
  if (existing !== undefined) {
    return {
      chunkId: existing.chunk_id,
      memberIdx: Number(existing.member_idx),
      closedChunkIds: [],
      alreadyPlaced: true,
    };
  }

  const closedChunkIds: string[] = [];
  let open = db
    .prepare(
      `SELECT chunk_id, accumulated_projected_tokens FROM chunk
       WHERE status = 'open' ORDER BY chunk_order DESC LIMIT 1`,
    )
    .get() as unknown as OpenChunkRow | undefined;

  if (
    open !== undefined &&
    memberCount(db, open.chunk_id) > 0 &&
    Number(open.accumulated_projected_tokens) + projectedTokens >= policy.targetProjectedTokens
  ) {
    // Crossing closes *without* the incoming turn — the v1 bug's fix: the
    // decision weighs accumulated + incoming, and the incoming turn starts
    // the next chunk (AC-3.6).
    closeChunk(db, open.chunk_id);
    closedChunkIds.push(open.chunk_id);
    open = undefined;
  }

  const chunkId = open?.chunk_id ?? openNextChunk(db);
  const memberIdx = memberCount(db, chunkId);
  db.prepare(`INSERT INTO chunk_member (chunk_id, turn_id, member_idx) VALUES (?, ?, ?)`).run(
    chunkId,
    turnId,
    memberIdx,
  );
  db.prepare(
    `UPDATE chunk SET accumulated_projected_tokens = accumulated_projected_tokens + ?
     WHERE chunk_id = ?`,
  ).run(projectedTokens, chunkId);

  if (projectedTokens >= policy.maxProjectedTokens) {
    // Max rule (AC-3.7): the projection alone meets the maximum, so the
    // turn's chunk closes immediately, whatever it holds.
    closeChunk(db, chunkId);
    closedChunkIds.push(chunkId);
  }

  return { chunkId, memberIdx, closedChunkIds, alreadyPlaced: false };
}

// Closing queues the two summary kinds as two work items with independent
// retry, states, and re-queue (AC-3.8); both enqueues ride the caller's
// ambient transaction — the completion commit — per DD-5.
export function enqueueChunkSummaries(ctx: OperationContext, chunkId: string): WorkItemRecord[] {
  return (["chunk_summary_detailed", "chunk_summary_brief"] as const).map((kind) =>
    enqueue(ctx, {
      owner: "turns",
      kind,
      sourceRef: { chunkId },
      derivations: [{ subjectKind: "chunk", subjectId: chunkId, derivationType: kind }],
    }),
  );
}

// Placement read-back for the turns surface (AC-3.5): chunkId + memberIdx by
// turn, one query, stored values only.
export function readPlacements(db: DatabaseSync): Map<string, { chunkId: string; memberIdx: number }> {
  const rows = db.prepare(`SELECT turn_id, chunk_id, member_idx FROM chunk_member`).all() as unknown as Array<{
    turn_id: string;
    chunk_id: string;
    member_idx: number | bigint;
  }>;
  const byTurn = new Map<string, { chunkId: string; memberIdx: number }>();
  for (const row of rows) {
    byTurn.set(row.turn_id, { chunkId: row.chunk_id, memberIdx: Number(row.member_idx) });
  }
  return byTurn;
}
