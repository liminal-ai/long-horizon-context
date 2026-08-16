// thread-view surface: model context, status, compact, materialize, and
// describe. Hot-path reads use local deterministic assembly only: no inference,
// no network, no queue interaction, and no writes. Profile resolution consumed
// by initLhc is re-exported at the bottom.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import * as messagesDomain from "../messages/index.js";
import type {
  Band,
  CompactReceipt,
  DerivationReportEntry,
  LlmRequestContext,
  PreviewCompactOutcome,
  PruneReceipt,
  ResolvedViewConfig,
  SessionThreadView,
  StoredView,
  ViewCompactParams,
  ViewProfile,
  ViewStatus,
} from "../shared-tech/index.js";
import {
  createDbReadTransaction,
  createDbWriteTransaction,
  type DbReadTransaction,
  type DbWriteTransaction,
  type ErrorResult,
  type OpResult,
  resolveInstanceViewConfig,
  storageFailure,
} from "../shared-tech/index.js";
import { writeLog } from "../shared-tech/logging/index.js";
import { estimateTokens } from "../shared-tech/token-counting/index.js";
import { openThreadDatabase, resolveThreadRef, type ThreadRef } from "../threads/index.js";
import * as turnsDomain from "../turns/index.js";
import { assembleView } from "./internal/assemble.js";
import { readBoundaryPosition, visibilityZoneTokens } from "./internal/boundary.js";
import { compactStopped, computeArrangement } from "./internal/compact-compute.js";
import { type MaterializeInput, writePiSessionFile } from "./internal/materialize.js";
import { profileViolation, resolveViewConfig } from "./internal/profiles.js";
import { type ProtectedBoundaryPreview, previewProtectedVisibilityBoundary } from "./internal/protected-boundary.js";
import { assembleBandText } from "./internal/render.js";
import { fireViewInjection } from "./internal/seam.js";
import type { ArrangementEntry, SelectionResult } from "./internal/select.js";
import { buildSessionThreadView } from "./internal/session-view.js";
import {
  readStoredView,
  readThreadMetadata,
  readViewSnapshot,
  replaceViewSnapshot,
  tailTokenSum,
} from "./internal/snapshot.js";

// Config resolution for the operation in hand: the SDK instance's resolved
// view config rides the per-instance seam; below-SDK direct domain calls fall
// back to the built-in defaults through the same one resolution path initLhc
// uses.
const DEFAULT_VIEW_CONFIG: ResolvedViewConfig = resolveViewConfig();

