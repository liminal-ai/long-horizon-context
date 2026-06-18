// thread-view surface (Epic 03): pull, status, compact, sweep, materialize;
// Epic 04 Story 3 adds describe (the stored-snapshot read inspect composes).
// Story 1 landed the hot-path reads (`pull`, `status`): local reads and
// deterministic string assembly only, no inference, no network, no queue
// interaction, no writes (AC-1.1, AC-2.8). Story 2 landed `compact`;
// Story 3 landed `sweep` (standalone and embedded default-on in compact);
// Story 5 lands `materialize` (the PI session-file render target over the
// same pull assembly). Story 0's substrate (profile resolution, consumed by
// initLhc) re-exports at the bottom.
import { existsSync } from "node:fs";
import * as path from "node:path";
import {
  resolveInstanceViewConfig,
  resolveInstancePoke,
  runWithThreadTouchSuppressed,
  type OperationContext,
} from "../shared-tech/index.js";
import type { DerivationReportEntry } from "../shared-tech/index.js";
import { storageFailure, type ErrorResult, type OpResult } from "../shared-tech/index.js";
import type {
  CompactReceipt,
  PullResult,
  ResolvedViewConfig,
  StoredView,
  SweepReceipt,
  ViewCompactParams,
  ViewMessage,
  ViewProfile,
  ViewStatus,
} from "../shared-tech/index.js";
import * as messagesDomain from "../messages/index.js";
import * as turnsDomain from "../turns/index.js";
import { writeLog } from "../shared-tech/logging/index.js";
import {
  openThreadDatabase,
  resolveThreadRef,
  type ThreadRef,
} from "../threads/index.js";
import {
  executeBoundaryAdvance,
  readBoundaryPosition,
  visibilityZoneTokens,
} from "./internal/boundary.js";
import { profileViolation, resolveViewConfig } from "./internal/profiles.js";
import {
  assembleBandText,
  renderBandMessage,
  renderTailMessage,
  toolNamesByCallId,
} from "./internal/render.js";
import { fireViewInjection } from "./internal/seam.js";
import {
  CanonicalCorruptionError,
  readSelectionInputs,
  selectArrangement,
  type ArrangementEntry,
} from "./internal/select.js";
import { writePiSessionFile, type MaterializeInput } from "./internal/materialize.js";
import {
  readReadyToolResultSummaries,
  readStoredView,
  readTailMessages,
  readThreadMetadata,
  readViewSnapshot,
  replaceViewSnapshot,
  tailTokenSum,
} from "./internal/snapshot.js";
import { runSweep } from "./internal/sweep.js";
import { estimateTokens } from "../shared-tech/token-counting/index.js";
import type { Band } from "../shared-tech/index.js";

// Config resolution for the operation in hand: the SDK instance's resolved
// view config rides the per-instance seam (epic-fix-001 pattern, tech design
// Flow 4); below-SDK direct domain calls fall back to the built-in defaults
// through the same one resolution path initLhc uses.
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

// ── pull (Flow 1: AC-1.1–1.3, 1.5 default-boundary leg, 1.7) ─────

// The hot-path read: view header + bands (if any), tail messages after the
// compact point (deleted-filtered, record order), boundary position; then
// format — band messages first, tail per the mapping table, tool results
// at-or-behind the boundary in short form. No view row ⇒ the whole record is
// tail from event 1 (AC-1.3) through this same code path with the compact
// point at its zero origin — snapshot-absent, never a separate branch.
//
// Reads-only is structural, not disciplined: the whole operation runs in the
// touch-suppressed scope, so the open announcement that would let a
// background SDK's scheduler hang a first-touch catch-up drain off this read
// (openThreadDatabase → fireThreadTouch → scheduler.touch) never fires —
// AC-1.1's no-queue-interaction holds in both host modes.
export async function pull(ref: ThreadRef): Promise<OpResult<PullResult>> {
  return runWithThreadTouchSuppressed(() => pullInner(ref));
}

// The one assembly both render targets consume (Story 5): pull serves the
// messages; materialize serves the same entries with the metadata the file's
// generated fields derive from (entry ids, record-time timestamps). Sharing
// the array is what makes AC-5.3's parity structural — materialize cannot
// diverge from pull because there is no second assembly to diverge.
interface AssembledView {
  entries: Array<{ message: ViewMessage; entryId: string; timestamp: string }>;
  meta: PullResult["meta"];
  snapshot: ReturnType<typeof readViewSnapshot>;
}

