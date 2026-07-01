// thread-view surface: model context, status, compact, materialize, and
// describe. Hot-path reads use local deterministic assembly only: no inference,
// no network, no queue interaction, and no writes. Profile resolution consumed
// by initLhc is re-exported at the bottom.
import { existsSync } from "node:fs";
import * as path from "node:path";
import * as messagesDomain from "../messages/index.js";
import type {
  Band,
  CompactReceipt,
  DerivationReportEntry,
  LlmRequestContext,
  PreviewCompactOutcome,
  ResolvedViewConfig,
  SessionThreadView,
  StoredView,
  ViewCompactParams,
  ViewProfile,
  ViewStatus,
} from "../shared-tech/index.js";
import {
  createDbReadTransaction,
  type DbReadTransaction,
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
import {
  compactStopped,
  compactWouldWriteSnapshot,
  computeArrangement,
  readStoredCompactPoint,
} from "./internal/compact-compute.js";
import { type MaterializeInput, writePiSessionFile } from "./internal/materialize.js";
import { profileViolation, resolveViewConfig } from "./internal/profiles.js";
import { assembleBandText } from "./internal/render.js";
import { fireViewInjection } from "./internal/seam.js";
import type { ArrangementEntry } from "./internal/select.js";
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

// Derivation counts bucket from one report entry the way the report's own
// vocabulary reads (shared/derivation.ts): never-attempted or first-flight
// pending, retrying (pending with attempts spent), failed, blocked. Ready
// Ready derivations are healthy and not an operational situation.
function bucketDerivation(entries: readonly DerivationReportEntry[], counts: ViewStatus["derivation"]): void {
  for (const entry of entries) {
    switch (entry.state) {
      case "pending":
        if ((entry.queue?.attempts ?? 0) > 0) counts.retrying += 1;
        else counts.pending += 1;
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
    retrying: 0,
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

function selectionWouldWriteSnapshot(
  transaction: DbReadTransaction,
  selection: { compactPoint: number; entries: ArrangementEntry[] },
): boolean {
  if (selection.compactPoint <= 0) return false;
  const stored = readStoredView(transaction.db);
  if (stored === null) return true;
  if (selection.compactPoint !== stored.compactPoint) return selection.compactPoint > stored.compactPoint;

  const arrangement = selection.entries.map((entry) => ({
    band: entry.band,
    subjectKind: entry.subjectKind,
    subjectId: entry.subjectId,
    derivationUsed: entry.derivationUsed,
    degraded: entry.degraded,
  }));
  const gaps = selection.entries
    .filter((entry) => entry.gap)
    .map((entry) => ({
      band: entry.band,
      subjectId: entry.subjectId,
      reason: entry.reason ?? "unknown",
    }));
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

// Compact runs only when invoked through this surface; no core path calls it.
// Order: validate profile/params before IO, read record + derivations with
// corruption checks before the write transaction, run selection, render bands,
// replace the view and reset the boundary in one BEGIN IMMEDIATE, then return a
// receipt. Assembly is entirely from stored artifacts: nothing here can reach
// inference or schedule repair work.
export async function compact(
  ref: ThreadRef,
  opts: { profile?: string; params?: ViewCompactParams; signal?: { aborted: boolean } },
): Promise<OpResult<CompactReceipt>> {
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
    });
    if (!computed.ok) return computed;

    const { selection, inputs, viewId, firstKeptMessageId } = computed.value;

    if (!compactWouldWriteSnapshot(db, selection.compactPoint)) {
      const stored = readStoredCompactPoint(db);
      return {
        ok: false,
        error: {
          errorClass: "caller_error",
          code: "compact_unchanged",
          reason: `compact point ${selection.compactPoint} would not advance stored compact point ${stored}`,
        },
      };
    }

    const warnings: CompactReceipt["warnings"] = selection.entries
      .filter((entry) => entry.derivationUsed === "stored_member_concat")
      .map((entry) => ({
        band: entry.band,
        subjectId: entry.subjectId,
        derivationType: entry.band === "brief" ? "chunk_summary_brief" : "chunk_summary_detailed",
        reason: entry.reason ?? "not_ready",
      }));
    for (const warning of warnings) {
      writeLog(transaction, {
        level: "warning",
        message: "compact chunk fallback used",
        derivationType: warning.derivationType,
        subjectId: warning.subjectId,
        reason: warning.reason,
        floorUsed: "stored_member_concat",
      });
    }

    const entriesByBand = (band: Band): ArrangementEntry[] => selection.entries.filter((entry) => entry.band === band);
    const bands = BAND_ORDER.flatMap((band) => {
      const entries = entriesByBand(band);
      if (entries.length === 0) return [];
      const renderedText = assembleBandText(entries.map((entry) => entry.text));
      return [{ band, renderedText, tokenCount: estimateTokens(renderedText) }];
    });

    const createdAt = new Date().toISOString();

    fireViewInjection("compact-write");

    if (compactStopped(opts.signal)) {
      return callerError("compact_stopped", "compact stopped before snapshot write");
    }

    replaceViewSnapshot(db, {
      viewId,
      createdAt,
      compactPoint: selection.compactPoint,
      coveredFrom: selection.coveredFrom,
      profileName,
      configJson: JSON.stringify({
        lowerBound: merged.lowerBound,
        percentages: merged.percentages,
      }),
      arrangementJson: JSON.stringify(
        selection.entries.map((entry) => ({
          band: entry.band,
          subjectKind: entry.subjectKind,
          subjectId: entry.subjectId,
          derivationUsed: entry.derivationUsed,
          degraded: entry.degraded,
        })),
      ),
      gapsJson: JSON.stringify(
        selection.entries
          .filter((entry) => entry.gap)
          .map((entry) => ({
            band: entry.band,
            subjectId: entry.subjectId,
            reason: entry.reason ?? "unknown",
          })),
      ),
      sourceStateJson: JSON.stringify({
        maxEventOrder: inputs.maxEventOrder,
        derivationCounts: inputs.derivationCounts,
      }),
      bands,
    });

    const bandReport = {} as CompactReceipt["bands"];
    for (const band of BAND_ORDER) {
      const stored = bands.find((row) => row.band === band);
      bandReport[band] = {
        entries: entriesByBand(band).length,
        tokens: stored?.tokenCount ?? 0,
      };
    }
    const tailTokens = tailTokenSum(db, selection.compactPoint);
    const renderedBands = buildRenderedBands(selection, bands);
    return {
      ok: true,
      value: {
        viewId,
        profile: profileName,
        config: { ...merged.percentages, lowerBound: merged.lowerBound },
        bands: bandReport,
        tailTokens,
        totalTokens: bandReport.brief.tokens + bandReport.detailed.tokens + bandReport.smooth.tokens + tailTokens,
        coveredFrom: selection.coveredFrom,
        compactPoint: selection.compactPoint,
        degraded: selection.entries
          .filter((entry) => entry.degraded)
          .map((entry) => ({
            band: entry.band,
            subjectId: entry.subjectId,
            usedDerivation: entry.derivationUsed,
          })),
        gaps: selection.entries
          .filter((entry) => entry.gap)
          .map((entry) => ({
            band: entry.band,
            subjectId: entry.subjectId,
            reason: entry.reason ?? "unknown",
          })),
        warnings,
        renderedBands,
        firstKeptMessageId,
      },
    };
  } catch (cause) {
    return storageFailure(`view compact failed: ${detail(cause)}`);
  } finally {
    db.close();
  }
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
