/**
 * Shared context mutation/materialization operation for manual compact, manual
 * prune, and automatic compact. ONE settled-seam snapshot, then one pass that
 * runs to completion: prune-if-due, preview, compact, served view, ONE rebuilt
 * rollout. Compact plus a due prune is one materialization and (in the
 * wrapper) one handoff, never two.
 *
 * Forward-only construction: the snapshot is taken once, at the seam that
 * authorized the operation, and never re-read. Settled history cannot be
 * retroactively invalidated — input, capture generation changes, and turns
 * that open while construction runs append to the thread; they cannot make the
 * snapshot wrong, so nothing mid-construction may cancel the work.
 *
 * This module owns no processes: no child lifecycle, no descriptor writes, no
 * lineage persistence, no respawn. It returns a HandoffRequest for the wrapper
 * lifecycle manager.
 */

import type { Band, CompactReceipt, Lhc, PruneReceipt, ThreadRef } from "lhc";

import { CAPTURE_NOT_READY_REFUSAL } from "../intake/session.js";
import { statRolloutFile } from "../rollout/stat-file.js";
import { writeRebuiltRollout, type WriteRebuiltRolloutResult } from "../rollout/write-rebuilt.js";
import { CAPTURE_DEGRADED_REFUSAL, type LhcCommandRuntime, TURN_OPEN_REFUSAL } from "./dispatch.js";
import { threadIdFromRef } from "./rebuild-receipt.js";

/**
 * How many times the rebuilt rollout is written before the operation gives up
 * on this seam. The last attempt re-reads the installed view first: the view is
 * durable, so rebuilding from it is always available and never needs the
 * compact to run again.
 */
export const REBUILT_ROLLOUT_WRITE_ATTEMPTS = 3;

export type ContextMutationOperation = "compact" | "prune" | "auto_compact";
export type ContextMutationOrigin = "auto" | "manual";

/** Metrics behind the durable receipt and the panel's last-action line. */
export interface ContextMutationMetrics {
  origin: ContextMutationOrigin;
  /** Provider context that triggered an automatic operation (host measure). */
  triggerContextTokens?: number;
  /** Rebuilt LHC served-view size from the compact receipt (SDK measure). */
  viewTokens?: number;
  /** Configured SDK lower target. */
  targetTokens?: number;
  zoneTokensBefore?: number;
  zoneTokensAfter?: number;
}

export interface HandoffRequest {
  operation: ContextMutationOperation;
  oldSessionId: string;
  threadId: string;
  rebuilt: WriteRebuiltRolloutResult;
  /** Receipt lines describing the SDK mutation (for logs/panel). */
  receiptLines: string[];
  /** The ONE durable runtime note appended to the rebuilt rollout. */
  durableReceipt: string;
  metrics: ContextMutationMetrics;
}

/** Compact token display for receipts: 247k / 8.2k / 941. One ontology — these
 * are the same token numbers the SDK and governor report, only shortened. */