function assembleView(db: Parameters<typeof readViewSnapshot>[0]): AssembledView {
  const snapshot = readViewSnapshot(db);
  const compactPoint = snapshot?.compactPoint ?? 0;
  const boundaryPosition = readBoundaryPosition(db);
  const tailRows = readTailMessages(db, compactPoint);
  const renderCtx = {
    boundaryPosition,
    toolNameByCallId: toolNamesByCallId(tailRows),
    toolResultSummaries: readReadyToolResultSummaries(db),
  };

  const entries: AssembledView["entries"] = [];
  if (snapshot !== null) {
    for (const band of snapshot.bands) {
      entries.push({
        message: renderBandMessage(band.band, band.renderedText),
        // Band entries are not record messages; their generated fields
        // derive from view metadata (AC-5.2).
        entryId: `${snapshot.viewId}-${band.band}`,
        timestamp: snapshot.createdAt,
      });
    }
  }
  for (const row of tailRows) {
    entries.push({
      message: renderTailMessage(row, renderCtx),
      entryId: row.messageId,
      timestamp: row.recordedAt,
    });
  }

  return {
    entries,
    meta: {
      compactPoint: snapshot?.compactPoint ?? null,
      coveredFrom: snapshot?.coveredFrom ?? null,
      boundaryPosition,
      gapCount: snapshot?.gapCount ?? 0,
      degradedCount: snapshot?.degradedCount ?? 0,
      viewId: snapshot?.viewId ?? null,
      createdAt: snapshot?.createdAt ?? null,
    },
    snapshot,
  };
}

async function pullInner(ref: ThreadRef): Promise<OpResult<PullResult>> {
  const resolved = await resolveThreadRef(ref);
  if (!resolved.ok) return resolved;
  const { filePath } = resolved.value;
  if (!existsSync(filePath)) return threadNotFound(filePath);

  const opened = openThreadDatabase(filePath);
  if (!opened.ok) return opened;
  const db = opened.value;
  try {
    const assembled = assembleView(db);
    return {
      ok: true,
      value: {
        messages: assembled.entries.map((entry) => entry.message),
        meta: assembled.meta,
      },
    };
  } catch (cause) {
    return storageFailure(`view pull failed: ${detail(cause)}`);
  } finally {
    db.close();
  }
}

// ── status (AC-2.8) ───────────────────────────────────────────────

// Derivation counts bucket from one report entry the way the report's own
// vocabulary reads (shared/derivation.ts): never-attempted or first-flight
// pending, retrying (pending with attempts spent), failed, blocked. Ready
// forms are healthy and not an operational situation.
function bucketDerivation(
  entries: readonly DerivationReportEntry[],
  counts: ViewStatus["derivation"],
): void {
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
// by the same query the Story 4 advance will use, so "visible in status" is
// structural, not stored.
//
// Like pull, the whole read — including the owners' report surfaces it
// consumes — runs in the touch-suppressed scope, so a background SDK's
// status can never schedule a catch-up drain (AC-2.8 reads-only, both
// host modes).
export async function status(ref: ThreadRef): Promise<OpResult<ViewStatus>> {
  return runWithThreadTouchSuppressed(() => statusInner(ref));
}

async function statusInner(ref: ThreadRef): Promise<OpResult<ViewStatus>> {
  const resolved = await resolveThreadRef(ref);
  if (!resolved.ok) return resolved;
  const { filePath } = resolved.value;
  if (!existsSync(filePath)) return threadNotFound(filePath);

  const config = viewConfig();
  const opened = openThreadDatabase(filePath);
  if (!opened.ok) return opened;
  const db = opened.value;
  let tailTokens: number;
  let zoneTokens: number;
  let view: ViewStatus["view"];
  try {
    const snapshot = readViewSnapshot(db);
    const compactPoint = snapshot?.compactPoint ?? 0;
    const boundaryPosition = readBoundaryPosition(db);
    tailTokens = tailTokenSum(db, compactPoint);
    zoneTokens = visibilityZoneTokens(db, boundaryPosition, compactPoint);
    view =
      snapshot === null
        ? null
        : {
            degraded: snapshot.degradedCount,
            gaps: snapshot.gapCount,
            builtAt: snapshot.createdAt,
          };
  } catch (cause) {
    return storageFailure(`view status failed: ${detail(cause)}`);
  } finally {
    db.close();
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
      visibility: { zoneTokens, maxTokens: config.visibility.maxTokens },
    },
  };
}