function viewConfig(): ResolvedViewConfig {
  return resolveInstanceViewConfig() ?? DEFAULT_VIEW_CONFIG;
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

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

// ── model context ────────────────────────────────────────────────

// The hot-path read: view header + bands (if any), tail messages after the
// compact point (deleted-filtered, record order), boundary position; then
// format — band messages first, tail per the mapping table, tool results
// at-or-behind the boundary in short form. No view row ⇒ the whole record is
// tail from event 1 through this same code path with the compact point at its
// zero origin: snapshot-absent, never a separate branch.
//
// Reads-only is structural, not disciplined: the whole operation runs in the
// touch-suppressed scope, so the open announcement that would let a
// background SDK's scheduler hang a first-touch catch-up drain off this read
// (openThreadDatabase → fireThreadTouch → scheduler.touch) never fires.
export async function getLlmRequestContext(ref: ThreadRef): Promise<OpResult<LlmRequestContext>> {
  try {
    return await createDbReadTransaction(ref, (transaction) => {
      const threadId = readThreadMetadata(transaction.db).threadId;
      const assembled = assembleView(transaction.db);
      return {
        threadId,
        messages: assembled.entries.map((entry) => ({
          role: entry.message.role,
          content: [{ type: "text" as const, text: entry.message.content }],
        })),
      };
    });
  } catch (cause) {
    return storageFailure(`view getLlmRequestContext failed: ${detail(cause)}`);
  }
}

// SessionManager-friendly materialization from canonical record data: compacted
// bands as user context lines, tail messages regrouped into user / assistant /
// toolResult shapes. Reads-only, touch-suppressed like getLlmRequestContext.
export async function getSessionThreadView(ref: ThreadRef): Promise<OpResult<SessionThreadView>> {
  try {
    return await createDbReadTransaction(ref, (transaction) => buildSessionThreadView(transaction.db));
  } catch (cause) {
    return storageFailure(`view getSessionThreadView failed: ${detail(cause)}`);
  }
}

// ── status ───────────────────────────────────────────────────────

// Derivation counts bucket from one report entry. Ready derivations are healthy
// and not an operational situation.
function bucketDerivation(entries: readonly DerivationReportEntry[], counts: ViewStatus["derivation"]): void {
  for (const entry of entries) {
    switch (entry.state) {
      case "pending":
        counts.pending += 1;
        break;
      case "failed":
        counts.failed += 1;
        break;
      case "blocked":
        counts.blocked += 1;
        break;
      case "ready":
        break;
    }
  }
}

// Reads only, callable any time, no side effects: tail size against the
// configured trigger threshold with a compact recommendation (`tailTokens >
// threshold`, nothing smarter — the caller owns policy), derivation counts
// by state read through the OWNERS' report surfaces (must-not-own: never a
// direct derivation read here), the active view's health or null
// pre-compact, and the visibility zone's sum against its max — computed live
// by visibilityZoneTokens, so "visible in status" is structural, not stored.
//
// Like model context, the whole read — including the owners' report surfaces it
// consumes — runs in the touch-suppressed scope, so a background SDK's
// status can never schedule a catch-up drain.
export async function status(ref: ThreadRef): Promise<OpResult<ViewStatus>> {
  const resolved = await resolveThreadRef(ref);
  if (!resolved.ok) return resolved;
  const { filePath } = resolved.value;
  if (!existsSync(filePath)) return threadNotFound(filePath);

  const config = viewConfig();
  let tailTokens: number;
  let boundaryPosition: number;
  let zoneTokens: number;
  let view: ViewStatus["view"];
  try {
    const read = await createDbReadTransaction({ filePath }, (transaction) => {
      const snapshot = readViewSnapshot(transaction.db);
      const compactPoint = snapshot?.compactPoint ?? 0;
      const boundaryPosition = readBoundaryPosition(transaction.db);
      return {
        tailTokens: tailTokenSum(transaction.db, compactPoint),
        boundaryPosition,
        zoneTokens: visibilityZoneTokens(transaction.db, boundaryPosition, compactPoint),
        view:
          snapshot === null
            ? null
            : {
                degraded: snapshot.degradedCount,
                gaps: snapshot.gapCount,
                builtAt: snapshot.createdAt,
              },
      };
    });
    if (!read.ok) return read;
    tailTokens = read.value.tailTokens;
    boundaryPosition = read.value.boundaryPosition;
    zoneTokens = read.value.zoneTokens;
    view = read.value.view;
  } catch (cause) {
    return storageFailure(`view status failed: ${detail(cause)}`);
  }

  // The owners' report surfaces open their own handles; ours is closed first
  // so the status read never holds two handles on one thread file.
  const messageReport = await messagesDomain.report({ filePath });
  if (!messageReport.ok) return messageReport;
  const turnReport = await turnsDomain.report({ filePath });
  if (!turnReport.ok) return turnReport;
  const derivation: ViewStatus["derivation"] = {
    pending: 0,
    failed: 0,
    blocked: 0,
  };
  bucketDerivation(messageReport.value, derivation);
  bucketDerivation(turnReport.value, derivation);

  return {
    ok: true,
    value: {
      tailTokens,
      threshold: config.compactThreshold,
      compactRecommended: tailTokens > config.compactThreshold,
      derivation,
      view,
      visibility: { boundaryPosition, zoneTokens, maxTokens: config.visibility.maxTokens },
    },
  };
}

// ── describe ─────────────────────────────────────────────────────

// The stored active view row, exposed read-only so inspect never reads
// thread-view tables directly. Everything is the snapshot verbatim:
// arrangement, gaps, config, source-state provenance, per-band stored token
// counts; nothing is recomputed, repaired, or read from the record. Absent
// view means ok with null, mirroring status's never-compacted behavior. Like the
// other reads, the whole operation runs touch-suppressed: a background SDK's
// describe can never schedule a catch-up drain.
export async function describe(ref: ThreadRef): Promise<OpResult<StoredView | null>> {
  try {
    return await createDbReadTransaction(ref, (transaction) => readStoredView(transaction.db));
  } catch (cause) {
    return storageFailure(`view describe failed: ${detail(cause)}`);
  }
}

// ── prune ────────────────────────────────────────────────────────

function pruneCallerError(code: "invalid_target_tokens", reason: string): { ok: false; error: ErrorResult } {
  return { ok: false, error: { errorClass: "caller_error", code, reason } };
}

function validatePruneTarget(
  targetTokens: number | undefined,
): { ok: true; value: number } | { ok: false; error: ErrorResult } {
  if (targetTokens === undefined) return { ok: true, value: viewConfig().visibility.targetTokens };
  if (!Number.isFinite(targetTokens) || !Number.isInteger(targetTokens) || targetTokens < 0) {
    return pruneCallerError(
      "invalid_target_tokens",
      `targetTokens must be a non-negative finite integer; received ${String(targetTokens)}`,
    );
  }
  return { ok: true, value: targetTokens };
}

interface ToolResultZoneRow {
  sourceEventOrder: number;
  tokenEstimate: number;
}

function readZoneToolResults(db: DatabaseSync, effectiveStart: number): ToolResultZoneRow[] {
  const rows = db
    .prepare(
      `SELECT source_event_order, token_estimate FROM message
       WHERE kind = 'tool_result' AND deleted_at IS NULL AND source_event_order > ?
       ORDER BY source_event_order DESC`,
    )
    .all(effectiveStart) as unknown as Array<{ source_event_order: number | bigint; token_estimate: number | bigint }>;
  return rows.map((row) => ({
    sourceEventOrder: Number(row.source_event_order),
    tokenEstimate: Number(row.token_estimate),
  }));
}

function tokensBehindBoundary(db: DatabaseSync, boundary: number, compactPoint: number): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(token_estimate), 0) AS total FROM message
       WHERE kind = 'tool_result' AND deleted_at IS NULL
         AND source_event_order > ? AND source_event_order <= ?`,
    )
    .get(compactPoint, boundary) as { total: number | bigint };
  return Number(row.total);
}

function countPrunedToolResults(
  db: DatabaseSync,
  previousBoundary: number,
  newBoundary: number,
  compactPoint: number,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM message
       WHERE kind = 'tool_result' AND deleted_at IS NULL
         AND source_event_order > ? AND source_event_order <= ?`,
    )
    .get(Math.max(previousBoundary, compactPoint), newBoundary) as { n: number | bigint };
  return Number(row.n);
}

function buildPruneReceipt(
  db: DatabaseSync,
  input: {
    previousBoundary: number;
    newBoundary: number;
    compactPoint: number;
    targetTokens: number;
    zoneTokensBefore: number;
    noOp: boolean;
  },
): PruneReceipt {
  const zoneTokensAfter = visibilityZoneTokens(db, input.newBoundary, input.compactPoint);
  return {
    previousBoundary: input.previousBoundary,
    newBoundary: input.newBoundary,
    compactPoint: input.compactPoint,
    targetTokens: input.targetTokens,
    toolResultsPruned: input.noOp
      ? 0
      : countPrunedToolResults(db, input.previousBoundary, input.newBoundary, input.compactPoint),
    tokensBehindBoundary: tokensBehindBoundary(db, input.newBoundary, input.compactPoint),
    zoneTokensBefore: input.zoneTokensBefore,
    zoneTokensAfter,
    noOp: input.noOp,
  };
}

