// Chunk mechanics: open-chunk append, the accumulated close policy, and the
// close-to-summary enqueues. Placement is pure arithmetic over stored projected
// token counts. The caller hands in the incoming turn's count, the open chunk
// carries its accumulated count durably, and placement never uses clock,
// inference, or token re-estimation. Everything here runs inside the
// turn-derivation completion transaction; a crash leaves either a placed turn
// with any close's summary enqueues or nothing.
import type { DatabaseSync } from "node:sqlite";
import type { DbWriteTransaction } from "../../shared-tech/index.js";
import { enqueue, supersedeQueued, type WorkItemRecord } from "../../shared-tech/work-queue/index.js";

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
  // An explicitly rebuilt turn keeps its placement. Sanctioned delete rebuilds
  // chunk summaries from surviving members without changing chunk membership.
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

// The close policy: when the open chunk's accumulated count plus the incoming
// turn's count would reach the target, equality included, the chunk closes
// holding its current members and the incoming turn opens the next chunk. A
// single turn at or above max closes its own chunk immediately. An empty open
// chunk always accepts the incoming turn; a chunk never closes empty.
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
    // Crossing closes without the incoming turn: the decision weighs
    // accumulated + incoming, and the incoming turn starts the next chunk.
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
    // Max rule: the incoming turn alone meets the maximum, so its chunk closes
    // immediately, whatever it holds.
    closeChunk(db, chunkId);
    closedChunkIds.push(chunkId);
  }

  return { chunkId, memberIdx, closedChunkIds, alreadyPlaced: false };
}

// Closing queues the two summary kinds as independent work items. Both enqueues
// ride the caller's ambient completion transaction.
export function enqueueChunkSummaries(transaction: DbWriteTransaction, chunkId: string): WorkItemRecord[] {
  return (["chunk_summary_detailed", "chunk_summary_brief"] as const).map((kind) =>
    enqueue(transaction, {
      owner: "turns",
      kind,
      sourceRef: { chunkId },
      derivations: [{ subjectKind: "chunk", subjectId: chunkId, derivationType: kind }],
    }),
  );
}

// The chunk structure for compact selection: every chunk in chunk order with
// its raw membership in member order. Membership is NOT filtered by turn
// liveness — references are returned as stored so the consumer can run its
// own referential check (a member pointing at no turn row at all is damage;
// a member pointing at a tombstoned turn is not). This is why it does not
// reuse readChunkRows, whose live-turn join would hide both cases.
export interface ChunkStructureRow {
  chunkId: string;
  chunkOrder: number;
  status: "open" | "closed";
  memberTurnIds: string[];
}

export function readChunkStructure(db: DatabaseSync): ChunkStructureRow[] {
  const chunkRows = db
    .prepare(`SELECT chunk_id, chunk_order, status FROM chunk ORDER BY chunk_order`)
    .all() as unknown as Array<{ chunk_id: string; chunk_order: number | bigint; status: string }>;
  const memberRows = db
    .prepare(
      `SELECT cm.chunk_id, cm.turn_id FROM chunk_member cm
       JOIN chunk c ON c.chunk_id = cm.chunk_id
       ORDER BY c.chunk_order, cm.member_idx`,
    )
    .all() as unknown as Array<{ chunk_id: string; turn_id: string }>;
  const membersByChunk = new Map<string, string[]>();
  for (const row of memberRows) {
    const members = membersByChunk.get(row.chunk_id) ?? [];
    members.push(row.turn_id);
    membersByChunk.set(row.chunk_id, members);
  }
  return chunkRows.map((row) => ({
    chunkId: row.chunk_id,
    chunkOrder: Number(row.chunk_order),
    status: row.status as "open" | "closed",
    memberTurnIds: membersByChunk.get(row.chunk_id) ?? [],
  }));
}

// A tombstoned turn remains a legitimate stable-address record, but a derived
// chunk whose every member turn is tombstoned has no readable source. Such a
// chunk must not survive as an input to compact: its summaries describe content
// the readable projection intentionally removed. Cleanup is deliberately
// revalidated at write time because preview/selection may have read the file
// before another process acquired the compact transaction.
export function dropEmptyReadableChunks(db: DatabaseSync, candidates: readonly string[]): string[] {
  const dropped: string[] = [];
  const hasReadableMember = db.prepare(
    `SELECT 1 FROM chunk_member cm
     JOIN turns t ON t.turn_id = cm.turn_id AND t.deleted_at IS NULL
     WHERE cm.chunk_id = ? LIMIT 1`,
  );
  const hasClaimedWork = db.prepare(
    `SELECT 1 FROM work_item
     WHERE status = 'claimed' AND source_ref = ?
       AND kind IN ('chunk_summary_detailed', 'chunk_summary_brief')
     LIMIT 1`,
  );
  const dropDerivations = db.prepare(`DELETE FROM derivation WHERE subject_kind = 'chunk' AND subject_id = ?`);
  const dropMembers = db.prepare(`DELETE FROM chunk_member WHERE chunk_id = ?`);
  const dropChunk = db.prepare(`DELETE FROM chunk WHERE chunk_id = ?`);

  for (const chunkId of [...new Set(candidates)]) {
    if (hasReadableMember.get(chunkId) !== undefined) continue;
    const sourceRef = { chunkId };
    if (hasClaimedWork.get(JSON.stringify(sourceRef)) !== undefined) continue;
    supersedeQueued(db, [
      { kind: "chunk_summary_detailed", sourceRef },
      { kind: "chunk_summary_brief", sourceRef },
    ]);
    dropDerivations.run(chunkId);
    dropMembers.run(chunkId);
    dropChunk.run(chunkId);
    dropped.push(chunkId);
  }
  return dropped;
}

// Placement read-back for the turns surface: chunkId + memberIdx by turn, one
// query, stored values only.
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
