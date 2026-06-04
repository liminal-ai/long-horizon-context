import type { ChunkRow } from "../sqlite/rows.js";
import type { JsonObject } from "../schema.js";
import type { CanonicalChunk, CanonicalTurn, StoreRuntime } from "../types.js";

export function placeTurnInOpenChunk(runtime: StoreRuntime, turn: CanonicalTurn): CanonicalChunk | undefined {
  if (turn.lowerBandProjection?.status !== "ready") {
    return undefined;
  }

  const open = readOpenChunk(runtime, turn.threadId);
  if (!open) {
    const chunk: CanonicalChunk = {
      chunkId: deterministicChunkId(turn.threadId, 1),
      threadId: turn.threadId,
      chunkOrder: 1,
      lifecycleStatus: "open",
      sourceTurnIds: [turn.turnId],
      smoothText: String(turn.smooth?.text ?? ""),
      lowerBand: { text: String(turn.lowerBandProjection.text ?? "") },
    };
    insertChunk(runtime, chunk);
    return chunk;
  }

  if (open.sourceTurnIds.includes(turn.turnId)) {
    return open;
  }

  const updated: CanonicalChunk = {
    ...open,
    sourceTurnIds: [...open.sourceTurnIds, turn.turnId],
    smoothText: [open.smoothText, String(turn.smooth?.text ?? "")].filter((part) => part.length > 0).join("\n\n"),
    lowerBand: {
      ...(open.lowerBand ?? {}),
      text: [String(open.lowerBand?.text ?? ""), String(turn.lowerBandProjection.text ?? "")].filter((part) => part.length > 0).join("\n\n"),
    },
  };
  updateChunk(runtime, updated);
  return updated;
}

export async function readChunkRecords(runtime: StoreRuntime, clientThreadId?: string): Promise<CanonicalChunk[]> {
  const rows = clientThreadId === undefined
    ? runtime.db.db.prepare(`SELECT * FROM chunk ORDER BY thread_id ASC, chunk_order ASC`).all() as unknown as ChunkRow[]
    : runtime.db.db.prepare(`
        SELECT chunk.*
        FROM chunk
        JOIN thread ON thread.thread_id = chunk.thread_id
        WHERE thread.client_thread_id = ?
        ORDER BY chunk.chunk_order ASC
      `).all(clientThreadId) as unknown as ChunkRow[];
  return rows.map(rowToChunk);
}

function readOpenChunk(runtime: StoreRuntime, threadId: string): CanonicalChunk | undefined {
  const row = runtime.db.db.prepare(`
    SELECT *
    FROM chunk
    WHERE thread_id = ? AND lifecycle_status = 'open'
    ORDER BY chunk_order DESC
    LIMIT 1
  `).get(threadId) as ChunkRow | undefined;
  return row === undefined ? undefined : rowToChunk(row);
}

function insertChunk(runtime: StoreRuntime, chunk: CanonicalChunk): void {
  runtime.db.db.prepare(`
    INSERT INTO chunk (
      chunk_id,
      thread_id,
      chunk_order,
      lifecycle_status,
      source_turn_ids_json,
      smooth_text,
      lower_band_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    chunk.chunkId,
    chunk.threadId,
    chunk.chunkOrder,
    chunk.lifecycleStatus,
    JSON.stringify(chunk.sourceTurnIds),
    chunk.smoothText,
    chunk.lowerBand === undefined ? null : JSON.stringify(chunk.lowerBand),
  );
}

function updateChunk(runtime: StoreRuntime, chunk: CanonicalChunk): void {
  runtime.db.db.prepare(`
    UPDATE chunk
    SET source_turn_ids_json = ?, smooth_text = ?, lower_band_json = ?
    WHERE chunk_id = ?
  `).run(
    JSON.stringify(chunk.sourceTurnIds),
    chunk.smoothText,
    chunk.lowerBand === undefined ? null : JSON.stringify(chunk.lowerBand),
    chunk.chunkId,
  );
}

function rowToChunk(row: ChunkRow): CanonicalChunk {
  return {
    chunkId: row.chunk_id,
    threadId: row.thread_id,
    chunkOrder: row.chunk_order,
    lifecycleStatus: row.lifecycle_status as CanonicalChunk["lifecycleStatus"],
    sourceTurnIds: JSON.parse(row.source_turn_ids_json) as string[],
    smoothText: row.smooth_text,
    ...(row.lower_band_json === null ? {} : { lowerBand: JSON.parse(row.lower_band_json) as JsonObject }),
  };
}

function deterministicChunkId(threadId: string, chunkOrder: number): string {
  return `chunk_${threadId}_${chunkOrder}`.replace(/[^a-zA-Z0-9_-]/g, "_");
}
