import type { ChunkRow } from "../sqlite/rows.js";
import type { JsonObject } from "../schema.js";
import type { CanonicalChunk, CanonicalTurn, StoreRuntime } from "../types.js";

export interface ChunkPlacementPlan {
  chunk: CanonicalChunk;
  operation: "insert" | "update";
}

export async function planTurnOpenChunkPlacement(runtime: StoreRuntime, turn: CanonicalTurn): Promise<ChunkPlacementPlan | undefined> {
  if (turn.lowerBandProjection?.status !== "ready") {
    return undefined;
  }

  const open = readOpenChunk(runtime, turn.threadId);
  const base = open ?? newOpenChunk(runtime, turn);
  if (base.sourceTurnIds.includes(turn.turnId)) {
    return { chunk: base, operation: open ? "update" : "insert" };
  }

  const updated = appendTurnToChunk(base, turn);
  const maybeClosed = shouldCloseChunk(runtime, turn) ? await closeChunkWithArtifacts(runtime, updated) : updated;
  return { chunk: maybeClosed, operation: open ? "update" : "insert" };
}

export function applyChunkPlacement(runtime: StoreRuntime, plan: ChunkPlacementPlan | undefined): CanonicalChunk | undefined {
  if (!plan) {
    return undefined;
  }
  if (plan.operation === "insert") {
    insertChunk(runtime, plan.chunk);
  } else {
    updateChunk(runtime, plan.chunk);
  }
  return plan.chunk;
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

function newOpenChunk(runtime: StoreRuntime, turn: CanonicalTurn): CanonicalChunk {
  const chunkOrder = nextChunkOrder(runtime, turn.threadId);
  return {
    chunkId: deterministicChunkId(turn.threadId, chunkOrder),
    threadId: turn.threadId,
    chunkOrder,
    lifecycleStatus: "open",
    sourceTurnIds: [],
    smoothText: "",
    lowerBand: { text: "" },
  };
}

function appendTurnToChunk(chunk: CanonicalChunk, turn: CanonicalTurn): CanonicalChunk {
  return {
    ...chunk,
    sourceTurnIds: [...chunk.sourceTurnIds, turn.turnId],
    smoothText: [chunk.smoothText, String(turn.smooth?.text ?? "")].filter((part) => part.length > 0).join("\n\n"),
    lowerBand: {
      ...(chunk.lowerBand ?? {}),
      text: [String(chunk.lowerBand?.text ?? ""), String(turn.lowerBandProjection?.text ?? "")].filter((part) => part.length > 0).join("\n\n"),
    },
  };
}

async function closeChunkWithArtifacts(runtime: StoreRuntime, chunk: CanonicalChunk): Promise<CanonicalChunk> {
  const text = String(chunk.lowerBand?.text ?? chunk.smoothText);
  const detailed = await compressChunkBand(runtime, chunk, "detailed", text);
  const brief = await compressChunkBand(runtime, chunk, "brief", text);
  return {
    ...chunk,
    lifecycleStatus: "closed",
    lowerBand: {
      ...(chunk.lowerBand ?? {}),
      detailed,
      brief,
    },
  };
}

async function compressChunkBand(
  runtime: StoreRuntime,
  chunk: CanonicalChunk,
  band: "detailed" | "brief",
  text: string,
): Promise<JsonObject> {
  if (!runtime.options.chunkCompressionProvider) {
    return {
      status: "failed",
      errorCode: "CHUNK_COMPRESSION_PROVIDER_MISSING",
      errorMessage: "Chunk compression provider is required for chunk close projection.",
    };
  }
  const compressed = await runtime.options.chunkCompressionProvider.compressChunk({
    threadId: chunk.threadId,
    chunkId: chunk.chunkId,
    band,
    text,
  });
  return {
    status: "ready",
    text: compressed.text,
    ...(compressed.metadata === undefined ? {} : { metadata: compressed.metadata }),
  };
}

function shouldCloseChunk(runtime: StoreRuntime, turn: CanonicalTurn): boolean {
  const count = tokenCount(turn.lowerBandProjection?.tokenCountMetadata);
  const softMax = runtime.options.chunkPolicy?.targetSoftMaxSmoothTokens ?? 2200;
  return count >= softMax;
}

function tokenCount(value: unknown): number {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return 0;
  }
  const count = (value as { count?: unknown }).count;
  return typeof count === "number" ? count : 0;
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

function nextChunkOrder(runtime: StoreRuntime, threadId: string): number {
  const row = runtime.db.db.prepare(`
    SELECT MAX(chunk_order) AS max_chunk_order
    FROM chunk
    WHERE thread_id = ?
  `).get(threadId) as { max_chunk_order: number | null } | undefined;
  return (row?.max_chunk_order ?? 0) + 1;
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
    SET lifecycle_status = ?, source_turn_ids_json = ?, smooth_text = ?, lower_band_json = ?
    WHERE chunk_id = ?
  `).run(
    chunk.lifecycleStatus,
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
