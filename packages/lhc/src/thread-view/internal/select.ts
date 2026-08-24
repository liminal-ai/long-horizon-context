// Band selection: the record/derivation reads and the walk's eager execution
// plan. Three parts, deliberately split:
//
//   - readSelectionInputs: the eager reads — every live message with its
//     blocks, every derivation with its content — before any transaction
//     opens. A record the walk cannot place — a message or a chunk member
//     whose turn does not resolve to a live turn — is skipped and reported,
//     never refused. Its raw row is left exactly as it is.
//   - eagerSelectionSource: those inputs behind the walk's source contract.
//     Every answer is already in memory, so nothing the walk asks for costs a
//     read.
//   - selectArrangement: the walk over that source. Same inputs, same
//     arrangement: no DB handle, no clock, no inference.
//
// This is the algorithm the LHC_COMPACT_ALGORITHM escape hatch selects. The
// default plan reads metadata aggregates and hydrates only what the walk
// visits; see bounded-source.ts. Both run the same walk (walk.ts).
import type { DatabaseSync } from "node:sqlite";
import * as messagesDomain from "../../messages/index.js";
import type { Band, SettleConstruction, SkippedRecord } from "../../shared-tech/index.js";
import * as turnsDomain from "../../turns/index.js";
import type { CompactChunkMaterialSnapshot, DerivationSnapshot } from "./render.js";
import { excerptLine } from "./render.js";
import { orphanedMessageSkip, shapeChunks, shapeTurns } from "./selection-structure.js";
import { type SelectionSource, walkArrangement } from "./walk.js";

export interface SelectionMessage {
  messageId: string;
  order: number; // source_event_order
  kind: string;
  tokenEstimate: number;
  turnId: string;
  text: string; // excerpt/note line (render.excerptLine)
}

export interface SelectionTurn {
  turnId: string;
  turnOrder: number;
  status: "open" | "closed";
  openedAt: number;
  closedAt: number | null;
}

export interface SelectionChunk {
  chunkId: string;
  chunkOrder: number;
  status: "open" | "closed";
  memberTurnIds: string[]; // member order
}

/** The two chunk summary derivations the detailed and brief ladders resolve. */
export type ChunkSummaryType = "chunk_summary_detailed" | "chunk_summary_brief";

export interface SelectionInputs {
  messages: SelectionMessage[]; // live only, ascending order
  turns: SelectionTurn[]; // ascending turnOrder
  chunks: SelectionChunk[]; // ascending chunkOrder
  derivations: Map<string, DerivationSnapshot>; // `${subjectId}/${derivationType}` (turn/chunk subjects)
  compactChunkMaterials?: Map<string, CompactChunkMaterialSnapshot>;
  maxEventOrder: number;
  derivationCounts: Record<string, Record<string, number>>; // derivation type → state → count
  // Derived chunks whose stored members are all legitimate tombstoned turns.
  // Preview ignores them; compact removes them with the replacement view.
  emptyChunkIds?: string[];
  // Records the walk passed over because their turn does not resolve.
  skippedRecords: SkippedRecord[];
}

/**
 * What compact carries out of selection besides the arrangement itself: the
 * source-state provenance the receipt and the stored view record. Both
 * execution plans produce it.
 */
export interface ArrangementSourceState {
  emptyChunkIds?: readonly string[];
  maxEventOrder: number;
  derivationCounts: Record<string, Record<string, number>>;
  skippedRecords: SkippedRecord[];
}

export interface ArrangementEntry {
  band: Band;
  subjectKind: "turn" | "chunk";
  subjectId: string;
  derivationUsed: string;
  degraded: boolean;
  gap: boolean;
  reason?: string; // gap entries
  startOrder: number; // oldest event order the entry represents (notes included)
  text: string; // rendered entry text (the band stores this verbatim)
  tokens: number;
  // Turn parts: the step range this entry renders (part entries only).
  part?: { fromStep: number; toStep: number };
}

// A candidate the last band's walk passed over because it did not fit while
// older candidates still did: no band text, but a gap the receipt and
// gaps_json name — subject, band, and the size that did not fit.
export interface SkippedSubject {
  band: Band;
  subjectId: string;
  tokens: number;
  reason: string;
}

export interface SelectionResult {
  compactPoint: number;
  coveredFrom: number;
  // Gradient order (brief → detailed → smooth), oldest-first within band —
  // the order the bands render and the arrangement persists.
  entries: ArrangementEntry[];
  skipped: SkippedSubject[];
  // Turn parts (absent when no turn is split): what the receipt records.
  parts?: Array<{ turnId: string; fromStep: number; toStep: number }>;
  splitPoint?: { turnId: string; stepIndex: number };
  settled?: { turnId: string; construction: SettleConstruction };
  protectedTurn?: { turnId: string; representation: "full" | "whole_rendering" };
}

export interface SelectionConfig {
  lowerBound: number;
  percentages: { full: number; smooth: number; detailed: number; brief: number };
  /** Newest-closed-turn protection fraction (Flow 5); the profile default when absent. */
  newestClosedProtection?: number;
  /** Compact point must stay at or behind this event order (protected-pair tail). */
  compactPointUpperBound?: number;
}

