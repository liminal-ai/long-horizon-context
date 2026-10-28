import type { DatabaseSync } from "node:sqlite";
import { hasForcedBoundaryHistory } from "../../compact-continuation/internal/store.js";
import type { DbReadTransaction, SkippedRecord } from "../../shared-tech/index.js";
import type { TokenEstimator } from "../../shared-tech/token-counting/index.js";
import * as turnsDomain from "../../turns/index.js";
import type { CompactChunkMaterialSnapshot, DerivationSnapshot } from "./render.js";
import { excerptLine } from "./render.js";
import type { ArrangementSourceState, ChunkSummaryType } from "./select.js";
import { orphanedMessageSkip, shapeChunks, shapeTurns } from "./selection-structure.js";
import { readInstalledTransition } from "./snapshot.js";
import type { PartsSource, SelectionSource } from "./walk.js";

export class CompactStoppedError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = "CompactStoppedError";
  }
}

export interface BoundedSelectionStats {
  queries: number;
  compactPointRowsScanned: number;
  turnExcerptHydrations: number;
  messageBlockRowsRead: number;
  chunkMaterialResolutions: number;
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
  sourceVersion: number;
}

const COMPACT_POINT_PAGE_SIZE = 512;

const PLACEABLE_MESSAGE_FROM = `FROM message m
       JOIN event e ON e.event_order = m.source_event_order
       JOIN turns t ON t.turn_id = m.turn_id AND t.deleted_at IS NULL
       WHERE m.deleted_at IS NULL`;

export function createBoundedSelection(
  db: DatabaseSync,
  transaction: DbReadTransaction,
  opts: {
    includeChunkMaterials: boolean;
    signal?: { aborted: boolean } | undefined;
    tokenEstimator: TokenEstimator;
  },
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
  const estimator = opts.tokenEstimator;

  const structure = counted(() => turnsDomain.readTurnChunkStructure(db));
  const shaped = shapeTurns(structure);
  const skippedRecords: SkippedRecord[] = [];

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

  const derivationRows = counted(
    () =>
      db
        .prepare(
          `SELECT subject_kind, subject_id, derivation_type, state, (content IS NULL) AS content_null,
              source_version
       FROM derivation`,
        )
        .all() as unknown as Array<{
        subject_kind: string;
        subject_id: string;
        derivation_type: string;
        state: string;
        content_null: number | bigint;
        source_version: number | bigint;
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
      sourceVersion: Number(row.source_version),
    });
  }

  const maxRow = counted(
    () =>
      db.prepare(`SELECT COALESCE(MAX(event_order), 0) AS m FROM event`).get() as {
        m: number | bigint;
      },
  );

  const stopped = (): boolean => opts.signal?.aborted === true;

  const derivationSnapshots = new Map<string, DerivationSnapshot | undefined>();
  function derivation(subjectId: string, derivationType: string): DerivationSnapshot | undefined {
    const key = `${subjectId}/${derivationType}`;
    if (derivationSnapshots.has(key)) return derivationSnapshots.get(key);
    const entry = derivationIndex.get(key);
    let snapshot: DerivationSnapshot | undefined;
    if (entry !== undefined) {
      snapshot = { state: entry.state, sourceVersion: entry.sourceVersion };
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
    const resolved = material.kind === "blocked" ? undefined : material;
    materials.set(key, resolved);
    return resolved;
  }

  const installed = counted(() => readInstalledTransition(db));
  const forcedBoundaryThread = counted(() => hasForcedBoundaryHistory(db));
  const stepsByTurn = new Map<string, ReturnType<typeof turnsDomain.readTurnSteps>>();
  const wholeTexts = new Map<string, turnsDomain.WholeTurnComposition | null>();
  const parts: PartsSource | undefined = forcedBoundaryThread
    ? undefined
    : {
        installed,
        turnSteps(turnId) {
          const cached = stepsByTurn.get(turnId);
          if (cached !== undefined) return cached;
          const edges = counted(() => turnsDomain.readTurnSteps(db, turnId));
          stepsByTurn.set(turnId, edges);
          return edges;
        },
        partText: (turnId, range, trailer) =>
          counted(() => turnsDomain.composeTurnPartText(db, turnId, range, trailer, estimator)),
        wholeTurnText(turnId) {
          const cached = wholeTexts.get(turnId);
          if (cached !== undefined) return cached;
          const composed = counted(() => turnsDomain.composeWholeTurnText(db, turnId, estimator));
          wholeTexts.set(turnId, composed);
          return composed;
        },
      };

  const source: SelectionSource = {
    turns: shaped.turns,
    chunks,
    ...(parts !== undefined ? { parts } : {}),
    hasPlaceableMessages: () =>
      counted(() => db.prepare(`SELECT 1 AS present ${PLACEABLE_MESSAGE_FROM} LIMIT 1`).get()) !== undefined,
    crossingMessage(budget) {
      const page = db.prepare(
        `SELECT m.source_event_order AS o, m.turn_id AS turn_id, m.token_estimate AS tok,
                CASE WHEN m.kind = 'assistant_thinking' THEN (
                  SELECT json_extract(mb.content, '$.signature') FROM message_block mb
                  WHERE mb.message_id = m.message_id AND mb.block_index = 0
                ) ELSE NULL END AS sig
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
          sig: string | null;
        }>;
        for (const row of rows) {
          stats.compactPointRowsScanned += 1;
          const signatureBilled =
            typeof row.sig === "string" && row.sig.length > 0 ? estimator.estimateSignature(row.sig) : 0;
          sum += estimator.weighStored(Number(row.tok), signatureBilled);
          if (sum >= budget) return { order: Number(row.o), turnId: row.turn_id };
          cursor = Number(row.o);
        }
        if (rows.length < COMPACT_POINT_PAGE_SIZE) return null;
      }
    },
    turnMinMessageOrder: (turnId) => turnAggregates.get(turnId)?.minOrder,
    turnMessageTokens: (turnId) => estimator.weigh(turnAggregates.get(turnId)?.tokens ?? 0),
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
      return estimator.weigh(Number(row.total));
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