export function formatTokensShort(tokens: number): string {
  if (tokens >= 10_000) return `${Math.round(tokens / 1000)}k`;
  if (tokens >= 1_000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}

/**
 * Exactly one concise durable receipt, labeled operation:origin. "Trigger
 * context" is Claude host context (includes system/tool overhead); "LHC view"
 * is the SDK-served size — the receipt never implies they are the same measure.
 */
export function formatDurableReceipt(
  operation: ContextMutationOperation,
  metrics: ContextMutationMetrics,
  hostNotices: readonly string[] = [],
): string {
  const label = operation === "prune" ? "prune" : "compact";
  const parts: string[] = [];
  if (metrics.triggerContextTokens !== undefined) {
    parts.push(`trigger context ${formatTokensShort(metrics.triggerContextTokens)}`);
  }
  if (metrics.zoneTokensBefore !== undefined && metrics.zoneTokensAfter !== undefined) {
    parts.push(
      `tool-result zone ${formatTokensShort(metrics.zoneTokensBefore)} -> ${formatTokensShort(metrics.zoneTokensAfter)}`,
    );
  }
  if (metrics.viewTokens !== undefined) {
    const target =
      metrics.targetTokens !== undefined ? ` (${formatTokensShort(metrics.targetTokens)} target)` : "";
    parts.push(`rebuilt LHC view ${formatTokensShort(metrics.viewTokens)}${target}`);
  }
  const receipt = `[lhc ${label}:${metrics.origin}] ${parts.join("; ")}.`;
  return hostNotices.length === 0 ? receipt : [receipt, ...hostNotices].join("\n");
}

export interface ContextMutationPlan {
  operation: ContextMutationOperation;
  /** Canonical SDK profile for compact construction (compact operations). */
  profile: string;
  /** Configured SDK lower target, passed as params.lowerBound. */
  lowerBoundTokens: number;
  /**
   * Combined compact-time prune: when the tool-result zone is at/above
   * thresholdTokens, prune to targetTokens before compacting. One rebuild.
   */
  pruneIfDue?: { thresholdTokens: number; targetTokens: number };
  /** Manual prune target (operation "prune" only). */
  manualPruneTargetTokens?: number;
  /** Provider context that triggered an automatic operation (receipt detail). */
  triggerContextTokens?: number;
  /**
   * Host-level notices to carry into the compact message written to the
   * rebuilt session — today, the configuration-fallback notice. Core LHC
   * produces the compacted content; cc-lhc injects host anomalies here.
   */
  hostNotices?: readonly string[];
}

export type ContextMutationOutcome =
  | { kind: "refused"; messages: string[] }
  | { kind: "noop"; messages: string[] }
  /**
   * The LHC view is installed and durable, but this seam produced no rebuilt
   * artifact — the SDK or the filesystem failed. Nothing is rolled back and the
   * next settled seam re-materializes from the installed view.
   */
  | { kind: "partial"; messages: string[] }
  | { kind: "rebuilt"; messages: string[]; handoff: HandoffRequest };

function formatBandSummary(receipt: CompactReceipt): string {
  const bands: Band[] = ["smooth", "detailed", "brief"];
  const parts: string[] = [];
  for (const band of bands) {
    const stats = receipt.bands[band];
    if (stats.entries > 0 || stats.tokens > 0) {
      parts.push(`${band}=${stats.tokens}tok/${stats.entries}entries`);
    }
  }
  return parts.length > 0 ? parts.join(" ") : "no bands";
}

export function formatCompactReceipt(receipt: CompactReceipt): string {
  return [
    `compact view=${receipt.viewId} tail=${receipt.tailTokens} total=${receipt.totalTokens}`,
    formatBandSummary(receipt),
  ].join("\n");
}

export function formatPruneReceipt(receipt: PruneReceipt): string {
  return [
    `prune boundary ${receipt.previousBoundary} -> ${receipt.newBoundary}`,
    `zone tokens ${receipt.zoneTokensBefore} -> ${receipt.zoneTokensAfter}`,
    `tool_results_pruned=${receipt.toolResultsPruned}`,
    receipt.noOp ? "no-op" : "applied",
  ].join("\n");
}

/**
 * The settled-seam snapshot. Read ONCE, before any SDK work, and never read
 * again for the life of the operation.
 *
 * What it carries is what compact genuinely needs to exist before it starts:
 * a bound thread to compact, a turn that is not mid-flight (Claude Code has no
 * mid-agentic-turn replacement seam), and capture that has caught up so the
 * view is built from current history. It is not a fence: nothing re-reads it,
 * and no later change to any of these can cancel work already under way.
 */
export function settledSeamSnapshot(runtime: LhcCommandRuntime): string | null {
  if (runtime.sdk === undefined || runtime.threadRef === undefined) return "capture not ready";
  if (runtime.isTurnOpen?.() === true) return TURN_OPEN_REFUSAL;
  if (runtime.isCaptureReady?.() === false) {
    return runtime.capturePhase === "binding" ? CAPTURE_NOT_READY_REFUSAL : CAPTURE_DEGRADED_REFUSAL;
  }
  if (runtime.isCaptureHealthy?.() === false || runtime.captureDegraded === true) {
    return CAPTURE_DEGRADED_REFUSAL;
  }
  return null;
}

/**
 * Run the settled-seam mutation and single materialization, to completion.
 *
 * After the snapshot there are no further state or input checks. The only
 * outcomes left are what the SDK and the filesystem actually did: a compact
 * that landed and produced a rebuilt artifact (`rebuilt`), a compact that
 * landed with no artifact this seam (`partial` — the installed view is durable
 * and the next seam re-materializes from it), a prune with nothing to do
 * (`noop`), or an SDK refusal before anything changed (`refused`).
 */
export async function runContextMutation(
  plan: ContextMutationPlan,
  runtime: LhcCommandRuntime,
): Promise<ContextMutationOutcome> {
  const snapshot = settledSeamSnapshot(runtime);
  if (snapshot !== null) return { kind: "refused", messages: [snapshot] };

  const sdk = runtime.sdk as Lhc;
  const threadRef = runtime.threadRef as ThreadRef;
  const threadId = threadIdFromRef(threadRef);
  const lines: string[] = [];
  let viewMutated = false;
  const metrics: ContextMutationMetrics = {
    origin: plan.operation === "auto_compact" ? "auto" : "manual",
    ...(plan.triggerContextTokens === undefined ? {} : { triggerContextTokens: plan.triggerContextTokens }),
  };

  /** An SDK failure: `partial` once the view moved, `refused` while it has not. */
  const sdkFailure = (message: string): ContextMutationOutcome =>
    viewMutated ? { kind: "partial", messages: [...lines, message] } : { kind: "refused", messages: [message] };

  if (plan.operation === "prune") {
    const pruneResult = await sdk.threadView.prune(
      threadRef,
      plan.manualPruneTargetTokens === undefined ? {} : { targetTokens: plan.manualPruneTargetTokens },
    );
    if (!pruneResult.ok) return { kind: "refused", messages: [`prune error: ${pruneResult.error.reason}`] };
    const receipt = pruneResult.value;
    lines.push(formatPruneReceipt(receipt));
    if (receipt.noOp) return { kind: "noop", messages: lines };
    metrics.zoneTokensBefore = receipt.zoneTokensBefore;
    metrics.zoneTokensAfter = receipt.zoneTokensAfter;
    viewMutated = true;
  } else {
    // Compact path (manual or automatic): combined prune first when due.
    if (plan.pruneIfDue !== undefined) {
      const status = await sdk.threadView.status(threadRef);
      if (status.ok && status.value.visibility.zoneTokens >= plan.pruneIfDue.thresholdTokens) {
        const pruneResult = await sdk.threadView.prune(threadRef, {
          targetTokens: plan.pruneIfDue.targetTokens,
        });
        if (pruneResult.ok) {
          if (!pruneResult.value.noOp) {
            viewMutated = true;
            metrics.zoneTokensBefore = pruneResult.value.zoneTokensBefore;
            metrics.zoneTokensAfter = pruneResult.value.zoneTokensAfter;
          }
          lines.push(formatPruneReceipt(pruneResult.value));
        } else {
          // A failed due-prune does not abort the compact; it is reported.
          lines.push(`prune error: ${pruneResult.error.reason}`);
        }
      }
    }

    const compactOpts = {
      profile: plan.profile,
      params: { lowerBound: plan.lowerBoundTokens },
    };
    const preview = await sdk.threadView.previewCompact(threadRef, compactOpts);
    if (!preview.ok) return sdkFailure(`compact preview error: ${preview.error.reason}`);
    if (preview.value.kind === "error") return sdkFailure(`compact blocked: ${preview.value.reason}`);

    const compactResult = await sdk.threadView.compact(threadRef, compactOpts);
    if (!compactResult.ok) return sdkFailure(`compact error: ${compactResult.error.reason}`);
    viewMutated = true;
    metrics.viewTokens = compactResult.value.totalTokens;
    metrics.targetTokens = plan.lowerBoundTokens;
    lines.push(formatCompactReceipt(compactResult.value));
  }

  const durableReceipt = formatDurableReceipt(plan.operation, metrics, plan.hostNotices ?? []);

  // ONE rebuilt rollout for the whole operation, written from the installed
  // view. Every attempt re-reads that view, so a write that fails against a
  // stale read is retried against durable state rather than abandoned.
  const failures: string[] = [];
  for (let attempt = 1; attempt <= REBUILT_ROLLOUT_WRITE_ATTEMPTS; attempt += 1) {
    const view = await sdk.threadView.getSessionThreadView(threadRef);
    if (!view.ok) {
      failures.push(`view read attempt ${attempt}: ${view.error.reason}`);
      continue;
    }
    try {
      if (runtime.sourceRolloutPath !== undefined) {
        await statRolloutFile(runtime.sourceRolloutPath);
      }
      const rebuilt = await writeRebuiltRollout({
        view: view.value,
        cwd: runtime.cwd,
        ...(runtime.sourceRolloutPath === undefined ? {} : { sourceRolloutPath: runtime.sourceRolloutPath }),
        receipt: { text: durableReceipt },
      });
      return {
        kind: "rebuilt",
        messages: attempt === 1 ? lines : [...lines, `rebuilt rollout written on attempt ${attempt}`],
        handoff: {
          operation: plan.operation,
          oldSessionId: runtime.sourceSessionId ?? "unknown",
          threadId,
          rebuilt,
          receiptLines: [...lines],
          durableReceipt,
          metrics,
        },
      };
    } catch (cause) {
      failures.push(`write attempt ${attempt}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  return {
    kind: "partial",
    messages: [
      ...lines,
      `rebuilt rollout not written after ${REBUILT_ROLLOUT_WRITE_ATTEMPTS} attempts: ${failures.join("; ")}`,
      "LHC view is installed and durable; the next settled seam re-materializes from it",
    ],
  };
}