// Message kinds that can anchor a host session rebuild past the compact point.
// Excludes runtime_note (and any future non-mappable kinds). Shared with the
// first-kept-message lookup in compact-compute so "empty tail" means the same
// thing in both places.
export const PI_MAPPABLE_MESSAGE_KINDS = [
  "user_prompt",
  "assistant_text",
  "assistant_thinking",
  "tool_call",
  "tool_result",
  "model_change",
  "thinking_level_change",
  "compact_continuation_marker",
] as const;

// ── reads (the eager plan) ───────────────────────────────────────

export function readSelectionInputs(db: DatabaseSync): SelectionInputs {
  // Message, turn, and chunk material comes from the owner domains, not direct
  // SQL against their tables (bad-code-log: domain-boundary leakage). The
  // owners return source-faithful structure — turns carry the deleted flag,
  // chunks carry raw membership — so thread-view decides for itself what the
  // walk can place. The derivation and event-aggregate reads stay here as
  // thread-view's own selection inputs.
  const structure = turnsDomain.readTurnChunkStructure(db);
  const shaped = shapeTurns(structure);
  const turns = shaped.turns;
  const skippedRecords: SkippedRecord[] = [];

  const messages: SelectionMessage[] = [];
  for (const record of messagesDomain.readLiveMessages(db)) {
    const turnId = record.turnId;
    if (!shaped.liveTurnIds.has(turnId)) {
      skippedRecords.push(orphanedMessageSkip(record.messageId, turnId));
      continue;
    }
    messages.push({
      messageId: record.messageId,
      order: record.sourceEventOrder,
      kind: record.kind,
      tokenEstimate: record.tokenEstimate,
      turnId,
      text: excerptLine(record.kind, record.blocks),
    });
  }

  const { chunks, emptyChunkIds } = shapeChunks(structure, shaped, skippedRecords);

  const derivationRows = db
    .prepare(`SELECT subject_kind, subject_id, derivation_type, state, content, reason, source_version FROM derivation`)
    .all() as unknown as Array<{
    subject_kind: string;
    subject_id: string;
    derivation_type: string;
    state: string;
    content: string | null;
    reason: string | null;
    source_version: number | bigint;
  }>;
  const derivations = new Map<string, DerivationSnapshot>();
  const emptyChunkSet = new Set(emptyChunkIds);
  const derivationCounts: Record<string, Record<string, number>> = {};
  for (const row of derivationRows) {
    if (row.subject_kind === "chunk" && emptyChunkSet.has(row.subject_id)) continue;
    derivationCounts[row.derivation_type] = {
      ...derivationCounts[row.derivation_type],
      [row.state]: (derivationCounts[row.derivation_type]?.[row.state] ?? 0) + 1,
    };
    if (row.subject_kind !== "turn" && row.subject_kind !== "chunk") continue;
    const snapshot: DerivationSnapshot = {
      state: row.state as DerivationSnapshot["state"],
      sourceVersion: Number(row.source_version),
    };
    if (row.content !== null) snapshot.content = row.content;
    if (row.reason !== null) snapshot.reason = row.reason;
    derivations.set(`${row.subject_id}/${row.derivation_type}`, snapshot);
  }

  const maxRow = db.prepare(`SELECT COALESCE(MAX(event_order), 0) AS m FROM event`).get() as {
    m: number | bigint;
  };

  return {
    messages,
    turns,
    chunks,
    derivations,
    maxEventOrder: Number(maxRow.m),
    derivationCounts,
    emptyChunkIds,
    skippedRecords,
  };
}

// ── the eager source ─────────────────────────────────────────────

/** The read inputs behind the walk's source contract: every answer already in memory. */
export function eagerSelectionSource(inputs: SelectionInputs): SelectionSource {
  const { messages } = inputs;
  const messagesByTurn = new Map<string, SelectionMessage[]>();
  for (const message of messages) {
    const list = messagesByTurn.get(message.turnId) ?? [];
    list.push(message);
    messagesByTurn.set(message.turnId, list);
  }
  const turnMessages = (turnId: string): SelectionMessage[] => messagesByTurn.get(turnId) ?? [];

  return {
    turns: inputs.turns,
    chunks: inputs.chunks,
    hasPlaceableMessages: () => messages.length > 0,
    crossingMessage(budget) {
      let sum = 0;
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i] as SelectionMessage;
        sum += message.tokenEstimate;
        if (sum >= budget) return { order: message.order, turnId: message.turnId };
      }
      return null;
    },
    turnMinMessageOrder(turnId) {
      const orders = turnMessages(turnId).map((message) => message.order);
      return orders.length === 0 ? undefined : Math.min(...orders);
    },
    turnMessageTokens: (turnId) => turnMessages(turnId).reduce((total, message) => total + message.tokenEstimate, 0),
    messageTokensAfter: (order) =>
      messages.filter((message) => message.order > order).reduce((total, message) => total + message.tokenEstimate, 0),
    turnExcerpt(turnId) {
      const list = turnMessages(turnId);
      return list.length === 0 ? null : list.map((message) => message.text).join("\n");
    },
    derivation: (subjectId, derivationType) => inputs.derivations.get(`${subjectId}/${derivationType}`),
    chunkMaterial: (chunkId, derivationType) => inputs.compactChunkMaterials?.get(`${chunkId}/${derivationType}`),
  };
}

/** The eager plan's entry point: pure over its inputs, same inputs same arrangement. */
export function selectArrangement(inputs: SelectionInputs, config: SelectionConfig): SelectionResult {
  return walkArrangement(eagerSelectionSource(inputs), config);
}