// ── describe (Epic 04 Story 3: AC-2.1, AC-2.5) ───────────────────

// The stored active view row, exposed read-only so inspect never reads
// thread-view tables directly (DD-1). Everything is the snapshot verbatim —
// arrangement, gaps, config, source-state provenance, per-band stored token
// counts; nothing is recomputed, repaired, or read from the record. Absent
// view ⇒ ok with null, mirroring status's never-compacted behavior. Like the
// other reads, the whole operation runs touch-suppressed: a background SDK's
// describe can never schedule a catch-up drain.
export async function describe(ref: ThreadRef): Promise<OpResult<StoredView | null>> {
  return runWithThreadTouchSuppressed(() => describeInner(ref));
}

async function describeInner(ref: ThreadRef): Promise<OpResult<StoredView | null>> {
  const resolved = await resolveThreadRef(ref);
  if (!resolved.ok) return resolved;
  const { filePath } = resolved.value;
  if (!existsSync(filePath)) return threadNotFound(filePath);

  const opened = openThreadDatabase(filePath);
  if (!opened.ok) return opened;
  const db = opened.value;
  try {
    return { ok: true, value: readStoredView(db) };
  } catch (cause) {
    return storageFailure(`view describe failed: ${detail(cause)}`);
  } finally {
    db.close();
  }
}

// ── compact (Flow 2: AC-2.1–2.7, 2.9, 2.10) ──────────────────────

// The default base when no profile is named: the first built-in, matching
// the epic's primary user (the PI continuation harness). Explicit params
// override the base field-wise (AC-2.2).
const DEFAULT_PROFILE_NAME = "continuation";

function callerError(
  code: "unknown_profile" | "invalid_view_config" | "compact_stopped",
  reason: string,
): { ok: false; error: ErrorResult } {
  return { ok: false, error: { errorClass: "caller_error", code, reason } };
}

const BAND_ORDER: readonly Band[] = ["brief", "detailed", "smooth"];

function compactStopped(signal: { aborted: boolean } | undefined): boolean {
  return signal?.aborted === true;
}