function computePruneBoundary(
  rows: readonly ToolResultZoneRow[],
  targetTokens: number,
  previousBoundary: number,
): number {
  let accumulated = 0;
  for (const row of rows) {
    if (accumulated + row.tokenEstimate <= targetTokens) {
      accumulated += row.tokenEstimate;
      continue;
    }
    return row.sourceEventOrder;
  }
  return previousBoundary;
}

function pruneInTransaction(transaction: DbWriteTransaction, targetTokens: number): PruneReceipt {
  const { db } = transaction;
  const snapshot = readViewSnapshot(db);
  const compactPoint = snapshot?.compactPoint ?? 0;
  const previousBoundary = readBoundaryPosition(db);
  const effectiveStart = Math.max(previousBoundary, compactPoint);
  const zoneTokensBefore = visibilityZoneTokens(db, previousBoundary, compactPoint);

  if (zoneTokensBefore <= targetTokens) {
    return buildPruneReceipt(db, {
      previousBoundary,
      newBoundary: previousBoundary,
      compactPoint,
      targetTokens,
      zoneTokensBefore,
      noOp: true,
    });
  }

  const rows = readZoneToolResults(db, effectiveStart);
  const computedBoundary = computePruneBoundary(rows, targetTokens, previousBoundary);

  if (computedBoundary <= previousBoundary) {
    return buildPruneReceipt(db, {
      previousBoundary,
      newBoundary: previousBoundary,
      compactPoint,
      targetTokens,
      zoneTokensBefore,
      noOp: true,
    });
  }

  if (computedBoundary <= compactPoint) {
    throw new Error(`prune boundary ${computedBoundary} would land behind compact point ${compactPoint}`);
  }

  const updatedAt = transaction.clock().toISOString();
  db.prepare(`UPDATE view_boundary SET position = ?, updated_at = ? WHERE thread_singleton = 1`).run(
    computedBoundary,
    updatedAt,
  );

  return buildPruneReceipt(db, {
    previousBoundary,
    newBoundary: computedBoundary,
    compactPoint,
    targetTokens,
    zoneTokensBefore,
    noOp: false,
  });
}

// Advance the visibility boundary forward so older tool results in the
// visibility zone render short. Deterministic, no inference, one write
// transaction. Explicit commands always execute and report — a zone already
// under target returns a no-op receipt, never an error.
export async function prune(ref: ThreadRef, params?: { targetTokens?: number }): Promise<OpResult<PruneReceipt>> {
  const resolved = await resolveThreadRef(ref);
  if (!resolved.ok) return resolved;
  const { filePath } = resolved.value;
  if (!existsSync(filePath)) return threadNotFound(filePath);

  const target = validatePruneTarget(params?.targetTokens);
  if (!target.ok) return target;

  try {
    return await createDbWriteTransaction(ref, (transaction) => pruneInTransaction(transaction, target.value));
  } catch (cause) {
    return storageFailure(`view prune failed: ${detail(cause)}`);
  }
}

// ── compact ──────────────────────────────────────────────────────

// The default base when no profile is named: the first built-in, matching
// the PI continuation harness. Explicit params override the base field-wise.
const DEFAULT_PROFILE_NAME = "continuation";

function callerError(
  code: "unknown_profile" | "invalid_view_config" | "compact_stopped",
  reason: string,
): { ok: false; error: ErrorResult } {
  return { ok: false, error: { errorClass: "caller_error", code, reason } };
}

interface ResolvedCompactCall {
  merged: ViewProfile;
  profileName: string | null;
}

function resolveCompactCall(opts: {
  profile?: string;
  params?: ViewCompactParams;
}): { ok: true; value: ResolvedCompactCall } | { ok: false; error: ErrorResult } {
  const config = viewConfig();
  const baseName = opts.profile ?? DEFAULT_PROFILE_NAME;
  const base = config.profiles[baseName];
  if (base === undefined) {
    return callerError(
      "unknown_profile",
      `unknown profile "${baseName}"; configured profiles are ${Object.keys(config.profiles)
        .map((name) => `"${name}"`)
        .join(", ")}`,
    );
  }
  const merged: ViewProfile = {
    name: base.name,
    lowerBound: opts.params?.lowerBound ?? base.lowerBound,
    percentages: { ...base.percentages, ...opts.params?.percentages },
  };
  const violation = profileViolation(merged);
  if (violation !== null) return callerError("invalid_view_config", violation);
  const profileName = opts.params === undefined ? baseName : null;
  return { ok: true, value: { merged, profileName } };
}

const BAND_ORDER: readonly Band[] = ["brief", "detailed", "smooth"];

function buildRenderedBands(
  selection: { entries: ArrangementEntry[] },
  bands: Array<{ band: Band; renderedText: string; tokenCount: number }>,
): CompactReceipt["renderedBands"] {
  return BAND_ORDER.flatMap((band) => {
    const entries = selection.entries.filter((entry) => entry.band === band);
    if (entries.length === 0) return [];
    const stored = bands.find((row) => row.band === band);
    return [{ band, text: stored?.renderedText ?? assembleBandText(entries.map((entry) => entry.text)) }];
  });
}

// The view's gaps: gap entries (a rendered subject with no usable material)
// and subjects the last band's walk skipped as too large (no entry at all).
// Both are holes in the same coverage window, so both land in gaps_json and
// the receipt.
function gapNotes(selection: Pick<SelectionResult, "entries" | "skipped">): CompactReceipt["gaps"] {
  return [
    ...selection.entries
      .filter((entry) => entry.gap)
      .map((entry) => ({
        band: entry.band,
        subjectId: entry.subjectId,
        reason: entry.reason ?? "unknown",
      })),
    ...selection.skipped.map((skip) => ({
      band: skip.band,
      subjectId: skip.subjectId,
      reason: skip.reason,
    })),
  ];
}

