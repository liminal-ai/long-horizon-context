// The bounded execution plan: the same walk, fed from turn/message metadata
// aggregates instead of hydrated records.
//
// What it reads up front is bounded by structure, never by conversation
// length: turn rows, chunk rows and membership, one derivation row per subject
// with its state but not its content, and one aggregate row per turn
// (oldest/newest live message order, token sum, count). The compact point
// comes off a newest-first keyset page over message metadata, so it reads the
// tail it is measuring and stops — not the whole record.
//
// What it reads on demand is bounded by the walk: a turn's excerpt only when
// both stored smooth rungs are unusable, a chunk's stored-member material only
// when its summary derivation is unusable, a derivation's content only when
// the rung that renders it is reached. A historical candidate the walk passes
// over is never hydrated, so an unreadable or oversized block on one costs
// nothing — the arrangement is the same either way, because the eager plan
// omits blocked material too.
import type { DatabaseSync } from "node:sqlite";
import type { DbReadTransaction, SkippedRecord } from "../../shared-tech/index.js";
import * as turnsDomain from "../../turns/index.js";
import type { CompactChunkMaterialSnapshot, DerivationSnapshot } from "./render.js";
import { excerptLine } from "./render.js";
import type { ArrangementSourceState, ChunkSummaryType } from "./select.js";
import { orphanedMessageSkip, shapeChunks, shapeTurns } from "./selection-structure.js";
import type { SelectionSource } from "./walk.js";

/** Raised when the caller's abort signal trips inside an on-demand read. */
export class CompactStoppedError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = "CompactStoppedError";
  }
}

/**
 * What the plan actually loaded, for the load-bound proof and the mature-thread
 * measurements. Not part of any receipt or public contract.
 */
export interface BoundedSelectionStats {
  /** Statements executed through this source, eager reads included. */
  queries: number;
  /** Message-metadata rows the compact-point keyset walk consumed. */
  compactPointRowsScanned: number;
  /** Turns whose raw messages were hydrated for a smooth excerpt. */
  turnExcerptHydrations: number;
  /** message_block rows read (excerpts only — chunk material reads its own). */
  messageBlockRowsRead: number;
  /** Chunks whose stored-member material was resolved. */
  chunkMaterialResolutions: number;
  /** Derivation rows whose content column was read back. */
  derivationContentReads: number;
}

export interface BoundedSelection {
  source: SelectionSource;
  sourceState: ArrangementSourceState;
  stats: BoundedSelectionStats;
}

interface TurnMessageAggregate {
  minOrder: number;
  maxOrder: number;
  tokens: number;
  count: number;
}

interface DerivationIndexEntry {
  subjectKind: string;
  state: DerivationSnapshot["state"];
  contentNull: boolean;
}

// Enough rows per page that the full band's tail resolves in one or two reads,
// small enough that the bound holds on a record of any length.
const COMPACT_POINT_PAGE_SIZE = 512;

// Live and placeable: the message is not deleted, its source event still
// exists, and its turn resolves to a live turn. This is exactly the population
// the eager plan's message list holds after its orphan filter.
const PLACEABLE_MESSAGE_FROM = `FROM message m
       JOIN event e ON e.event_order = m.source_event_order
       JOIN turns t ON t.turn_id = m.turn_id AND t.deleted_at IS NULL
       WHERE m.deleted_at IS NULL`;

