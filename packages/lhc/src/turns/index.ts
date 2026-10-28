import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { EventRecord, TurnEndPayload, UserPromptPayload } from "../intake-stream/index.js";
import type { Derivation, DerivationReportEntry, ResolvedSdkConfig } from "../shared-tech/index.js";
import {
  createDbReadTransaction,
  createDbWriteTransaction,
  type DbReadTransaction,
  type DbWriteTransaction,
  type ErrorResult,
  type OpResult,
  resolveInstanceConfig,
  resolveInstanceTokenEstimator,
  storageFailure,
} from "../shared-tech/index.js";
import type { TokenEstimator } from "../shared-tech/token-counting/index.js";
import { enqueue, type WorkItemRecord } from "../shared-tech/work-queue/index.js";
import { openThreadDatabase, resolveThreadRef, type ThreadRef } from "../threads/index.js";
import { type CompactChunkMaterial, compactChunkMaterialFromStoredMembers } from "./internal/chunk-recovery.js";
import { type ChunkStructureRow, dropEmptyReadableChunks, readChunkStructure } from "./internal/chunks.js";
import { composeRenderingInput, composeStructuredTurnText } from "./internal/compose.js";

import {
  readChunkRows,
  readMemberMessages,
  readMessageDerivationRows,
  readOwnedDerivations,
  reportTurnDerivations,
} from "./internal/derivations.js";
import { deriveTurnOwnedInOpenDb } from "./internal/derive.js";
import { backfillRenderingLabelsInOpenDb, type RenderingLabelBackfillReceipt } from "./internal/label-backfill.js";
import { readStepMembers, type StepEdges, stepEdges } from "./internal/steps.js";
import {
  closeTurn,
  countTurnMembers,
  insertOpenTurn,
  nextTurnOrder,
  readTurnStructure,
  readTurns,
  selectOpenTurnIds,
  type TurnCloseHostFacts,
  type TurnStructureRow,
} from "./internal/store.js";

export interface TurnRecord {
  turnId: string;
  turnOrder: number;
  status: "open" | "closed";
  memberMessageIds: string[];
  openedAtEventOrder: number;
  closedAtEventOrder?: number;
  outcome?: "completed" | "aborted";
  outcomeReason?: string;
  startedAt?: string;
  endedAt?: string;
  chunkId?: string;
  memberIdx?: number;
  derivations?: Derivation[];
}

export interface ChunkRecord {
  chunkId: string;
  chunkOrder: number;
  status: "open" | "closed";
  accumulatedProjectedTokens: number;
  memberTurnIds: string[];
  derivations?: Derivation[];
}

export interface TurnTransitionOutcome {
  transitions: Array<{ action: "opened" | "closed"; turnId: string }>;
  turnId: string;
  queuedWork: WorkItemRecord[];
}

export class TurnStateCorruptionError extends Error {
  readonly errorClass = "state_corruption" as const;
  readonly code = "turn_state_corrupt" as const;
}

function currentOpenTurnId(transaction: DbWriteTransaction): string {
  const openTurnIds = selectOpenTurnIds(transaction.db);
  if (openTurnIds.length !== 1) {
    throw new TurnStateCorruptionError(
      `thread has ${openTurnIds.length} open turns (${openTurnIds.join(", ")}); the invariant is exactly one`,
    );
  }
  return openTurnIds[0]!;
}

function closeTurnAndQueueWork(
  transaction: DbWriteTransaction,
  turnId: string,
  eventOrder: number,
  hostFacts: TurnCloseHostFacts = {},
): WorkItemRecord {
  closeTurn(transaction.db, turnId, eventOrder, hostFacts);
  return enqueue(transaction, {
    owner: "turns",
    kind: "turn_derivation",
    sourceRef: { turnId },
    derivations: [
      { subjectKind: "turn", subjectId: turnId, derivationType: "turn_rendering" },
      { subjectKind: "turn", subjectId: turnId, derivationType: "pre_detailed_assembly" },
    ],
  });
}

export type RecordedTurnEvent = Pick<EventRecord, "eventKind" | "eventOrder" | "payload">;

export function create(transaction: DbWriteTransaction, recordedEvent: RecordedTurnEvent): TurnTransitionOutcome {
  const openTurnId = currentOpenTurnId(transaction);
  const hasMembers = countTurnMembers(transaction.db, openTurnId) > 0;
  if (recordedEvent.eventKind === "turn_end") {
    if (!hasMembers) return { transitions: [], turnId: openTurnId, queuedWork: [] };
    const payload = recordedEvent.payload as TurnEndPayload;
    const item = closeTurnAndQueueWork(transaction, openTurnId, recordedEvent.eventOrder, payload);
    const turnId = insertOpenTurn(transaction.db, nextTurnOrder(transaction.db), recordedEvent.eventOrder);
    return {
      transitions: [
        { action: "closed", turnId: openTurnId },
        { action: "opened", turnId },
      ],
      turnId,
      queuedWork: [item],
    };
  }
  const steer =
    recordedEvent.eventKind === "user_prompt" && (recordedEvent.payload as UserPromptPayload).steer === true;
  if (recordedEvent.eventKind === "user_prompt" && hasMembers && !steer) {
    const item = closeTurnAndQueueWork(transaction, openTurnId, recordedEvent.eventOrder);
    const turnId = insertOpenTurn(transaction.db, nextTurnOrder(transaction.db), recordedEvent.eventOrder);
    return {
      transitions: [
        { action: "closed", turnId: openTurnId },
        { action: "opened", turnId },
      ],
      turnId,
      queuedWork: [item],
    };
  }
  return { transitions: [], turnId: openTurnId, queuedWork: [] };
}

