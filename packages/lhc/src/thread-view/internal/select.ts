import type { DatabaseSync } from "node:sqlite";
import * as messagesDomain from "../../messages/index.js";
import type { Band, SettleConstruction, SkippedRecord } from "../../shared-tech/index.js";
import { billedSignatureTokens, type TokenEstimator } from "../../shared-tech/token-counting/index.js";
import * as turnsDomain from "../../turns/index.js";
import type { CompactChunkMaterialSnapshot, DerivationSnapshot } from "./render.js";
import { excerptLine } from "./render.js";
import { orphanedMessageSkip, shapeChunks, shapeTurns } from "./selection-structure.js";
import { type SelectionSource, walkArrangement } from "./walk.js";

export interface SelectionMessage {
  messageId: string;
  order: number;
  kind: string;
  tokenEstimate: number;
  turnId: string;
  text: string;
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
  memberTurnIds: string[];
}

export type ChunkSummaryType = "chunk_summary_detailed" | "chunk_summary_brief";

export interface SelectionInputs {
  messages: SelectionMessage[];
  turns: SelectionTurn[];
  chunks: SelectionChunk[];
  derivations: Map<string, DerivationSnapshot>;
  compactChunkMaterials?: Map<string, CompactChunkMaterialSnapshot>;
  maxEventOrder: number;
  derivationCounts: Record<string, Record<string, number>>;
  emptyChunkIds?: string[];
  skippedRecords: SkippedRecord[];
}

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
  reason?: string;
  startOrder: number;
  text: string;
  tokens: number;
  part?: { fromStep: number; toStep: number };
}

export interface SkippedSubject {
  band: Band;
  subjectId: string;
  tokens: number;
  reason: string;
}

export interface SelectionResult {
  compactPoint: number;
  coveredFrom: number;
  entries: ArrangementEntry[];
  skipped: SkippedSubject[];
  parts?: Array<{ turnId: string; fromStep: number; toStep: number }>;
  splitPoint?: { turnId: string; stepIndex: number };
  settled?: { turnId: string; construction: SettleConstruction };
  protectedTurn?: { turnId: string; representation: "full" | "whole_rendering" };
}

export interface SelectionConfig {
  lowerBound: number;
  percentages: { full: number; smooth: number; detailed: number; brief: number };
  newestClosedProtection?: number;
  compactPointUpperBound?: number;
  tokenEstimator: TokenEstimator;
}

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

export function readSelectionInputs(db: DatabaseSync, estimator: TokenEstimator): SelectionInputs {
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
      tokenEstimate: estimator.weighStored(record.tokenEstimate, billedSignatureTokens(estimator, record.blocks)),
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

export function selectArrangement(inputs: SelectionInputs, config: SelectionConfig): SelectionResult {
  return walkArrangement(eagerSelectionSource(inputs), config);
}