// Preview helper for wouldProduceBands: true when compact would write a
// non-empty banded snapshot that differs from the stored view (or is the first
// write). A different compact point in either direction counts as a write —
// including regression, which compact always accepts. Same-point still
// compares arrangement/gaps so repair previews report true when the stored
// snapshot is incomplete.
function selectionWouldWriteSnapshot(
  transaction: DbReadTransaction,
  selection: Pick<SelectionResult, "compactPoint" | "entries" | "skipped">,
): boolean {
  if (selection.compactPoint <= 0) return false;
  const stored = readStoredView(transaction.db);
  if (stored === null) return true;
  if (selection.compactPoint !== stored.compactPoint) return true;

  const arrangement = selection.entries.map((entry) => ({
    band: entry.band,
    subjectKind: entry.subjectKind,
    subjectId: entry.subjectId,
    derivationUsed: entry.derivationUsed,
    degraded: entry.degraded,
  }));
  const gaps = gapNotes(selection);
  return (
    JSON.stringify(arrangement) !== JSON.stringify(stored.arrangement) ||
    JSON.stringify(gaps) !== JSON.stringify(stored.gaps)
  );
}

// Read-only compact preflight: same selection path as compact, no snapshot write.
// Runs touch-suppressed like getLlmRequestContext so background mode never
// schedules catch-up drain from a preview read.
export async function previewCompact(
  ref: ThreadRef,
  opts: { profile?: string; params?: ViewCompactParams; signal?: { aborted: boolean } },
): Promise<OpResult<PreviewCompactOutcome>> {
  const call = resolveCompactCall(opts);
  if (!call.ok) return call;

  try {
    return await createDbReadTransaction(ref, (transaction) => {
      const computed = computeArrangement(transaction.db, transaction, call.value.merged, {
        signal: opts.signal,
        includeChunkMaterials: false,
      });
      if (!computed.ok) {
        return { kind: "error", reason: computed.error.reason };
      }

      const { selection } = computed.value;
      const tailTokens = tailTokenSum(transaction.db, selection.compactPoint);
      return {
        kind: "ok",
        preview: {
          compactPoint: selection.compactPoint,
          wouldProduceBands: selectionWouldWriteSnapshot(transaction, selection),
          tailTokens,
          firstKeptMessageId: computed.value.firstKeptMessageId,
        },
      };
    });
  } catch (cause) {
    return storageFailure(`view previewCompact failed: ${detail(cause)}`);
  }
}

/**
 * Prepared compact assembly (no view write). Used by the public compact path
 * and by compact-continuation so the marker can land before install.
 */
/**
 * Strong source-state fingerprint (digest of durable inputs used by
 * arrangement/rendering). Install refuses when digests diverge beyond the
 * allowed marker delta.
 */
export type PreparedCompactSourceState = {
  maxEventOrder: number;
  /** SHA-256 hex of relevant derivation rows (id/type/state/content/version). */
  derivationDigest: string;
  /**
   * SHA-256 hex of durable source messages/blocks used by band rendering and
   * the post-compact-point tail (includes fallback band sources at/below the
   * compact point, not only rows after compact point).
   */
  tailDigest: string;
  /** SHA-256 hex of turn/chunk placement used by selection. */
  structureDigest: string;
  installedViewId: string | null;
  compactPoint: number;
};

export type PreparedCompact = {
  selection: SelectionResult;
  emptyChunkIds: readonly string[];
  maxEventOrder: number;
  derivationCounts: Record<string, Record<string, number>>;
  sourceState: PreparedCompactSourceState;
  /**
   * Turn ids whose durable messages/blocks feed prepared band text
   * (message_excerpt, stored_turn, stored_member_concat, chunk members, etc.).
   * Fingerprinted in addition to the post-compact-point tail.
   */
  selectedSourceTurnIds: readonly string[];
  viewId: string;
  firstKeptMessageId: string | null;
  profileName: string | null;
  merged: ViewProfile;
  bands: Array<{ band: Band; renderedText: string; tokenCount: number }>;
  warnings: NonNullable<CompactReceipt["warnings"]>;
  degraded: CompactReceipt["degraded"];
  gaps: CompactReceipt["gaps"];
};