export function createBoundedSelection(
  db: DatabaseSync,
  transaction: DbReadTransaction,
  opts: { includeChunkMaterials: boolean; signal?: { aborted: boolean } | undefined },
): BoundedSelection {
  const stats: BoundedSelectionStats = {
    queries: 0,
    compactPointRowsScanned: 0,
    turnExcerptHydrations: 0,
    messageBlockRowsRead: 0,
    chunkMaterialResolutions: 0,
    derivationContentReads: 0,
  };
  const counted = <T>(run: () => T): T => {
    stats.queries += 1;
    return run();
  };

  // ── structure: bounded by turn and chunk counts ────────────────
  const structure = counted(() => turnsDomain.readTurnChunkStructure(db));
  const shaped = shapeTurns(structure);
  const skippedRecords: SkippedRecord[] = [];

  // Orphans first, then dangling members: the eager plan reports them in that
  // order because it reads messages before chunks, and the receipt's
  // skippedRecords order is observable.
  const orphanRows = counted(
    () =>
      db
        .prepare(
          `SELECT m.message_id, m.turn_id
       FROM message m
       JOIN event e ON e.event_order = m.source_event_order
       WHERE m.deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM turns t WHERE t.turn_id = m.turn_id AND t.deleted_at IS NULL)
       ORDER BY m.source_event_order`,
        )
        .all() as unknown as Array<{ message_id: string; turn_id: string }>,
  );
  for (const row of orphanRows) skippedRecords.push(orphanedMessageSkip(row.message_id, row.turn_id));

  const { chunks, emptyChunkIds } = shapeChunks(structure, shaped, skippedRecords);

  // ── message metadata: one aggregate row per turn ───────────────
  const aggregateRows = counted(
    () =>
      db
        .prepare(
          `SELECT m.turn_id AS turn_id, MIN(m.source_event_order) AS min_order,
              MAX(m.source_event_order) AS max_order, SUM(m.token_estimate) AS tokens,
              COUNT(*) AS n
       ${PLACEABLE_MESSAGE_FROM}
       GROUP BY m.turn_id`,
        )
        .all() as unknown as Array<{
        turn_id: string;
        min_order: number | bigint;
        max_order: number | bigint;
        tokens: number | bigint;
        n: number | bigint;
      }>,
  );
  const turnAggregates = new Map<string, TurnMessageAggregate>(
    aggregateRows.map((row) => [
      row.turn_id,
      {
        minOrder: Number(row.min_order),
        maxOrder: Number(row.max_order),
        tokens: Number(row.tokens),
        count: Number(row.n),
      },
    ]),
  );

  // ── derivation index: state without content ────────────────────
  // Same unordered scan the eager plan runs, minus the content column, so the
  // derivation counts land in the same key order — they are stored verbatim in
  // the view's source_state_json.
  const derivationRows = counted(
    () =>
      db
        .prepare(
          `SELECT subject_kind, subject_id, derivation_type, state, (content IS NULL) AS content_null
       FROM derivation`,
        )
        .all() as unknown as Array<{
        subject_kind: string;
        subject_id: string;
        derivation_type: string;
        state: string;
        content_null: number | bigint;
      }>,
  );
  const derivationIndex = new Map<string, DerivationIndexEntry>();
  const emptyChunkSet = new Set(emptyChunkIds);
  const derivationCounts: Record<string, Record<string, number>> = {};
  for (const row of derivationRows) {
    if (row.subject_kind === "chunk" && emptyChunkSet.has(row.subject_id)) continue;
    derivationCounts[row.derivation_type] = {
      ...derivationCounts[row.derivation_type],
      [row.state]: (derivationCounts[row.derivation_type]?.[row.state] ?? 0) + 1,
    };
    if (row.subject_kind !== "turn" && row.subject_kind !== "chunk") continue;
    derivationIndex.set(`${row.subject_id}/${row.derivation_type}`, {
      subjectKind: row.subject_kind,
      state: row.state as DerivationSnapshot["state"],
      contentNull: Number(row.content_null) === 1,
    });
  }

  const maxRow = counted(
    () =>
      db.prepare(`SELECT COALESCE(MAX(event_order), 0) AS m FROM event`).get() as {
        m: number | bigint;
      },
  );

  // ── on-demand reads ───────────────────────────────────────────

  const stopped = (): boolean => opts.signal?.aborted === true;

  const derivationSnapshots = new Map<string, DerivationSnapshot | undefined>();
  function derivation(subjectId: string, derivationType: string): DerivationSnapshot | undefined {
    const key = `${subjectId}/${derivationType}`;
    if (derivationSnapshots.has(key)) return derivationSnapshots.get(key);
    const entry = derivationIndex.get(key);
    let snapshot: DerivationSnapshot | undefined;
    if (entry !== undefined) {
      snapshot = { state: entry.state };
      // Content is read back only for the state the ladders can use. Every
      // rung that reads `content` first requires state === "ready"; a stored
      // body behind any other state is never rendered, so it is never loaded.
      if (entry.state === "ready" && !entry.contentNull) {
        const row = counted(
          () =>
            db
              .prepare(
                `SELECT content FROM derivation
             WHERE subject_kind = ? AND subject_id = ? AND derivation_type = ?`,
              )
              .get(entry.subjectKind, subjectId, derivationType) as { content: string | null } | undefined,
        );
        stats.derivationContentReads += 1;
        if (row?.content !== null && row?.content !== undefined) snapshot.content = row.content;
      }
    }
    derivationSnapshots.set(key, snapshot);
    return snapshot;
  }

  const excerpts = new Map<string, string | null>();
  function turnExcerpt(turnId: string): string | null {
    const cached = excerpts.get(turnId);
    if (cached !== undefined) return cached;
    const aggregate = turnAggregates.get(turnId);
    if (aggregate === undefined || aggregate.count === 0) {
      excerpts.set(turnId, null);
      return null;
    }
    // Bounded by the turn's own event-order span, so the read rides the
    // source_event_order index rather than scanning the message table.
    const messageRows = counted(
      () =>
        db
          .prepare(
            `SELECT m.message_id, m.kind
         ${PLACEABLE_MESSAGE_FROM}
           AND m.turn_id = ?
           AND m.source_event_order >= ?
           AND m.source_event_order <= ?
         ORDER BY m.source_event_order`,
          )
          .all(turnId, aggregate.minOrder, aggregate.maxOrder) as unknown as Array<{
          message_id: string;
          kind: string;
        }>,
    );
    // excerptLine reads the first block only, so only the first block loads.
    const firstBlock = db.prepare(
      `SELECT block_type, content FROM message_block WHERE message_id = ? ORDER BY block_index LIMIT 1`,
    );
    const lines = messageRows.map((row) => {
      stats.queries += 1;
      const block = firstBlock.get(row.message_id) as { block_type: string; content: string } | undefined;
      if (block === undefined) return excerptLine(row.kind, []);
      stats.messageBlockRowsRead += 1;
      return excerptLine(row.kind, [
        { blockType: block.block_type, content: JSON.parse(block.content) as Record<string, unknown> },
      ]);
    });
    stats.turnExcerptHydrations += 1;
    const excerpt = lines.join("\n");
    excerpts.set(turnId, excerpt);
    return excerpt;
  }

  const materials = new Map<string, CompactChunkMaterialSnapshot | undefined>();
  function chunkMaterial(chunkId: string, derivationType: ChunkSummaryType): CompactChunkMaterialSnapshot | undefined {
    if (!opts.includeChunkMaterials) return undefined;
    const key = `${chunkId}/${derivationType}`;
    if (materials.has(key)) return materials.get(key);
    if (stopped()) throw new CompactStoppedError("compact stopped during fallback assembly");
    const material = turnsDomain.getChunkText(transaction, chunkId, derivationType);
    stats.queries += 1;
    stats.chunkMaterialResolutions += 1;
    // Stored members that cannot be read are not a reason to stop: leaving
    // the material out drops the entry to the band ladder's gap, which the
    // receipt names. The eager plan omits blocked material the same way.
    const resolved = material.kind === "blocked" ? undefined : material;
    materials.set(key, resolved);
    return resolved;
  }

  const source: SelectionSource = {
    turns: shaped.turns,
    chunks,
    hasPlaceableMessages: () =>
      counted(() => db.prepare(`SELECT 1 AS present ${PLACEABLE_MESSAGE_FROM} LIMIT 1`).get()) !== undefined,
    crossingMessage(budget) {
      const page = db.prepare(
        `SELECT m.source_event_order AS o, m.turn_id AS turn_id, m.token_estimate AS tok
         ${PLACEABLE_MESSAGE_FROM}
           AND m.source_event_order < ?
         ORDER BY m.source_event_order DESC
         LIMIT ?`,
      );
      let cursor = Number.MAX_SAFE_INTEGER;
      let sum = 0;
      for (;;) {
        stats.queries += 1;
        const rows = page.all(cursor, COMPACT_POINT_PAGE_SIZE) as unknown as Array<{
          o: number | bigint;
          turn_id: string;
          tok: number | bigint;
        }>;
        for (const row of rows) {
          stats.compactPointRowsScanned += 1;
          sum += Number(row.tok);
          if (sum >= budget) return { order: Number(row.o), turnId: row.turn_id };
          cursor = Number(row.o);
        }
        if (rows.length < COMPACT_POINT_PAGE_SIZE) return null;
      }
    },
    turnMinMessageOrder: (turnId) => turnAggregates.get(turnId)?.minOrder,
    turnMessageTokens: (turnId) => turnAggregates.get(turnId)?.tokens ?? 0,
    messageTokensAfter: (order) => {
      const row = counted(
        () =>
          db
            .prepare(
              `SELECT COALESCE(SUM(m.token_estimate), 0) AS total
             ${PLACEABLE_MESSAGE_FROM}
               AND m.source_event_order > ?`,
            )
            .get(order) as { total: number | bigint },
      );
      return Number(row.total);
    },
    turnExcerpt,
    derivation,
    chunkMaterial,
  };

  return {
    source,
    sourceState: {
      emptyChunkIds,
      maxEventOrder: Number(maxRow.m),
      derivationCounts,
      skippedRecords,
    },
    stats,
  };
}
