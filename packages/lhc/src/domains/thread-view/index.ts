// thread-view surface (Epic 03): pull, status, compact, sweep, materialize.
// Story 1 lands the skeleton with `pull` and `status` real — the hot-path
// reads: local reads and deterministic string assembly only, no inference,
// no network, no queue interaction, no writes (AC-1.1, AC-2.8). The other
// three are structured-result stubs until their stories (2, 3, 5) land.
// Story 0's substrate (profile resolution, consumed by createSdk) re-exports
// at the bottom.
import { existsSync } from "node:fs";
import {
  resolveInstanceViewConfig,
  runWithThreadTouchSuppressed,
} from "../../shared/context.js";
import type { FormReportEntry } from "../../shared/derivation.js";
import { storageFailure, type ErrorResult, type OpResult } from "../../shared/errors.js";
import type {
  CompactReceipt,
  PullResult,
  ResolvedViewConfig,
  SweepReceipt,
  ViewMessage,
  ViewProfile,
  ViewStatus,
} from "../../shared/view.js";
import * as messagesDomain from "../messages/index.js";
import * as turnsDomain from "../turns/index.js";
import {
  openThreadDatabase,
  resolveThreadRef,
  type ThreadRef,
} from "../threads/index.js";
import { readBoundaryPosition, visibilityZoneTokens } from "./internal/boundary.js";
import { resolveViewConfig } from "./internal/profiles.js";
import {
  renderBandMessage,
  renderTailMessage,
  toolNamesByCallId,
} from "./internal/render.js";
import {
  readReadyToolResultSummaries,
  readTailMessages,
  readViewSnapshot,
  tailTokenSum,
} from "./internal/snapshot.js";

// Config resolution for the operation in hand: the SDK instance's resolved
// view config rides the per-instance seam (epic-fix-001 pattern, tech design
// Flow 4); below-SDK direct domain calls fall back to the built-in defaults
// through the same one resolution path createSdk uses.
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

async function pullInner(ref: ThreadRef): Promise<OpResult<PullResult>> {
  const resolved = await resolveThreadRef(ref);
  if (!resolved.ok) return resolved;
  const { filePath } = resolved.value;
  if (!existsSync(filePath)) return threadNotFound(filePath);

  const opened = openThreadDatabase(filePath);
  if (!opened.ok) return opened;
  const db = opened.value;
  try {
    const snapshot = readViewSnapshot(db);
    const compactPoint = snapshot?.compactPoint ?? 0;
    const boundaryPosition = readBoundaryPosition(db);
    const tailRows = readTailMessages(db, compactPoint);
    const renderCtx = {
      boundaryPosition,
      toolNameByCallId: toolNamesByCallId(tailRows),
      toolResultSummaries: readReadyToolResultSummaries(db),
    };

    const messages: ViewMessage[] = [];
    if (snapshot !== null) {
      for (const band of snapshot.bands) {
        messages.push(renderBandMessage(band.band, band.renderedText));
      }
    }
    for (const row of tailRows) {
      messages.push(renderTailMessage(row, renderCtx));
    }

    return {
      ok: true,
      value: {
        messages,
        meta: {
          compactPoint: snapshot?.compactPoint ?? null,
          coveredFrom: snapshot?.coveredFrom ?? null,
          boundaryPosition,
          gapCount: snapshot?.gapCount ?? 0,
          degradedCount: snapshot?.degradedCount ?? 0,
          viewId: snapshot?.viewId ?? null,
          createdAt: snapshot?.createdAt ?? null,
        },
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
  entries: readonly FormReportEntry[],
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
// direct derived_form read here), the active view's health or null
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

// ── stubs (Stories 2, 3, 5) ──────────────────────────────────────

// The skeleton's stub contract (tech design §Interface Definitions):
// structured result, machine-readable, never a throw on this surface.
function notImplemented(op: string): { ok: false; error: ErrorResult } {
  return {
    ok: false,
    error: {
      errorClass: "system_error",
      code: "not_implemented",
      reason: `not implemented: ${op}`,
    },
  };
}

export async function compact(
  ref: ThreadRef,
  opts: { profile?: string; params?: Partial<ViewProfile>; sweep?: boolean },
): Promise<OpResult<CompactReceipt>> {
  void ref;
  void opts;
  return notImplemented("compact");
}

export async function sweep(ref: ThreadRef): Promise<OpResult<SweepReceipt>> {
  void ref;
  return notImplemented("sweep");
}

export async function materialize(
  ref: ThreadRef,
  opts: { path: string; format?: "pi-session" },
): Promise<OpResult<{ writtenPath: string }>> {
  void ref;
  void opts;
  return notImplemented("materialize");
}

// ── Story 0 substrate (consumed by createSdk at construction) ─────
export {
  BUILT_IN_PROFILES,
  DEFAULT_COMPACT_THRESHOLD,
  DEFAULT_VISIBILITY,
  resolveViewConfig,
} from "./internal/profiles.js";
