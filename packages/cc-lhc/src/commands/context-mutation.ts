/**
 * Shared context mutation/materialization operation for manual compact, manual
 * prune, and automatic compact. One fenced pass: prune-if-due, preview,
 * compact, served view, ONE rebuilt rollout. Compact plus a due prune is one
 * materialization and (in the wrapper) one handoff, never two.
 *
 * This module owns no processes: no child lifecycle, no descriptor writes, no
 * lineage persistence, no respawn. It returns a HandoffRequest for the wrapper
 * lifecycle manager. Success lineage is registered by the wrapper only after
 * the replacement generation is proven ready-after-replay.
 */

import type { Band, CompactReceipt, Lhc, PruneReceipt, ThreadRef } from "lhc";

import { CAPTURE_NOT_READY_REFUSAL } from "../intake/session.js";
import { statRolloutFile } from "../rollout/stat-file.js";
import { writeRebuiltRollout, type WriteRebuiltRolloutResult } from "../rollout/write-rebuilt.js";
import {
  CAPTURE_DEGRADED_REFUSAL,
  CAPTURE_PARTIAL_VIEW_MUTATION,
  type LhcCommandRuntime,
  TURN_OPEN_REFUSAL,
} from "./dispatch.js";
import { threadIdFromRef } from "./rebuild-receipt.js";

export const INPUT_ARRIVED_REFUSAL = "input arrived — context mutation cancelled before any change";
export const INPUT_ARRIVED_PARTIAL =
  "input arrived after LHC view mutation — no session handoff; live Claude session unchanged";

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
  return `[lhc ${label}:${metrics.origin}] ${parts.join("; ")}.`;
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
   * True when user input arrived since the operation started. Checked at every
   * fence; a pre-SDK trip refuses, a post-SDK trip reports partial (view
   * mutated, no handoff).
   */
  inputEpochChanged?: () => boolean;
}

export type ContextMutationOutcome =
  | { kind: "refused"; messages: string[] }
  | { kind: "noop"; messages: string[] }
  /** SDK view mutated but fence tripped afterwards: no rebuild handoff. */
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

export function notReadyOutcome(runtime: LhcCommandRuntime): ContextMutationOutcome | null {
  if (runtime.captureDisabled) return { kind: "refused", messages: ["capture disabled"] };
  if (runtime.sdk === undefined || runtime.threadRef === undefined) {
    return { kind: "refused", messages: ["capture not ready"] };
  }
  return null;
}

/**
 * The shared mutation fence: turn closed, capture ready and healthy, capture
 * generation unchanged since the operation leased it, no input since start.
 */
export function mutationFence(
  runtime: LhcCommandRuntime,
  leaseGeneration: number,
  inputEpochChanged?: () => boolean,
): string | null {
  if (runtime.isTurnOpen?.() === true) return TURN_OPEN_REFUSAL;
  if (runtime.isCaptureReady?.() === false) {
    if (runtime.capturePhase === "binding") return CAPTURE_NOT_READY_REFUSAL;
    return CAPTURE_DEGRADED_REFUSAL;
  }
  if (runtime.isCaptureHealthy?.() === false || runtime.captureDegraded === true) {
    return CAPTURE_DEGRADED_REFUSAL;
  }
  const currentGen = runtime.getCaptureGeneration?.() ?? runtime.captureGeneration;
  if (currentGen !== undefined && currentGen !== leaseGeneration) {
    return CAPTURE_DEGRADED_REFUSAL;
  }
  if (inputEpochChanged?.() === true) return INPUT_ARRIVED_REFUSAL;
  return null;
}

/**
 * Run the fenced SDK mutation and single materialization. On success the
 * caller (wrapper) owns the handoff; on partial the view mutated but no
 * rebuild/handoff happened; on refused nothing changed.
 */
