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
  storageFailure,
} from "../shared-tech/index.js";
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
  // Host-observed facts from turn_end (schema v5). Absent when unknown —
  // pre-v5 turns, prompt-boundary closes, or hosts that omit them.
  outcome?: "completed" | "aborted";
  outcomeReason?: string;
  startedAt?: string;
  endedAt?: string;
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
// hostFacts land only from turn_end; prompt-boundary closes leave them unset.
function closeTurnAndQueueWork(
  transaction: DbWriteTransaction,
  turnId: string,
  eventOrder: number,
  hostFacts: TurnCloseHostFacts = {},
): WorkItemRecord {
  closeTurn(transaction.db, turnId, eventOrder, hostFacts);
  // One work item backs two deterministic turn-owned derivation rows; compression
  // queues from the turn_derivation completion transaction.
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

// Cross-domain surface, called by intake-stream inside the batch transaction
// for every recorded event. Synchronous and throwing by design, like
// messages.create: a turn-storage failure rejects the whole batch.
export type RecordedTurnEvent = Pick<EventRecord, "eventKind" | "eventOrder" | "payload">;

export function create(transaction: DbWriteTransaction, recordedEvent: RecordedTurnEvent): TurnTransitionOutcome {
  const openTurnId = currentOpenTurnId(transaction);
  const hasMembers = countTurnMembers(transaction.db, openTurnId) > 0;
  if (recordedEvent.eventKind === "turn_end") {
    if (!hasMembers) return { transitions: [], turnId: openTurnId, queuedWork: [] };
    // Payload was closed-validated as TurnEndPayload at intake (validate.ts layer 3).
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
  // A steering prompt (host-asserted `steer: true`) arrived inside a run in
  // progress: it is a member of the open turn, never a boundary (turn parts,
  // Flow 7 — the task's turn identity survives a steer).
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

// Returns stored chunk records whatever their derivation states. Derivations
// attach only where rows exist; freshly opened chunks have none.
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

// In-transaction read for coordinators that already hold an open thread
// handle (thread-view's compact selection): the turn and chunk structure on
// the caller's handle, so thread-view asks the turns owner for turn ordering,
// boundaries, and chunk membership instead of reading the turn/chunk tables
// itself. Turns carry the deleted flag and chunks carry raw (unvalidated)
// membership so the consumer keeps ownership of the source-state corruption
// policy; it never sees the live-only shapes listTurns/listChunks return.
// The open turn's step facts for a host pressure decision (turn parts,
// AC-7.1): identity, the sum of stored member estimates, and the step edges
// read from host-supplied step indices. Deterministic, inference-free, no
// writes. Null only when the record holds no open turn (a damaged thread; the
// state machine otherwise keeps exactly one).
/** Step edges of one turn from its host-supplied step indices (any status). */
export function readTurnSteps(db: DatabaseSync, turnId: string): StepEdges {
  return stepEdges(readStepMembers(db, turnId));
}

// Part construction (turn parts): the deterministic rendering of one
// contiguous span of a turn, composed independently over exactly that span
// with no message derivation as input — the raw prompt, recorded tool
// arguments, deterministically truncated results. `trailer` is the seam line
// the walk places inside the wrapper at the span's end.
export function composeTurnPartText(
  db: DatabaseSync,
  turnId: string,
  range: { fromOrder: number; toOrder: number },
  trailer: string,
): string {
  const messages = readMemberMessages(db, turnId, range);
  // A part is bounded-plan serving: composed under the cap, explicitly, and
  // raw by design — its unsmoothed prompt and tool results are the contract,
  // not a degraded state.
  const { parts } = composeRenderingInput(messages, new Map(), { capForServing: true, rawByDesign: true });
  return composeStructuredTurnText(parts, turnId, trailer);
}

export interface WholeTurnComposition {
  text: string;
  // Whether the serving cap elided any message's construction (F1).
  capped: boolean;
}

// Whole-turn construction composed in-walk (turn parts: settle, protection,
// and bounded serving of a ready stored rendering): the same composition the
// queued turn_derivation handler stores as turn_rendering — live members with
// their message derivations where ready — requested under the bounded-serving
// cap, with no write, no floor write, no enqueue, no placement. `capped`
// reports whether the cap changed anything. Null when the turn has no live
// members.
export function composeWholeTurnText(db: DatabaseSync, turnId: string): WholeTurnComposition | null {
  const messages = readMemberMessages(db, turnId);
  if (messages.length === 0) return null;
  const derivations = readMessageDerivationRows(
    db,
    messages.map((message) => message.messageId),
  );
  const { parts, capped } = composeRenderingInput(messages, derivations, { capForServing: true });
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
  return { turnId, estimatedTokens: Number(tokens.total), edges: stepEdges(readStepMembers(db, turnId)) };
}

export interface TurnChunkStructure {
  turns: TurnStructureRow[];
  chunks: ChunkStructureRow[];
}

export function readTurnChunkStructure(db: DatabaseSync): TurnChunkStructure {
  return { turns: readTurnStructure(db), chunks: readChunkStructure(db) };
}

// Cross-domain compact hook. The caller owns the surrounding transaction;
// turns owns validation and removal of its derived chunk rows.
export function dropUnreadableChunks(db: DatabaseSync, chunkIds: readonly string[]): string[] {
  return dropEmptyReadableChunks(db, chunkIds);
}

// ── report and repair ─────────────────────────────────────────────

// This owner's repair report: every turn- and chunk-owned derivation's durable
// state joined with live queue detail in one query. Needs no inference;
// reads degrade, never block.
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
