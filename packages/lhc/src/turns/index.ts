import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { EventRecord } from "../intake-stream/index.js";
import type { Derivation, DerivationReportEntry, ResolvedSdkConfig } from "../shared-tech/index.js";
import {
  createDbReadTransaction,
  createDbWriteTransaction,
  type DbReadTransaction,
  type DbWriteTransaction,
  type ErrorResult,
  type OpResult,
  resolveInstanceConfig,
  storageFailure,
} from "../shared-tech/index.js";
import {
  type EnqueueDerivationTarget,
  enqueue,
  hasLiveItem,
  type WorkItemRecord,
  type WorkKind,
  type WorkSourceRef,
} from "../shared-tech/work-queue/index.js";
import { openThreadDatabase, resolveThreadRef, type ThreadRef } from "../threads/index.js";
import { type CompactChunkMaterial, compactChunkMaterialFromStoredMembers } from "./internal/chunk-recovery.js";
import { type ChunkStructureRow, readChunkStructure } from "./internal/chunks.js";
import {
  chunkExists,
  readChunkRows,
  readOwnedDerivations,
  readTurnDerivationRow,
  readTurnSource,
  reportTurnDerivations,
} from "./internal/derivations.js";
import { deriveTurnOwnedInOpenDb } from "./internal/derive.js";
import {
  closeTurn,
  countTurnMembers,
  insertOpenTurn,
  nextTurnOrder,
  readTurnStructure,
  readTurns,
  selectOpenTurnIds,
  type TurnStructureRow,
} from "./internal/store.js";