function threadNotFound(filePath: string): { ok: false; error: ErrorResult } {
  return {
    ok: false,
    error: {
      errorClass: "caller_error",
      code: "thread_not_found",
      reason: `no thread file exists at ${filePath}`,
    },
  };
}

export async function listTurns(threadRef: ThreadRef): Promise<OpResult<TurnRecord[]>> {
  try {
    return await createDbReadTransaction(threadRef, (transaction) => {
      const derivationsByTurn = readOwnedDerivations(transaction.db, "turn");
      return readTurns(transaction.db).map((record) => {
        const derivations = derivationsByTurn.get(record.turnId);
        return derivations === undefined ? record : { ...record, derivations };
      });
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return storageFailure(`turn read-back failed: ${reason}`);
  }
}

export async function listChunks(threadRef: ThreadRef): Promise<OpResult<ChunkRecord[]>> {
  try {
    return await createDbReadTransaction(threadRef, (transaction) => {
      const derivationsByChunk = readOwnedDerivations(transaction.db, "chunk");
      return readChunkRows(transaction.db).map((row) => {
        const derivations = derivationsByChunk.get(row.chunkId);
        return derivations === undefined ? row : { ...row, derivations };
      });
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return storageFailure(`chunk read-back failed: ${reason}`);
  }
}

export function getChunkText(
  transaction: DbReadTransaction,
  chunkId: string,
  derivationType: "chunk_summary_detailed" | "chunk_summary_brief" = "chunk_summary_detailed",
): CompactChunkMaterial {
  return compactChunkMaterialFromStoredMembers(transaction.db, chunkId, derivationType);
}

/** Step edges of one turn from its host-supplied step indices (any status). */
export function readTurnSteps(db: DatabaseSync, turnId: string): StepEdges {
  return stepEdges(readStepMembers(db, turnId));
}

export function composeTurnPartText(
  db: DatabaseSync,
  turnId: string,
  range: { fromOrder: number; toOrder: number },
  trailer: string,
  estimator: TokenEstimator,
): string {
  const messages = readMemberMessages(db, turnId, range);
  const { parts } = composeRenderingInput(messages, new Map(), {
    capForServing: true,
    rawByDesign: true,
    tokenEstimator: estimator,
  });
  return composeStructuredTurnText(parts, turnId, trailer);
}

export interface WholeTurnComposition {
  text: string;
  capped: boolean;
}

export function composeWholeTurnText(
  db: DatabaseSync,
  turnId: string,
  estimator: TokenEstimator,
): WholeTurnComposition | null {
  const messages = readMemberMessages(db, turnId);
  if (messages.length === 0) return null;
  const derivations = readMessageDerivationRows(
    db,
    messages.map((message) => message.messageId),
  );
  const { parts, capped } = composeRenderingInput(messages, derivations, {
    capForServing: true,
    tokenEstimator: estimator,
  });
  return { text: composeStructuredTurnText(parts, turnId), capped };
}

export interface ActiveTurnSteps {
  turnId: string;
  estimatedTokens: number;
  edges: StepEdges;
}

export function readActiveTurnSteps(db: DatabaseSync): ActiveTurnSteps | null {
  const turnId = selectOpenTurnIds(db)[0];
  if (turnId === undefined) return null;
  const tokens = db
    .prepare(`SELECT COALESCE(SUM(token_estimate), 0) AS total FROM message WHERE turn_id = ? AND deleted_at IS NULL`)
    .get(turnId) as { total: number | bigint };
  return {
    turnId,
    estimatedTokens: resolveInstanceTokenEstimator("turns.readActiveTurnSteps").weigh(Number(tokens.total)),
    edges: stepEdges(readStepMembers(db, turnId)),
  };
}

export interface TurnChunkStructure {
  turns: TurnStructureRow[];
  chunks: ChunkStructureRow[];
}

export function readTurnChunkStructure(db: DatabaseSync): TurnChunkStructure {
  return { turns: readTurnStructure(db), chunks: readChunkStructure(db) };
}

export function dropUnreadableChunks(db: DatabaseSync, chunkIds: readonly string[]): string[] {
  return dropEmptyReadableChunks(db, chunkIds);
}

export async function report(
  threadRef: ThreadRef,
  opts?: { notReady?: boolean; turnId?: string; chunkId?: string },
): Promise<OpResult<DerivationReportEntry[]>> {
  try {
    return await createDbReadTransaction(threadRef, (transaction) => reportTurnDerivations(transaction.db, opts ?? {}));
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return storageFailure(`report read failed: ${reason}`);
  }
}

export type TurnDeriveResult =
  | { turnId: string; outcome: "derived"; sourceVersion: number }
  | { turnId: string; outcome: "failed"; error: ErrorResult };

export type ChunkDeriveResult =
  | {
      chunkId: string;
      outcome: "derived";
      derivationType: "chunk_summary_detailed" | "chunk_summary_brief";
      sourceVersion: number;
    }
  | { chunkId: string; outcome: "failed"; error: ErrorResult };

function configRequired(operation: string): ResolvedSdkConfig | { error: ErrorResult } {
  const config = resolveInstanceConfig();
  if (config !== undefined) return config;
  return {
    error: {
      errorClass: "caller_error",
      code: "inference_unavailable",
      reason: `${operation} requires an initialized LHC SDK inference configuration`,
    },
  };
}

export type { RenderingLabelBackfillReceipt };

/**
 * Explicit selected-thread label backfill: rewrite stored `turn_rendering`
 * content that predates stable labels, via the same pure composition the
 * retrieval fallback uses. No inference, no queued work, no canonical-record
 * change; not a repair path — missing/failed renderings are reported, not
 * created.
 */
export async function backfillRenderingLabels(
  threadRef: ThreadRef,
  opts?: { dryRun?: boolean },
): Promise<OpResult<RenderingLabelBackfillReceipt>> {
  try {
    return await createDbWriteTransaction(threadRef, (transaction) =>
      backfillRenderingLabelsInOpenDb(transaction.db, transaction.clock, opts?.dryRun === true),
    );
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return storageFailure(`label backfill failed: ${reason}`);
  }
}

export async function deriveTurn(threadRef: ThreadRef, turnId: string): Promise<OpResult<TurnDeriveResult>> {
  const config = configRequired("turns.deriveTurn");
  if ("error" in config) return { ok: false, error: config.error };
  const resolved = await resolveThreadRef(threadRef);
  if (!resolved.ok) return resolved;
  const { filePath } = resolved.value;
  if (!existsSync(filePath)) return threadNotFound(filePath);

  const opened = openThreadDatabase(filePath);
  if (!opened.ok) return opened;
  const db = opened.value;
  try {
    const assemblyResult = await deriveTurnOwnedInOpenDb(db, config, "turn_derivation", { turnId }, [
      { subjectKind: "turn", subjectId: turnId, derivationType: "turn_rendering" },
      { subjectKind: "turn", subjectId: turnId, derivationType: "pre_detailed_assembly" },
    ]);
    if (assemblyResult.outcome === "failed") {
      return { ok: true, value: { turnId, ...assemblyResult } };
    }
    const result = await deriveTurnOwnedInOpenDb(db, config, "detailed_turn_compression", { turnId }, [
      { subjectKind: "turn", subjectId: turnId, derivationType: "detailed_turn_compression" },
    ]);
    return { ok: true, value: { turnId, ...result } };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return storageFailure(`derive failed: ${reason}`);
  } finally {
    db.close();
  }
}

async function deriveChunk(
  threadRef: ThreadRef,
  chunkId: string,
  derivationType: "chunk_summary_detailed" | "chunk_summary_brief",
): Promise<OpResult<ChunkDeriveResult>> {
  const config = configRequired(
    `turns.${derivationType === "chunk_summary_detailed" ? "deriveDetailedChunk" : "deriveBriefChunk"}`,
  );
  if ("error" in config) return { ok: false, error: config.error };
  const resolved = await resolveThreadRef(threadRef);
  if (!resolved.ok) return resolved;
  const { filePath } = resolved.value;
  if (!existsSync(filePath)) return threadNotFound(filePath);
  const opened = openThreadDatabase(filePath);
  if (!opened.ok) return opened;
  const db = opened.value;
  try {
    const result = await deriveTurnOwnedInOpenDb(db, config, derivationType, { chunkId }, [
      { subjectKind: "chunk", subjectId: chunkId, derivationType },
    ]);
    if (result.outcome === "failed") return { ok: true, value: { chunkId, ...result } };
    return { ok: true, value: { chunkId, derivationType, ...result } };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return storageFailure(`derive failed: ${reason}`);
  } finally {
    db.close();
  }
}

export function deriveDetailedChunk(threadRef: ThreadRef, chunkId: string): Promise<OpResult<ChunkDeriveResult>> {
  return deriveChunk(threadRef, chunkId, "chunk_summary_detailed");
}

export function deriveBriefChunk(threadRef: ThreadRef, chunkId: string): Promise<OpResult<ChunkDeriveResult>> {
  return deriveChunk(threadRef, chunkId, "chunk_summary_brief");
}
