import type { Band, CompactReceipt, Lhc, PruneReceipt, ThreadRef } from "lhc";
import type { ContinuitySnapshot } from "../continuity/snapshot.js";
import { compactConstruction } from "../governor/band-allocation.js";
import { CAPTURE_NOT_READY_REFUSAL } from "../intake/session.js";
import type { OpenAsyncWork } from "../observation/async-work.js";
import { statRolloutFile } from "../rollout/stat-file.js";
import { type WriteRebuiltRolloutResult, writeRebuiltRollout } from "../rollout/write-rebuilt.js";
import {
  formatCompactBlocked,
  formatCompactPreviewError,
  formatCompactSdkError,
  formatCompactViewLine,
} from "../wrapper/terminology.js";
import { formatCarryoverNote, formatContinuityNote, freezeLiveAsyncWork } from "./continuity-note.js";
import { CAPTURE_DEGRADED_REFUSAL, type LhcCommandRuntime, TURN_OPEN_REFUSAL } from "./dispatch.js";
import { reserveRebuiltSessionLineage, threadIdFromRef } from "./rebuild-receipt.js";

export const REBUILT_ROLLOUT_WRITE_ATTEMPTS = 3;

export type ContextMutationOperation = "compact" | "prune" | "auto_compact";
export type ContextMutationOrigin = "auto" | "manual";

export interface ContextMutationMetrics {
  origin: ContextMutationOrigin;
  triggerContextTokens?: number;
  viewTokens?: number;
  targetTokens?: number;
  zoneTokensBefore?: number;
  zoneTokensAfter?: number;
  tokenFamily?: string;
  tokenFamilySeedSource?: string;
}

export interface HandoffRequest {
  operation: ContextMutationOperation;
  oldSessionId: string;
  threadId: string;
  rebuilt: WriteRebuiltRolloutResult;
  receiptLines: string[];
  durableReceipt: string;
  metrics: ContextMutationMetrics;
  liveAsyncWork: readonly OpenAsyncWork[];
  carryover?: ContinuityCarryover;
}

export interface ContinuityCarryover {
  snapshot: ContinuitySnapshot;
  monitorOutputDir: string;
}

export type CarryoverAcceptance = { ok: true; carryover?: ContinuityCarryover } | { ok: false; detail: string };

export function formatTokensShort(tokens: number): string {
  if (tokens >= 10_000) return `${Math.round(tokens / 1000)}k`;
  if (tokens >= 1_000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}

export function formatDurableReceipt(
  operation: ContextMutationOperation,
  metrics: ContextMutationMetrics,
  hostNotices: readonly string[] = [],
  continuityNote?: string,
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
    const target = metrics.targetTokens !== undefined ? ` (${formatTokensShort(metrics.targetTokens)} target)` : "";
    parts.push(`rebuilt LHC view ${formatTokensShort(metrics.viewTokens)}${target}`);
  }
  if (metrics.tokenFamily !== undefined && metrics.tokenFamily !== "") {
    const seed =
      metrics.tokenFamilySeedSource !== undefined && metrics.tokenFamilySeedSource !== ""
        ? ` (${metrics.tokenFamilySeedSource})`
        : "";
    parts.push(`family ${metrics.tokenFamily}${seed}`);
  }
  const receipt = `[lhc ${label}:${metrics.origin}] ${parts.join("; ")}.`;
  const withNotices = hostNotices.length === 0 ? receipt : [receipt, ...hostNotices].join("\n");
  if (continuityNote === undefined || continuityNote === "") return withNotices;
  return `${withNotices}\n\n${continuityNote}`;
}

export interface ContextMutationPlan {
  operation: ContextMutationOperation;
  profile: string;
  lowerBoundTokens: number;
  pruneIfDue?: { thresholdTokens: number; targetTokens: number };
  manualPruneTargetTokens?: number;
  triggerContextTokens?: number;
  hostNotices?: readonly string[];
  liveAsyncWork?: readonly OpenAsyncWork[];
  omitContinuityNote?: boolean;
  tokenFamily?: string;
  tokenFamilySeedSource?: string;
  carryover?: ContinuityCarryover;
}

export type ContextMutationOutcome =
  | { kind: "refused"; messages: string[] }
  | { kind: "noop"; messages: string[] }
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
    formatCompactViewLine(receipt.viewId, receipt.tailTokens, receipt.totalTokens),
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

