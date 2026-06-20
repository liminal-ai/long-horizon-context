import { existsSync } from "node:fs";
import type { EventRecord } from "../intake-stream/index.js";
import type { Derivation, DerivationReportEntry, ResolvedSdkConfig } from "../shared-tech/index.js";
import {
  createDbReadTransaction,
  type DbReadTransaction,
  type DbWriteTransaction,
  type ErrorResult,
  type OpResult,
  resolveInstanceConfig,
  storageFailure,
} from "../shared-tech/index.js";
import { enqueue, type WorkItemRecord } from "../shared-tech/work-queue/index.js";
import { openThreadDatabase, resolveThreadRef, type ThreadRef } from "../threads/index.js";
import { type CompactChunkMaterial, compactChunkMaterialFromStoredMembers } from "./internal/chunk-recovery.js";
import { readChunkRows, readOwnedDerivations, reportTurnDerivations } from "./internal/derivations.js";
import { deriveTurnOwnedInOpenDb } from "./internal/derive.js";
import {
  closeTurn,
  countTurnMembers,
  insertOpenTurn,
  nextTurnOrder,
  readTurns,
  selectOpenTurnIds,
} from "./internal/store.js";

export interface TurnRecord {
  turnId: string;
  status: "open" | "closed";
  memberMessageIds: string[];
  openedAtEventOrder: number;
  closedAtEventOrder?: number;
  // Chunk placement (Epic 02 Story 3, AC-3.5): present once the turn's
  // derivation placed it — stored values read back, never recomputed.
  chunkId?: string;
  memberIdx?: number;
  // The turn's derived derivations as stored (Epic 02 Story 4, AC-4.7 ruling 012):
  // present only when rows exist — a closed turn carries them from the
  // moment its derivation queues. Stored state returned verbatim, mirroring
  // the message read's derivations key; reads degrade, never block.
  derivations?: Derivation[];
}

// Chunk read-back (Epic 02 Story 4, AC-4.7 ruling 012): the stored chunk
// record with live membership and its summary derivations' states attached —
// the chunk leg of "reading a message, turn, or chunk returns the record
// with derivation states".
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
  // turn, by either close path (AC-3.6). Empty when nothing closed.
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

// Closing a turn — by either close path — durably queues that turn's
// derivation work in the same transaction (AC-3.6): the close update and the
// work item commit or roll back together.
function closeTurnAndQueueWork(transaction: DbWriteTransaction, turnId: string, eventOrder: number): WorkItemRecord {
  closeTurn(transaction.db, turnId, eventOrder);
  // One work item, two derived derivations: the turn_derivation handler (Story 3)
  // lands the rendering and smooth turn compression as independent rows;
  // both go pending with the enqueue (DD-5).
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
      // Derivation read-back rides the turn read (AC-4.7): each record carries its
      // stored derived derivations, attached from one grouped query — mirroring the
      // message read's production path for "readable alongside the record".
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

// Chunk read-back with summary-derivation states attached (AC-4.7 ruling 012):
// returns stored records whatever the derivations' states — reads degrade, never
// block. Derivations attach only where rows exist (a freshly opened chunk has no
// summary rows until close queues them).
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

// ── report and repair (Epic 02 Story 4, Flow 4) ──────────────────

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