function sha256Hex(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Resolve every turn id whose messages feed prepared band text.
 * Turn entries contribute their subjectId; chunk entries contribute chunk_member turns.
 */
export function selectedSourceTurnIdsFromSelection(db: DatabaseSync, selection: SelectionResult): string[] {
  const turnIds = new Set<string>();
  for (const entry of selection.entries) {
    if (entry.subjectKind === "turn") {
      turnIds.add(entry.subjectId);
      continue;
    }
    const members = db
      .prepare(`SELECT turn_id FROM chunk_member WHERE chunk_id = ? ORDER BY member_idx`)
      .all(entry.subjectId) as unknown as Array<{ turn_id: string }>;
    for (const m of members) turnIds.add(m.turn_id);
  }
  return [...turnIds].sort();
}

/**
 * Build source-state metadata for the prepared view.
 *
 * `tailDigest` covers every durable message/block used to produce prepared
 * bands and the post-compact-point tail, derived from actual selection:
 * - all messages with source_event_order > compactPoint (live tail)
 * - all messages on turns listed in `selectedSourceTurnIds` (selection
 *   subjects: message_excerpt / stored_turn / chunk-member fallbacks, etc.)
 *
 * Optional `excludeMessageIds` recomputes the digest as if those message rows
 * and blocks were absent.
 *
 * structureDigest / installedViewId describe the source used to prepare the
 * view, before empty-chunk drop and before the view row is replaced.
 */
export function readPreparedSourceState(
  db: DatabaseSync,
  compactPoint: number,
  opts: {
    excludeMessageIds?: ReadonlySet<string>;
    selectedSourceTurnIds?: readonly string[];
  } = {},
): PreparedCompactSourceState {
  const maxRow = db.prepare(`SELECT COALESCE(MAX(event_order), 0) AS m FROM event`).get() as {
    m: number | bigint;
  };
  const exclude = opts.excludeMessageIds ?? new Set<string>();
  const selectedTurns = [...(opts.selectedSourceTurnIds ?? [])].sort();

  const derivationRows = db
    .prepare(
      `SELECT subject_kind, subject_id, derivation_type, state, content, reason, source_version, metadata
       FROM derivation
       ORDER BY subject_kind, subject_id, derivation_type`,
    )
    .all() as unknown as Array<{
    subject_kind: string;
    subject_id: string;
    derivation_type: string;
    state: string;
    content: string | null;
    reason: string | null;
    source_version: number | bigint;
    metadata: string | null;
  }>;
  const derivationDigest = sha256Hex(
    JSON.stringify(
      derivationRows.map((r) => ({
        k: r.subject_kind,
        id: r.subject_id,
        t: r.derivation_type,
        s: r.state,
        c: r.content,
        r: r.reason,
        v: Number(r.source_version),
        m: r.metadata,
      })),
    ),
  );

  // Deterministic membership: post-compact tail ∪ selected band source turns.
  // When selected turns are empty (legacy callers), fall back to chunk members
  // so stored_member_concat still fingerprints.
  const placeholders = selectedTurns.map(() => "?").join(", ");
  const turnClause =
    selectedTurns.length > 0 ? `m.turn_id IN (${placeholders})` : `m.turn_id IN (SELECT turn_id FROM chunk_member)`;
  const bind = selectedTurns.length > 0 ? [compactPoint, ...selectedTurns] : [compactPoint];

  const sourceMessages = db
    .prepare(
      `SELECT m.message_id, m.kind, m.source_event_order, m.turn_id, m.deleted_at, m.token_estimate
       FROM message m
       WHERE m.source_event_order > ?
          OR ${turnClause}
       ORDER BY m.source_event_order, m.message_id`,
    )
    .all(...bind) as unknown as Array<{
    message_id: string;
    kind: string;
    source_event_order: number | bigint;
    turn_id: string;
    deleted_at: string | null;
    token_estimate: number | bigint;
  }>;
  const sourceBlocks = db
    .prepare(
      `SELECT mb.message_id, mb.block_index, mb.block_type, mb.content
       FROM message_block mb
       JOIN message m ON m.message_id = mb.message_id
       WHERE m.source_event_order > ?
          OR ${turnClause}
       ORDER BY m.source_event_order, m.message_id, mb.block_index`,
    )
    .all(...bind) as unknown as Array<{
    message_id: string;
    block_index: number | bigint;
    block_type: string;
    content: string;
  }>;
  const filteredMessages = sourceMessages.filter((m) => !exclude.has(m.message_id));
  const filteredBlocks = sourceBlocks.filter((b) => !exclude.has(b.message_id));
  const tailDigest = sha256Hex(
    JSON.stringify({
      messages: filteredMessages.map((m) => ({
        id: m.message_id,
        kind: m.kind,
        order: Number(m.source_event_order),
        turn: m.turn_id,
        deleted: m.deleted_at,
        tokens: Number(m.token_estimate),
      })),
      blocks: filteredBlocks.map((b) => ({
        id: b.message_id,
        i: Number(b.block_index),
        t: b.block_type,
        c: b.content,
      })),
    }),
  );

  const turnRows = db
    .prepare(
      `SELECT turn_id, turn_order, status, opened_at_event_order, closed_at_event_order
       FROM turns ORDER BY turn_order`,
    )
    .all() as unknown as Array<{
    turn_id: string;
    turn_order: number | bigint;
    status: string;
    opened_at_event_order: number | bigint;
    closed_at_event_order: number | bigint | null;
  }>;
  const chunkRows = db
    .prepare(`SELECT chunk_id, chunk_order, status FROM chunk ORDER BY chunk_order`)
    .all() as unknown as Array<{ chunk_id: string; chunk_order: number | bigint; status: string }>;
  const memberRows = db
    .prepare(`SELECT chunk_id, turn_id, member_idx FROM chunk_member ORDER BY chunk_id, member_idx`)
    .all() as unknown as Array<{ chunk_id: string; turn_id: string; member_idx: number | bigint }>;
  const boundary = db.prepare(`SELECT position FROM view_boundary WHERE thread_singleton = 1`).get() as
    | { position: number | bigint }
    | undefined;
  const structureDigest = sha256Hex(
    JSON.stringify({
      turns: turnRows.map((t) => ({
        id: t.turn_id,
        o: Number(t.turn_order),
        s: t.status,
        open: Number(t.opened_at_event_order),
        close: t.closed_at_event_order === null ? null : Number(t.closed_at_event_order),
      })),
      chunks: chunkRows.map((c) => ({ id: c.chunk_id, o: Number(c.chunk_order), s: c.status })),
      members: memberRows.map((m) => ({ c: m.chunk_id, t: m.turn_id, i: Number(m.member_idx) })),
      boundary: boundary === undefined ? 0 : Number(boundary.position),
    }),
  );

  const view = readViewSnapshot(db);
  return {
    maxEventOrder: Number(maxRow.m),
    derivationDigest,
    tailDigest,
    structureDigest,
    installedViewId: view?.viewId ?? null,
    compactPoint,
  };
}

export type InstallPreparedOptions = {
  signal?: { aborted: boolean };
  createdAt?: string;
  /**
   * When set, allow exactly one additional event after prepare whose
   * idempotency key matches (continue-turn marker). Any other drift refuses.
   */
  allowedMarkerIdempotencyKey?: string;
  /**
   * Atomic visibility-boundary advance installed with the prepared view.
   * Must be >= compact point and >= current boundary (monotonic). When omitted,
   * compact reset writes boundary = compactPoint (historical behavior).
   */
  visibilityBoundary?: number;
  /**
   * Expected current boundary at install time. When set, install refuses if
   * durable boundary drifted since prepare/preview.
   */
  expectedPreviousBoundary?: number;
};

export type { ProtectedBoundaryPreview };

export type PrepareCompactOptions = {
  profile?: string;
  params?: ViewCompactParams;
  signal?: { aborted: boolean };
  /**
   * Read-only boundary override for candidate rendering / source fingerprint.
   * Does not mutate durable boundary. Fingerprint still includes the durable
   * boundary in structureDigest; override is applied only at render time via
   * install options or assembleCandidate override.
   */
  visibilityBoundaryOverride?: number;
  /** Cap selection so compactPoint never advances past this event order. */
  compactPointUpperBound?: number;
};

function buildPreparedFromArrangement(
  db: DatabaseSync,
  selection: SelectionResult,
  inputs: {
    emptyChunkIds?: readonly string[];
    maxEventOrder: number;
    derivationCounts: Record<string, Record<string, number>>;
  },
  viewId: string,
  firstKeptMessageId: string | null,
  profileName: string | null,
  merged: ViewProfile,
): PreparedCompact {
  const warnings: NonNullable<CompactReceipt["warnings"]> = selection.entries
    .filter((entry) => entry.derivationUsed === "stored_member_concat")
    .map((entry) => ({
      band: entry.band,
      subjectId: entry.subjectId,
      derivationType: entry.band === "brief" ? "chunk_summary_brief" : "chunk_summary_detailed",
      reason: entry.reason ?? "not_ready",
    }));

  const entriesByBand = (band: Band): ArrangementEntry[] => selection.entries.filter((entry) => entry.band === band);
  const bands = BAND_ORDER.flatMap((band) => {
    const entries = entriesByBand(band);
    if (entries.length === 0) return [];
    const renderedText = assembleBandText(entries.map((entry) => entry.text));
    return [{ band, renderedText, tokenCount: estimateTokens(renderedText) }];
  });

  const selectedSourceTurnIds = selectedSourceTurnIdsFromSelection(db, selection);
  const sourceState = readPreparedSourceState(db, selection.compactPoint, { selectedSourceTurnIds });

  return {
    selection,
    emptyChunkIds: inputs.emptyChunkIds ?? [],
    maxEventOrder: inputs.maxEventOrder,
    derivationCounts: inputs.derivationCounts,
    sourceState,
    selectedSourceTurnIds,
    viewId,
    firstKeptMessageId,
    profileName,
    merged,
    bands,
    warnings,
    degraded: selection.entries
      .filter((entry) => entry.degraded)
      .map((entry) => ({
        band: entry.band,
        subjectId: entry.subjectId,
        usedDerivation: entry.derivationUsed,
      })),
    gaps: gapNotes(selection),
  };
}

/**
 * Validate prepared source state against current durable state.
 * Public compact: no drift allowed.
 * Continue-turn: allow exactly the marker event identified by allowedMarkerIdempotencyKey.
 * Must be called inside the same BEGIN IMMEDIATE that installs (or before any mutation).
 */
export function validatePreparedSourceState(
  db: DatabaseSync,
  prepared: PreparedCompact,
  opts: { allowedMarkerIdempotencyKey?: string } = {},
): { ok: true } | { ok: false; reason: string } {
  const selected = prepared.selectedSourceTurnIds ?? selectedSourceTurnIdsFromSelection(db, prepared.selection);
  const fingerprintOpts = { selectedSourceTurnIds: selected };
  const current = readPreparedSourceState(db, prepared.sourceState.compactPoint, fingerprintOpts);
  const prev = prepared.sourceState;

  if (current.installedViewId !== prev.installedViewId) {
    return { ok: false, reason: "serving view changed since prepare" };
  }
  if (current.structureDigest !== prev.structureDigest) {
    return { ok: false, reason: "turn/chunk structure changed since prepare" };
  }
  if (current.derivationDigest !== prev.derivationDigest) {
    return { ok: false, reason: "derivation content/state changed since prepare" };
  }

  if (opts.allowedMarkerIdempotencyKey === undefined) {
    if (current.maxEventOrder !== prev.maxEventOrder) {
      return {
        ok: false,
        reason: `event order advanced ${prev.maxEventOrder}→${current.maxEventOrder} since prepare`,
      };
    }
    if (current.tailDigest !== prev.tailDigest) {
      return { ok: false, reason: "tail message/block content changed since prepare" };
    }
    return { ok: true };
  }

  // Marker-allowed path: exactly zero or one event advance, and the only
  // source difference must be the expected marker event/message/block.
  if (current.maxEventOrder < prev.maxEventOrder) {
    return { ok: false, reason: "event order regressed since prepare" };
  }
  if (current.maxEventOrder === prev.maxEventOrder) {
    if (current.tailDigest !== prev.tailDigest) {
      return { ok: false, reason: "source message/block content changed since prepare without event advance" };
    }
    return { ok: true };
  }
  if (current.maxEventOrder !== prev.maxEventOrder + 1) {
    return {
      ok: false,
      reason: `expected at most one event advance for marker, got ${prev.maxEventOrder}→${current.maxEventOrder}`,
    };
  }
  const newEvent = db
    .prepare(`SELECT event_order, event_kind, idempotency_key FROM event WHERE event_order = ?`)
    .get(current.maxEventOrder) as
    | { event_order: number | bigint; event_kind: string; idempotency_key: string }
    | undefined;
  if (newEvent === undefined) {
    return { ok: false, reason: "new event row missing after order advance" };
  }
  if (newEvent.event_kind !== "compact_continuation_marker") {
    return {
      ok: false,
      reason: `expected compact_continuation_marker, got ${newEvent.event_kind}`,
    };
  }
  if (newEvent.idempotency_key !== opts.allowedMarkerIdempotencyKey) {
    return {
      ok: false,
      reason: `marker idempotency key mismatch (expected ${opts.allowedMarkerIdempotencyKey})`,
    };
  }
  // Identify the marker message row produced by that event.
  const markerMessage = db
    .prepare(
      `SELECT message_id FROM message
       WHERE source_event_order = ? AND kind = 'compact_continuation_marker'`,
    )
    .get(current.maxEventOrder) as { message_id: string } | undefined;
  if (markerMessage === undefined) {
    return { ok: false, reason: "marker message row missing for advanced event" };
  }
  // Recompute source digest with exactly that marker message/block removed and
  // compare to the prepared digest — catch unrelated tail/block mutations.
  const withoutMarker = readPreparedSourceState(db, prepared.sourceState.compactPoint, {
    ...fingerprintOpts,
    excludeMessageIds: new Set([markerMessage.message_id]),
  });
  if (withoutMarker.tailDigest !== prev.tailDigest) {
    return {
      ok: false,
      reason: "source message/block content changed beyond the expected continuation marker",
    };
  }
  return { ok: true };
}

/** Thrown from beforeReplace to refuse install without mutating the view. */
export class StalePreparedCompactError extends Error {
  readonly code = "stale_prepared_compact" as const;
  constructor(reason: string) {
    super(reason);
    this.name = "StalePreparedCompactError";
  }
}

/**
 * Assemble a compact without writing the serving view. Failures leave the
 * prior view intact. Callers that need a durable install use installPreparedCompact.
 */
export async function prepareCompact(
  ref: ThreadRef,
  opts: PrepareCompactOptions = {},
): Promise<OpResult<PreparedCompact>> {
  const resolved = await resolveThreadRef(ref);
  if (!resolved.ok) return resolved;
  const { filePath } = resolved.value;
  if (!existsSync(filePath)) return threadNotFound(filePath);

  const call = resolveCompactCall(opts);
  if (!call.ok) return call;
  const { merged, profileName } = call.value;

  const opened = openThreadDatabase(filePath);
  if (!opened.ok) return opened;
  const db = opened.value;
  try {
    const threadId = readThreadMetadata(db).threadId;
    const transaction: DbReadTransaction = { db, filePath, threadId };
    const computed = computeArrangement(db, transaction, merged, {
      signal: opts.signal,
      includeChunkMaterials: true,
      ...(opts.compactPointUpperBound !== undefined
        ? { compactPointUpperBound: opts.compactPointUpperBound }
        : {}),
    });
    if (!computed.ok) return computed;

    const { selection, inputs, viewId, firstKeptMessageId } = computed.value;
    const prepared = buildPreparedFromArrangement(
      db,
      selection,
      inputs,
      viewId,
      firstKeptMessageId,
      profileName,
      merged,
    );
    for (const warning of prepared.warnings) {
      writeLog(transaction, {
        level: "warning",
        message: "compact chunk fallback used",
        derivationType: warning.derivationType,
        subjectId: warning.subjectId,
        reason: warning.reason,
        floorUsed: "stored_member_concat",
      });
    }
    return { ok: true, value: prepared };
  } catch (cause) {
    return storageFailure(`view prepareCompact failed: ${detail(cause)}`);
  } finally {
    db.close();
  }
}

/**
 * Atomically activate a previously prepared compact snapshot.
 *
 * Normal background derivation or re-derivation may finish after preparation.
 * That does not invalidate the prepared view: it remains a coherent snapshot,
 * and later compacts can use the improved material. Only boundary invariants
 * and explicit cancellation can refuse activation.
 */
export async function installPreparedCompact(
  ref: ThreadRef,
  prepared: PreparedCompact,
  opts: InstallPreparedOptions = {},
): Promise<OpResult<CompactReceipt>> {
  const resolved = await resolveThreadRef(ref);
  if (!resolved.ok) return resolved;
  const { filePath } = resolved.value;
  if (!existsSync(filePath)) return threadNotFound(filePath);

  const opened = openThreadDatabase(filePath);
  if (!opened.ok) return opened;
  const db = opened.value;
  try {
    // Pre-transaction injection: tests may mutate between prepare and install
    // acquisition; validation still runs under BEGIN IMMEDIATE.
    fireViewInjection("compact-write");

    if (compactStopped(opts.signal)) {
      return callerError("compact_stopped", "compact stopped before snapshot write");
    }

    const createdAt = opts.createdAt ?? new Date().toISOString();

    try {
      const proposedBoundary = opts.visibilityBoundary;
      replaceViewSnapshot(
        db,
        {
          viewId: prepared.viewId,
          createdAt,
          compactPoint: prepared.selection.compactPoint,
          coveredFrom: prepared.selection.coveredFrom,
          profileName: prepared.profileName,
          configJson: JSON.stringify({
            lowerBound: prepared.merged.lowerBound,
            percentages: prepared.merged.percentages,
          }),
          arrangementJson: JSON.stringify(
            prepared.selection.entries.map((entry) => ({
              band: entry.band,
              subjectKind: entry.subjectKind,
              subjectId: entry.subjectId,
              derivationUsed: entry.derivationUsed,
              degraded: entry.degraded,
            })),
          ),
          gapsJson: JSON.stringify(prepared.gaps),
          // Placeholder; beforeReplace returns the validated post-marker source
          // state JSON so the written row describes what was actually installed.
          sourceStateJson: JSON.stringify({
            maxEventOrder: prepared.maxEventOrder,
            derivationCounts: prepared.derivationCounts,
          }),
          bands: prepared.bands,
          ...(proposedBoundary !== undefined ? { visibilityBoundary: proposedBoundary } : {}),
        },
        () => {
          // Inside BEGIN IMMEDIATE — atomic with replace.
          fireViewInjection("compact-install-before-validate", { db });
          // Boundary monotonicity / expected previous checks (atomic with install).
          const currentBoundary = readBoundaryPosition(db);
          if (opts.expectedPreviousBoundary !== undefined && currentBoundary !== opts.expectedPreviousBoundary) {
            throw new StalePreparedCompactError(
              `visibility boundary drifted ${opts.expectedPreviousBoundary}→${currentBoundary} since prepare`,
            );
          }
          if (proposedBoundary !== undefined) {
            if (proposedBoundary < prepared.selection.compactPoint) {
              throw new StalePreparedCompactError(
                `proposed visibility boundary ${proposedBoundary} is behind compact point ${prepared.selection.compactPoint}`,
              );
            }
            if (proposedBoundary < currentBoundary) {
              throw new StalePreparedCompactError(
                `proposed visibility boundary ${proposedBoundary} would move backward from ${currentBoundary}`,
              );
            }
          }
          turnsDomain.dropUnreadableChunks(db, prepared.emptyChunkIds);
          return undefined;
        },
      );
    } catch (cause) {
      if (cause instanceof StalePreparedCompactError) {
        return {
          ok: false,
          error: {
            errorClass: "caller_error",
            code: "stale_prepared_compact",
            reason: `prepared compact is stale: ${cause.message}`,
          },
        };
      }
      throw cause;
    }

    const bandReport = {} as CompactReceipt["bands"];
    for (const band of BAND_ORDER) {
      const stored = prepared.bands.find((row) => row.band === band);
      bandReport[band] = {
        entries: prepared.selection.entries.filter((entry) => entry.band === band).length,
        tokens: stored?.tokenCount ?? 0,
      };
    }
    const tailTokens = tailTokenSum(db, prepared.selection.compactPoint);
    const renderedBands = buildRenderedBands(prepared.selection, prepared.bands);
    return {
      ok: true,
      value: {
        viewId: prepared.viewId,
        profile: prepared.profileName,
        config: { ...prepared.merged.percentages, lowerBound: prepared.merged.lowerBound },
        bands: bandReport,
        tailTokens,
        totalTokens: bandReport.brief.tokens + bandReport.detailed.tokens + bandReport.smooth.tokens + tailTokens,
        coveredFrom: prepared.selection.coveredFrom,
        compactPoint: prepared.selection.compactPoint,
        degraded: prepared.degraded,
        gaps: prepared.gaps,
        warnings: prepared.warnings,
        renderedBands,
        firstKeptMessageId: prepared.firstKeptMessageId,
      },
    };
  } catch (cause) {
    return storageFailure(`view installPreparedCompact failed: ${detail(cause)}`);
  } finally {
    db.close();
  }
}

/**
 * Read-only protected visibility-boundary preview. Never mutates durable state.
 * Protected results are accounted at full size; only older unprotected
 * tool_result rows are eligible; boundary never moves backward and stays
 * strictly before the earliest protected result event.
 */
export async function previewProtectedBoundary(
  ref: ThreadRef,
  params: {
    protectedToolCallIds: readonly string[];
    targetZoneTokens?: number;
    compactPointOverride?: number;
  },
): Promise<OpResult<ProtectedBoundaryPreview>> {
  const resolved = await resolveThreadRef(ref);
  if (!resolved.ok) return resolved;
  const { filePath } = resolved.value;
  if (!existsSync(filePath)) return threadNotFound(filePath);
  try {
    return await createDbReadTransaction(ref, (transaction) =>
      previewProtectedVisibilityBoundary(transaction.db, params.protectedToolCallIds, {
        ...(params.targetZoneTokens !== undefined ? { targetZoneTokens: params.targetZoneTokens } : {}),
        ...(params.compactPointOverride !== undefined ? { compactPointOverride: params.compactPointOverride } : {}),
      }),
    );
  } catch (cause) {
    return storageFailure(`view previewProtectedBoundary failed: ${detail(cause)}`);
  }
}

// Compact runs only when invoked through this surface; no core path calls it.
// Order: validate profile/params before IO, prepare assembly, replace the view
// and reset the boundary in one BEGIN IMMEDIATE, then return a receipt.
// Assembly is entirely from stored artifacts: nothing here can reach inference
// or schedule repair work.
export async function compact(
  ref: ThreadRef,
  opts: { profile?: string; params?: ViewCompactParams; signal?: { aborted: boolean } },
): Promise<OpResult<CompactReceipt>> {
  const prepared = await prepareCompact(ref, opts);
  if (!prepared.ok) return prepared;
  return installPreparedCompact(ref, prepared.value, opts.signal !== undefined ? { signal: opts.signal } : {});
}

// ── materialize ──────────────────────────────────────────────────

// PI session-file materialization: run the serving assembly internally, hand
// the same entry array to the JSONL writer, return the written path. No
// thread state changes (reads + a file write outside the thread file), and
// every generated field derives from view/record metadata, never write-time
// clocks — repeating after no thread changes produces a byte-identical file
// Parity with model context is by construction: one assembly, two shapes. A
// never-compacted thread materializes its tail-only model context with the
// header timestamp from the thread's created-at. Like model context, the whole
// operation runs touch-suppressed: a background SDK's materialize can never
// schedule a catch-up drain.
export async function materialize(
  ref: ThreadRef,
  opts: { path: string; format?: "pi-session" },
): Promise<OpResult<{ writtenPath: string }>> {
  const format = opts.format ?? "pi-session";
  if (format !== "pi-session") {
    return {
      ok: false,
      error: {
        errorClass: "caller_error",
        code: "unknown_format",
        reason: `unknown materialize format "${String(format)}"; accepted formats are "pi-session"`,
      },
    };
  }
  let input: MaterializeInput;
  try {
    const read = await createDbReadTransaction(ref, (transaction) => {
      const assembled = assembleView(transaction.db);
      const threadMeta = readThreadMetadata(transaction.db);
      return {
        threadId: threadMeta.threadId,
        headerTimestamp: assembled.snapshot?.createdAt ?? threadMeta.createdAt,
        // Deterministic per thread file — never the writing process's cwd.
        cwd: path.dirname(path.resolve(transaction.filePath)),
        entries: assembled.entries,
      };
    });
    if (!read.ok) return read;
    input = read.value;
  } catch (cause) {
    return storageFailure(`view materialize failed: ${detail(cause)}`);
  }
  try {
    return { ok: true, value: writePiSessionFile(input, opts.path) };
  } catch (cause) {
    return storageFailure(`view materialize could not write ${opts.path}: ${detail(cause)}`);
  }
}

// ── initLhc substrate ────────────────────────────────────────────
export {
  BUILT_IN_PROFILES,
  DEFAULT_COMPACT_THRESHOLD,
  DEFAULT_VISIBILITY,
  resolveViewConfig,
} from "./internal/profiles.js";