// Compact runs only when invoked through this surface (AC-2.1: no code path
// in core calls it). Flow, in order: validate profile/params (pre-IO, so a
// rejection provably touches nothing) → sweep, on by default, `sweep: false`
// skips (AC-3.6; the receipt records which) → read record + derivations with the
// corruption check in the reads (pre-transaction, prior view trivially
// intact on refusal) → selection walk → band rendering → one BEGIN
// IMMEDIATE replacing the view and resetting the boundary → receipt.
// Assembly is entirely from stored artifacts: nothing here can reach a
// inference (AC-2.4 zero-inference is structural — the sweep step repairs
// through owners' requeue surfaces and calls no inference either).
export async function compact(
  ref: ThreadRef,
  opts: { profile?: string; params?: ViewCompactParams; sweep?: boolean; signal?: { aborted: boolean } },
): Promise<OpResult<CompactReceipt>> {
  const resolved = await resolveThreadRef(ref);
  if (!resolved.ok) return resolved;
  const { filePath } = resolved.value;
  if (!existsSync(filePath)) return threadNotFound(filePath);

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
  // Receipt provenance: "null when explicit params" (tech design §Storage) —
  // any param override means the config is no longer a named profile's mix,
  // even when one served as the merge base; the receipt's config carries the
  // resolved truth. A bare or profile-only call names its profile.
  const profileName = opts.params === undefined ? baseName : null;

  // The sweep step (Flow 2 / Flow 3, AC-3.6): on by default so every compact
  // leaves the thread healthier than it found it; `sweep: false` skips with
  // the skip recorded in the receipt. Runs before this operation opens its
  // own handle (the owners' surfaces open theirs), and before any view
  // write — a sweep failure aborts the compact with the prior view intact.
  let sweepOutcome: SweepReceipt | { skipped: true };
  if (opts.sweep === false) {
    sweepOutcome = { skipped: true };
  } else {
    const swept = await runSweep(filePath);
    if (!swept.ok) return swept;
    sweepOutcome = swept.value;
  }

  const opened = openThreadDatabase(filePath);
  if (!opened.ok) return opened;
  const db = opened.value;
  try {
    if (compactStopped(opts.signal)) {
      return callerError("compact_stopped", "compact stopped before assembly");
    }
    let inputs;
    try {
      inputs = readSelectionInputs(db);
    } catch (cause) {
      if (cause instanceof CanonicalCorruptionError) {
        // Pre-transaction refusal: nothing was written, the prior view and
        // the record are untouched (AC-2.5).
        return {
          ok: false,
          error: { errorClass: "state_corruption", code: cause.code, reason: cause.message },
        };
      }
      throw cause;
    }
    const threadId = readThreadMetadata(db).threadId;
    const ctx: OperationContext = {
      db,
      clock: () => new Date(),
      threadId,
      onCommit: () => {},
      poke: resolveInstancePoke(),
    };
    const compactChunkMaterials = new Map<
      string,
      { kind: "ready"; content: string } | { kind: "concat"; content: string; reason: string }
    >();
    for (const chunk of inputs.chunks) {
      if (chunk.status !== "closed") continue;
      for (const derivationType of ["chunk_summary_detailed", "chunk_summary_brief"] as const) {
        if (compactStopped(opts.signal)) {
          return callerError("compact_stopped", "compact stopped during fallback assembly");
        }
        const material = turnsDomain.compactChunkMaterial(ctx, chunk.chunkId, derivationType);
        if (material.kind === "blocked") {
          return {
            ok: false,
            error: {
              errorClass: "state_corruption",
              code: "source_damaged",
              reason: material.reason,
            },
          };
        }
        compactChunkMaterials.set(`${chunk.chunkId}/${derivationType}`, material);
      }
    }
    inputs = { ...inputs, compactChunkMaterials };
    const selection = selectArrangement(inputs, {
      lowerBound: merged.lowerBound,
      percentages: merged.percentages,
    });

    const warnings: CompactReceipt["warnings"] = selection.entries
      .filter((entry) => entry.derivationUsed === "stored_member_concat")
      .map((entry) => ({
        band: entry.band,
        subjectId: entry.subjectId,
        derivationType:
          entry.band === "brief" ? "chunk_summary_brief" : "chunk_summary_detailed",
        reason: entry.reason ?? "not_ready",
      }));
    for (const warning of warnings) {
      writeLog(ctx, {
        level: "warning",
        message: "compact chunk fallback used",
        derivationType: warning.derivationType,
        subjectId: warning.subjectId,
        reason: warning.reason,
        floorUsed: "stored_member_concat",
      });
    }

    const entriesByBand = (band: Band): ArrangementEntry[] =>
      selection.entries.filter((entry) => entry.band === band);
    const bands = BAND_ORDER.flatMap((band) => {
      const entries = entriesByBand(band);
      if (entries.length === 0) return [];
      const renderedText = assembleBandText(entries.map((entry) => entry.text));
      return [{ band, renderedText, tokenCount: estimateTokens(renderedText) }];
    });

    const createdAt = new Date().toISOString();
    // view_id is v<compact event order> — deterministic, and deliberately
    // reused by an intake-free recompact (tech design L395: do not "fix"
    // into a uniqueness scheme; the singleton row is replaced whole).
    const viewId = `v${inputs.maxEventOrder}`;

    // Story-0 injection point: TC-2.4's crash between the sweep and the
    // view-write transaction. An installed hook's throw aborts here —
    // before BEGIN — so the previous view keeps serving.
    fireViewInjection("compact-write");

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
    return {
      ok: true,
      value: {
        viewId,
        profile: profileName,
        config: { ...merged.percentages, lowerBound: merged.lowerBound },
        bands: bandReport,
        tailTokens,
        // Actual assembled total vs the bound (target, not cap — AC-2.4).
        totalTokens:
          bandReport.brief.tokens +
          bandReport.detailed.tokens +
          bandReport.smooth.tokens +
          tailTokens,
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
        sweep: sweepOutcome,
        warnings,
      },
    };
  } catch (cause) {
    return storageFailure(`view compact failed: ${detail(cause)}`);
  } finally {
    db.close();
  }
}

// ── sweep (Flow 3: AC-3.1–3.5, 3.7) ──────────────────────────────

