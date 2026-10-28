import type { DatabaseSync } from "node:sqlite";
import type { DbWriteTransaction } from "../../shared-tech/index.js";
import type { TokenEstimator } from "../../shared-tech/token-counting/index.js";
import { enqueue, supersedeQueued, type WorkItemRecord } from "../../shared-tech/work-queue/index.js";

export interface ChunkPolicy {
  targetProjectedTokens: number;
  maxProjectedTokens: number;
}

export interface PlacementResult {
  chunkId: string;
  memberIdx: number;
  closedChunkIds: string[];
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

export function placeTurn(
  db: DatabaseSync,
  turnId: string,
  projectedTokens: number,
  policy: ChunkPolicy,
  estimator: TokenEstimator,
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
    estimator.weigh(Number(open.accumulated_projected_tokens) + projectedTokens) >= policy.targetProjectedTokens
  ) {
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

  if (estimator.weigh(projectedTokens) >= policy.maxProjectedTokens) {
    closeChunk(db, chunkId);
    closedChunkIds.push(chunkId);
  }

  return { chunkId, memberIdx, closedChunkIds, alreadyPlaced: false };
}

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