function freezeContinuitySnapshot(plan: ContextMutationPlan, runtime: LhcCommandRuntime): readonly OpenAsyncWork[] {
  if (plan.omitContinuityNote === true) return freezeLiveAsyncWork([]);
  if (plan.liveAsyncWork !== undefined) return freezeLiveAsyncWork(plan.liveAsyncWork);
  return freezeLiveAsyncWork(runtime.getLiveAsyncWork?.() ?? []);
}

export async function runContextMutation(
  plan: ContextMutationPlan,
  runtime: LhcCommandRuntime,
): Promise<ContextMutationOutcome> {
  const snapshot = settledSeamSnapshot(runtime);
  if (snapshot !== null) return { kind: "refused", messages: [snapshot] };
  const liveAsyncWork = freezeContinuitySnapshot(plan, runtime);
  let carryover = plan.carryover;
  if (carryover === undefined && plan.omitContinuityNote !== true && runtime.acceptCarryover !== undefined) {
    const accepted = runtime.acceptCarryover();
    if (!accepted.ok) return { kind: "refused", messages: [accepted.detail] };
    carryover = accepted.carryover;
  }

  const sdk = runtime.sdk as Lhc;
  const threadRef = runtime.threadRef as ThreadRef;
  const threadId = threadIdFromRef(threadRef);
  const lines: string[] = [];
  if (plan.operation !== "prune" && runtime.closeSettledSegment !== undefined) {
    const close = await runtime.closeSettledSegment();
    if (close.kind !== "skipped") lines.push(`settled segment ${close.kind}: ${close.detail}`);
  }
  let viewMutated = false;
  const tokenFamily = plan.tokenFamily ?? runtime.tokenFamily;
  const tokenFamilySeedSource = plan.tokenFamilySeedSource ?? runtime.tokenFamilySeedSource;
  const metrics: ContextMutationMetrics = {
    origin: plan.operation === "auto_compact" ? "auto" : "manual",
    ...(plan.triggerContextTokens === undefined ? {} : { triggerContextTokens: plan.triggerContextTokens }),
    ...(tokenFamily === undefined || tokenFamily === "" ? {} : { tokenFamily }),
    ...(tokenFamilySeedSource === undefined || tokenFamilySeedSource === "" ? {} : { tokenFamilySeedSource }),
  };

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
          lines.push(`prune error: ${pruneResult.error.reason}`);
        }
      }
    }

    const compactOpts = compactConstruction({
      profile: plan.profile,
      lowerBoundTokens: plan.lowerBoundTokens,
    });
    const preview = await sdk.threadView.previewCompact(threadRef, compactOpts);
    if (!preview.ok) return sdkFailure(formatCompactPreviewError(preview.error.reason));
    if (preview.value.kind === "error") return sdkFailure(formatCompactBlocked(preview.value.reason));

    const compactResult = await sdk.threadView.compact(threadRef, compactOpts);
    if (!compactResult.ok) return sdkFailure(formatCompactSdkError(compactResult.error.reason));
    viewMutated = true;
    metrics.viewTokens = compactResult.value.totalTokens;
    metrics.targetTokens = plan.lowerBoundTokens;
    lines.push(formatCompactReceipt(compactResult.value));
  }

  const durableReceipt = formatDurableReceipt(
    plan.operation,
    metrics,
    plan.hostNotices ?? [],
    plan.omitContinuityNote === true
      ? undefined
      : carryover !== undefined
        ? formatCarryoverNote(carryover.snapshot)
        : formatContinuityNote(liveAsyncWork),
  );

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
        beforeWrite: async (reservation) => {
          await reserveRebuiltSessionLineage({
            newSessionId: reservation.sessionId,
            threadId,
            prefixBoundary: reservation.prefixBoundary,
            ...(runtime.lineageDbPath === undefined ? {} : { lineageDbPath: runtime.lineageDbPath }),
            ...(runtime.lineageDeps === undefined ? {} : { lineageDeps: runtime.lineageDeps }),
            ...(runtime.logLineageError === undefined ? {} : { logError: runtime.logLineageError }),
          });
        },
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
          liveAsyncWork,
          ...(carryover === undefined ? {} : { carryover }),
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