// The standalone readiness sweep: walk the owners' reports, requeue the
// transiently-failed derivations through the owners' requeue surfaces, return the
// per-owner/kind receipt. The walk itself lives in internal/sweep.ts; the
// compact embeds the same walk (AC-3.6), so standalone and embedded receipts
// share one shape by construction (AC-3.7's SDK leg; the CLI leg rides
// Story 5's process suite). Returns without waiting on any queued work
// (AC-3.2): requeues are row writes; background mode's drain heals later.
export async function sweep(ref: ThreadRef): Promise<OpResult<SweepReceipt>> {
  const resolved = await resolveThreadRef(ref);
  if (!resolved.ok) return resolved;
  const { filePath } = resolved.value;
  if (!existsSync(filePath)) return threadNotFound(filePath);
  try {
    return await runSweep(filePath);
  } catch (cause) {
    return storageFailure(`view sweep failed: ${detail(cause)}`);
  }
}

// ── boundary advance (Flow 4: AC-4.3–4.6, 4.9) ───────────────────

// The post-commit advance, Story 4. NOT a host operation: no public advance
// surface exists (story Anti-Shim Requirements) — the SDK's ThreadViewSurface
// carries only the five operations, and this function's one production caller
// is intake-stream's ctx.onCommit registration (the sanctioned
// intake→thread-view surface import, tech design §Module Boundaries). It
// runs at flush in BOTH host modes — unlike the queue poke it is cheap and
// deterministic, and a CLI intake must advance too or CLI-driven threads
// bloat. Budgets resolve through the per-instance seam exactly as the poke
// does (the flush runs synchronously inside the SDK operation's seam scope),
// falling back to the built-in defaults for direct domain calls.
//
// Synchronous and throw-permitted by contract: the registering site wraps it
// (catch + diagnose) so a failure never reaches intake's caller and never
// eats the queue poke; the boundary is then simply unchanged and the
// over-budget condition stays visible because status computes the same zone
// sum live (AC-4.9).
export function runPostCommitBoundaryAdvance(ctx: OperationContext): void {
  // Story-0 injection point (TC-4.6): fired before the advance computes; an
  // installed hook's throw stands in for an advance failure.
  fireViewInjection("post-commit-advance");
  executeBoundaryAdvance(ctx.db, viewConfig().visibility, ctx.clock);
}

// ── materialize (Flow 5: AC-5.2–5.5) ─────────────────────────────

// PI session-file materialization: run the pull assembly internally, hand
// the same entry array to the JSONL writer, return the written path. No
// thread state changes (reads + a file write outside the thread file), and
// every generated field derives from view/record metadata, never write-time
// clocks — repeating after no thread changes produces a byte-identical file
// (AC-5.2). Parity with pull is by construction: one assembly, two shapes
// (AC-5.3). A never-compacted thread materializes its tail-only pull with
// the header timestamp from the thread's created-at (AC-5.4). Like pull,
// the whole operation runs touch-suppressed: a background SDK's materialize
// can never schedule a catch-up drain.
export async function materialize(
  ref: ThreadRef,
  opts: { path: string; format?: "pi-session" },
): Promise<OpResult<{ writtenPath: string }>> {
  return runWithThreadTouchSuppressed(() => materializeInner(ref, opts));
}

async function materializeInner(
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
  const resolved = await resolveThreadRef(ref);
  if (!resolved.ok) return resolved;
  const { filePath } = resolved.value;
  if (!existsSync(filePath)) return threadNotFound(filePath);

  const opened = openThreadDatabase(filePath);
  if (!opened.ok) return opened;
  const db = opened.value;
  let input: MaterializeInput;
  try {
    const assembled = assembleView(db);
    const threadMeta = readThreadMetadata(db);
    input = {
      threadId: threadMeta.threadId,
      headerTimestamp: assembled.snapshot?.createdAt ?? threadMeta.createdAt,
      // Deterministic per thread file — never the writing process's cwd.
      cwd: path.dirname(path.resolve(filePath)),
      entries: assembled.entries,
    };
  } catch (cause) {
    return storageFailure(`view materialize failed: ${detail(cause)}`);
  } finally {
    db.close();
  }
  try {
    return { ok: true, value: writePiSessionFile(input, opts.path) };
  } catch (cause) {
    return storageFailure(
      `view materialize could not write ${opts.path}: ${detail(cause)}`,
    );
  }
}

// ── Story 0 substrate (consumed by initLhc at construction) ─────
export {
  BUILT_IN_PROFILES,
  DEFAULT_COMPACT_THRESHOLD,
  DEFAULT_VISIBILITY,
  resolveViewConfig,
} from "./internal/profiles.js";