export interface TurnRecord {
  turnId: string;
  turnOrder: number;
  status: "open" | "closed";
  memberMessageIds: string[];
  openedAtEventOrder: number;
  closedAtEventOrder?: number;
  // Present once the turn's derivation placed it in a chunk. Stored values
  // read back; reads never recompute placement.
  chunkId?: string;
  memberIdx?: number;
  // Stored turn-owned derivations, attached only when rows exist. Reads
  // return stored state verbatim and never block on derivation readiness.
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
  // Transitions in occurrence order: a close_then_open reports the close
  // first, then the open, exactly as the batch result surfaces them.
  transitions: Array<{ action: "opened" | "closed"; turnId: string }>;
  // The open turn after the transition; this is the membership stamp for
  // message-producing events.
  turnId: string;
  // Work queued by this transition: one turn_derivation item per closed
  // turn. Empty when nothing closed.
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

// Closing a turn durably queues that turn's derivation work in the same
// transaction: the close update and the work item commit or roll back together.
function closeTurnAndQueueWork(transaction: DbWriteTransaction, turnId: string, eventOrder: number): WorkItemRecord {
  closeTurn(transaction.db, turnId, eventOrder);
  // One work item backs two independent turn-owned derivation rows.
  return enqueue(transaction, {
    owner: "turns",
    kind: "turn_derivation",
    sourceRef: { turnId },
    derivations: [
      { subjectKind: "turn", subjectId: turnId, derivationType: "turn_rendering" },
      { subjectKind: "turn", subjectId: turnId, derivationType: "smooth_turn_compression" },
    ],
  });
}

// Cross-domain surface, called by intake-stream inside the batch transaction
// for every recorded event. Synchronous and throwing by design, like
// messages.create: a turn-storage failure rejects the whole batch.
export type RecordedTurnEvent = Pick<EventRecord, "eventKind" | "eventOrder">;

export function create(transaction: DbWriteTransaction, recordedEvent: RecordedTurnEvent): TurnTransitionOutcome {
  const openTurnId = currentOpenTurnId(transaction);
  const hasMembers = countTurnMembers(transaction.db, openTurnId) > 0;
  if (recordedEvent.eventKind === "turn_end") {
    if (!hasMembers) return { transitions: [], turnId: openTurnId, queuedWork: [] };
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
  if (recordedEvent.eventKind === "user_prompt" && hasMembers) {
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

export async function listTurns(thread: ThreadRef): Promise<OpResult<TurnRecord[]>> {
  try {
    return await createDbReadTransaction(thread, (transaction) => {
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

// Returns stored chunk records whatever their derivation states. Derivations
// attach only where rows exist; freshly opened chunks have none.
export async function listChunks(thread: ThreadRef): Promise<OpResult<ChunkRecord[]>> {
  try {
    return await createDbReadTransaction(thread, (transaction) => {
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

// In-transaction read for coordinators that already hold an open thread
// handle (thread-view's compact selection): the turn and chunk structure on
// the caller's handle, so thread-view asks the turns owner for turn ordering,
// boundaries, and chunk membership instead of reading the turn/chunk tables
// itself. Turns carry the deleted flag and chunks carry raw (unvalidated)
// membership so the consumer keeps ownership of the source-state corruption
// policy; it never sees the live-only shapes listTurns/listChunks return.
export interface TurnChunkStructure {
  turns: TurnStructureRow[];
  chunks: ChunkStructureRow[];
}

export function readTurnChunkStructure(db: DatabaseSync): TurnChunkStructure {
  return { turns: readTurnStructure(db), chunks: readChunkStructure(db) };
}

// ── report and repair ─────────────────────────────────────────────

// This owner's repair report: every turn- and chunk-owned derivation's durable
// state joined with live queue detail in one query. Needs no inference;
// reads degrade, never block.
export async function report(
  thread: ThreadRef,
  opts?: { notReady?: boolean; turnId?: string; chunkId?: string },
): Promise<OpResult<DerivationReportEntry[]>> {
  try {
    return await createDbReadTransaction(thread, (transaction) => reportTurnDerivations(transaction.db, opts ?? {}));
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

export async function deriveTurn(thread: ThreadRef, turnId: string): Promise<OpResult<TurnDeriveResult>> {
  const config = configRequired("turns.deriveTurn");
  if ("error" in config) return { ok: false, error: config.error };
  const resolved = await resolveThreadRef(thread);
  if (!resolved.ok) return resolved;
  const { filePath } = resolved.value;
  if (!existsSync(filePath)) return threadNotFound(filePath);

  const opened = openThreadDatabase(filePath);
  if (!opened.ok) return opened;
  const db = opened.value;
  try {
    const result = await deriveTurnOwnedInOpenDb(db, config, "turn_derivation", { turnId }, [
      { subjectKind: "turn", subjectId: turnId, derivationType: "turn_rendering" },
      { subjectKind: "turn", subjectId: turnId, derivationType: "smooth_turn_compression" },
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
  thread: ThreadRef,
  chunkId: string,
  derivationType: "chunk_summary_detailed" | "chunk_summary_brief",
): Promise<OpResult<ChunkDeriveResult>> {
  const config = configRequired(
    `turns.${derivationType === "chunk_summary_detailed" ? "deriveDetailedChunk" : "deriveBriefChunk"}`,
  );
  if ("error" in config) return { ok: false, error: config.error };
  const resolved = await resolveThreadRef(thread);
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

export function deriveDetailedChunk(thread: ThreadRef, chunkId: string): Promise<OpResult<ChunkDeriveResult>> {
  return deriveChunk(thread, chunkId, "chunk_summary_detailed");
}

export function deriveBriefChunk(thread: ThreadRef, chunkId: string): Promise<OpResult<ChunkDeriveResult>> {
  return deriveChunk(thread, chunkId, "chunk_summary_brief");
}

export type TurnDerivationRepairScheduleResult =
  | { subjectId: string; outcome: "scheduled"; sourceVersion: number }
  | { subjectId: string; outcome: "in_flight"; sourceVersion: number }
  | { subjectId: string; outcome: "failed"; error: ErrorResult };

function failedScheduleRepair(subjectId: string, error: ErrorResult): TurnDerivationRepairScheduleResult {
  return { subjectId, outcome: "failed", error };
}

function nextSourceVersion(rows: readonly { state: string; sourceVersion: number }[]): number {
  const versions = rows.map((row) => row.sourceVersion);
  const max = Math.max(...versions);
  return rows.some((row) => row.state === "pending") ? max : max + 1;
}

function sourceRefId(sourceRef: WorkSourceRef): string {
  if ("turnId" in sourceRef) return sourceRef.turnId;
  if ("chunkId" in sourceRef) return sourceRef.chunkId;
  return sourceRef.messageId;
}

function scheduleTurnOwned(
  transaction: DbWriteTransaction,
  kind: WorkKind,
  sourceRef: WorkSourceRef,
  derivations: readonly EnqueueDerivationTarget[],
): TurnDerivationRepairScheduleResult {
  const subjectId = sourceRefId(sourceRef);
  const rows = derivations.map((target) =>
    readTurnDerivationRow(
      transaction.db,
      target.subjectKind as "turn" | "chunk",
      target.subjectId,
      target.derivationType,
    ),
  );
  if (rows.some((row) => row === undefined)) {
    const target = derivations.find((_entry, index) => rows[index] === undefined)!;
    return failedScheduleRepair(subjectId, {
      errorClass: "caller_error",
      code: "turn_not_found",
      reason: `no derived derivation ${target.derivationType} exists for ${target.subjectKind} ${target.subjectId}`,
    });
  }
  const blocked = rows.find((row) => row?.state === "blocked");
  if (blocked !== undefined) {
    return failedScheduleRepair(subjectId, {
      errorClass: "state_corruption",
      code: "source_damaged",
      reason: blocked.reason ?? "turn-owned derivation is blocked",
    });
  }
  const sourceVersion = nextSourceVersion(rows as Array<{ state: string; sourceVersion: number }>);
  if (hasLiveItem(transaction.db, kind, sourceRef, sourceVersion)) {
    return { subjectId, outcome: "in_flight", sourceVersion };
  }
  enqueue(transaction, {
    owner: "turns",
    kind,
    sourceRef,
    sourceVersion,
    derivations,
  });
  return { subjectId, outcome: "scheduled", sourceVersion };
}

// Owner repair scheduling for callers that must not run inference. The
// existing turn-owned derivation rows are reset to pending and the durable
// work item is enqueued in one write transaction.
export async function scheduleTurnDerivationRepair(
  threadRef: ThreadRef,
  turnId: string,
): Promise<OpResult<TurnDerivationRepairScheduleResult>> {
  try {
    return await createDbWriteTransaction(threadRef, (transaction) => {
      const source = readTurnSource(transaction.db, turnId);
      if (source === undefined || source.deleted) {
        return failedScheduleRepair(turnId, {
          errorClass: "caller_error",
          code: "turn_not_found",
          reason: `no turn ${turnId} exists in this thread`,
        });
      }
      if (source.status !== "closed") {
        return failedScheduleRepair(turnId, {
          errorClass: "caller_error",
          code: "turn_open",
          reason: `turn ${turnId} is open; only closed turns can be scheduled for derivation`,
        });
      }
      return scheduleTurnOwned(transaction, "turn_derivation", { turnId }, [
        { subjectKind: "turn", subjectId: turnId, derivationType: "turn_rendering" },
        { subjectKind: "turn", subjectId: turnId, derivationType: "smooth_turn_compression" },
      ]);
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return storageFailure(`schedule turn derivation repair failed: ${reason}`);
  }
}

async function scheduleChunkDerivationRepair(
  threadRef: ThreadRef,
  chunkId: string,
  derivationType: "chunk_summary_detailed" | "chunk_summary_brief",
): Promise<OpResult<TurnDerivationRepairScheduleResult>> {
  try {
    return await createDbWriteTransaction(threadRef, (transaction) => {
      if (!chunkExists(transaction.db, chunkId)) {
        return failedScheduleRepair(chunkId, {
          errorClass: "caller_error",
          code: "turn_not_found",
          reason: `no chunk ${chunkId} exists in this thread`,
        });
      }
      return scheduleTurnOwned(transaction, derivationType, { chunkId }, [
        { subjectKind: "chunk", subjectId: chunkId, derivationType },
      ]);
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return storageFailure(`schedule chunk derivation repair failed: ${reason}`);
  }
}

export function scheduleDetailedChunkDerivationRepair(
  threadRef: ThreadRef,
  chunkId: string,
): Promise<OpResult<TurnDerivationRepairScheduleResult>> {
  return scheduleChunkDerivationRepair(threadRef, chunkId, "chunk_summary_detailed");
}

export function scheduleBriefChunkDerivationRepair(
  threadRef: ThreadRef,
  chunkId: string,
): Promise<OpResult<TurnDerivationRepairScheduleResult>> {
  return scheduleChunkDerivationRepair(threadRef, chunkId, "chunk_summary_brief");
}