export async function runContextMutation(
  plan: ContextMutationPlan,
  runtime: LhcCommandRuntime,
): Promise<ContextMutationOutcome> {
  const blocked = notReadyOutcome(runtime);
  if (blocked !== null) return blocked;

  const leaseGeneration = runtime.getCaptureGeneration?.() ?? runtime.captureGeneration ?? 0;
  const fence = (): string | null => mutationFence(runtime, leaseGeneration, plan.inputEpochChanged);

  const fenced = fence();
  if (fenced !== null) return { kind: "refused", messages: [fenced] };

  const sdk = runtime.sdk as Lhc;
  const threadRef = runtime.threadRef as ThreadRef;
  const threadId = threadIdFromRef(threadRef);
  const lines: string[] = [];
  let viewMutated = false;
  const metrics: ContextMutationMetrics = {
    origin: plan.operation === "auto_compact" ? "auto" : "manual",
    ...(plan.triggerContextTokens === undefined ? {} : { triggerContextTokens: plan.triggerContextTokens }),
  };

  const partialOrRefused = (fenceMessage: string): ContextMutationOutcome => {
    if (!viewMutated) return { kind: "refused", messages: [...lines, fenceMessage] };
    const partialNote =
      fenceMessage === INPUT_ARRIVED_REFUSAL ? INPUT_ARRIVED_PARTIAL : CAPTURE_PARTIAL_VIEW_MUTATION;
    return { kind: "partial", messages: [...lines, partialNote] };
  };

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
    const afterPrune = fence();
    if (afterPrune !== null) return partialOrRefused(afterPrune);
  } else {
    // Compact path (manual or automatic): combined prune first when due.
    if (plan.pruneIfDue !== undefined) {
      const status = await sdk.threadView.status(threadRef);
      const afterStatus = fence();
      if (afterStatus !== null) return partialOrRefused(afterStatus);
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
        const afterDuePrune = fence();
        if (afterDuePrune !== null) return partialOrRefused(afterDuePrune);
      }
    }

    const compactOpts = {
      profile: plan.profile,
      params: { lowerBound: plan.lowerBoundTokens },
    };
    const preview = await sdk.threadView.previewCompact(threadRef, compactOpts);
    const afterPreview = fence();
    if (afterPreview !== null) return partialOrRefused(afterPreview);
    if (!preview.ok) {
      return viewMutated
        ? { kind: "partial", messages: [...lines, `compact preview error: ${preview.error.reason}`] }
        : { kind: "refused", messages: [`compact preview error: ${preview.error.reason}`] };
    }
    if (preview.value.kind === "error") {
      return viewMutated
        ? { kind: "partial", messages: [...lines, `compact blocked: ${preview.value.reason}`] }
        : { kind: "refused", messages: [`compact blocked: ${preview.value.reason}`] };
    }

    const compactResult = await sdk.threadView.compact(threadRef, compactOpts);
    const afterCompact = fence();
    if (afterCompact !== null) {
      viewMutated = true;
      return partialOrRefused(afterCompact);
    }
    if (!compactResult.ok) {
      return viewMutated
        ? { kind: "partial", messages: [...lines, `compact error: ${compactResult.error.reason}`] }
        : { kind: "refused", messages: [`compact error: ${compactResult.error.reason}`] };
    }
    viewMutated = true;
    metrics.viewTokens = compactResult.value.totalTokens;
    metrics.targetTokens = plan.lowerBoundTokens;
    lines.push(formatCompactReceipt(compactResult.value));
  }

  // ONE served-view read and ONE rebuilt rollout for the whole operation.
  const view = await sdk.threadView.getSessionThreadView(threadRef);
  const afterView = fence();
  if (afterView !== null) return partialOrRefused(afterView);
  if (!view.ok) return { kind: "partial", messages: [...lines, `view error: ${view.error.reason}`] };

  try {
    if (runtime.sourceRolloutPath !== undefined) {
      await statRolloutFile(runtime.sourceRolloutPath);
    }
    const afterStat = fence();
    if (afterStat !== null) return partialOrRefused(afterStat);

    const durableReceipt = formatDurableReceipt(plan.operation, metrics);
    const rebuilt = await writeRebuiltRollout({
      view: view.value,
      cwd: runtime.cwd,
      ...(runtime.sourceRolloutPath === undefined ? {} : { sourceRolloutPath: runtime.sourceRolloutPath }),
      receipt: { text: durableReceipt },
    });
    const afterRebuild = fence();
    if (afterRebuild !== null) {
      return {
        kind: "partial",
        messages: [
          ...lines,
          afterRebuild === INPUT_ARRIVED_REFUSAL ? INPUT_ARRIVED_PARTIAL : CAPTURE_PARTIAL_VIEW_MUTATION,
          "rebuild discarded from operator-ready state — live session unchanged",
        ],
      };
    }

    return {
      kind: "rebuilt",
      messages: lines,
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
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      kind: "partial",
      messages: [...lines, `rebuild failed: ${message}`, "session left running unchanged"],
    };
  }
}
