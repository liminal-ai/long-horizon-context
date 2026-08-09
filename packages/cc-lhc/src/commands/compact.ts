import type { Band, CompactReceipt, Lhc, ThreadRef } from "lhc";
import { CAPTURE_NOT_READY_REFUSAL } from "../intake/session.js";
import { statRolloutFile } from "../rollout/stat-file.js";
import { writeRebuiltRollout } from "../rollout/write-rebuilt.js";
import {
  CAPTURE_DEGRADED_REFUSAL,
  CAPTURE_PARTIAL_VIEW_MUTATION,
  type DispatchOutcome,
  type LhcCommandRuntime,
  TURN_OPEN_REFUSAL,
} from "./dispatch.js";
import {
  formatRebuildRelaunchGuidance,
  LINEAGE_REGISTRATION_FAILED,
  REBUILD_PARTIAL_AFTER_LINEAGE,
  registerRebuiltSessionLineage,
  threadIdFromRef,
} from "./rebuild-receipt.js";

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

function formatCompactReceipt(receipt: CompactReceipt): string {
  return [
    `compact view=${receipt.viewId} tail=${receipt.tailTokens} total=${receipt.totalTokens}`,
    formatBandSummary(receipt),
  ].join("\n");
}

function notReady(runtime: LhcCommandRuntime): DispatchOutcome | null {
  if (runtime.captureDisabled) return { messages: ["capture disabled"] };
  if (runtime.sdk === undefined || runtime.threadRef === undefined) return { messages: ["capture not ready"] };
  return null;
}

function mutationFence(runtime: LhcCommandRuntime, leaseGeneration: number): string | null {
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
  return null;
}

export async function runCompactCommand(_commandLine: string, runtime: LhcCommandRuntime): Promise<DispatchOutcome> {
  const blocked = notReady(runtime);
  if (blocked !== null) return blocked;

  const leaseGeneration = runtime.getCaptureGeneration?.() ?? runtime.captureGeneration ?? 0;
  const fenced = mutationFence(runtime, leaseGeneration);
  if (fenced !== null) return { messages: [fenced] };

  const sdk = runtime.sdk as Lhc;
  const threadRef = runtime.threadRef as ThreadRef;
  const threadId = threadIdFromRef(threadRef);

  const preview = await sdk.threadView.previewCompact(threadRef, {});
  const afterPreview = mutationFence(runtime, leaseGeneration);
  if (afterPreview !== null) return { messages: [afterPreview] };
  if (!preview.ok) return { messages: [`compact preview error: ${preview.error.reason}`] };
  if (preview.value.kind === "error") return { messages: [`compact blocked: ${preview.value.reason}`] };

  const compactResult = await sdk.threadView.compact(threadRef, {});
  const afterCompact = mutationFence(runtime, leaseGeneration);
  if (afterCompact !== null) {
    return { messages: [CAPTURE_PARTIAL_VIEW_MUTATION] };
  }
  if (!compactResult.ok) return { messages: [`compact error: ${compactResult.error.reason}`] };

  const receipt = compactResult.value;
  const lines = [formatCompactReceipt(receipt)];

  const view = await sdk.threadView.getSessionThreadView(threadRef);
  const afterView = mutationFence(runtime, leaseGeneration);
  if (afterView !== null) return { messages: [...lines, CAPTURE_PARTIAL_VIEW_MUTATION] };
  if (!view.ok) return { messages: [...lines, `view error: ${view.error.reason}`] };

  try {
    const afterStat = mutationFence(runtime, leaseGeneration);
    if (afterStat !== null) return { messages: [...lines, CAPTURE_PARTIAL_VIEW_MUTATION] };
    // oldStat retained for optional diagnostics only — no in-app swap.
    if (runtime.sourceRolloutPath !== undefined) {
      await statRolloutFile(runtime.sourceRolloutPath);
    }

    const rebuilt = await writeRebuiltRollout({
      view: view.value,
      cwd: runtime.cwd,
      ...(runtime.sourceRolloutPath === undefined ? {} : { sourceRolloutPath: runtime.sourceRolloutPath }),
      swapReceipt: { oldSessionId: runtime.sourceSessionId ?? "unknown" },
    });
    const afterRebuild = mutationFence(runtime, leaseGeneration);
    if (afterRebuild !== null) {
      return {
        messages: [
          ...lines,
          CAPTURE_PARTIAL_VIEW_MUTATION,
          "rebuild discarded from operator-ready state — live session unchanged",
        ],
      };
    }

    const lineage = await registerRebuiltSessionLineage({
      newSessionId: rebuilt.sessionId,
      threadId,
      prefixBoundary: rebuilt.prefixBoundary,
      replayedPrefixLines: rebuilt.replayedPrefixLines,
      ...(runtime.lineageDbPath === undefined ? {} : { lineageDbPath: runtime.lineageDbPath }),
      ...(runtime.lineageDeps === undefined ? {} : { lineageDeps: runtime.lineageDeps }),
      ...(runtime.logLineageError === undefined ? {} : { logError: runtime.logLineageError }),
    });
    if (!lineage.ok) {
      return {
        messages: [
          ...lines,
          `rebuild wrote ${rebuilt.sessionId} at ${rebuilt.rolloutPath}`,
          LINEAGE_REGISTRATION_FAILED,
          lineage.reason,
        ],
      };
    }

    // Final fence after lineage persistence — do not emit operator-ready
    // relaunch guidance if health/turn/generation moved during the await.
    const afterLineage = mutationFence(runtime, leaseGeneration);
    if (afterLineage !== null) {
      return {
        messages: [
          ...lines,
          `rebuild wrote ${rebuilt.sessionId} at ${rebuilt.rolloutPath}`,
          `lineage registered (thread ${threadId || "unknown"}, prefix=verified lines=${rebuilt.prefixBoundary.lineCount} bytes=${rebuilt.prefixBoundary.byteLength})`,
          CAPTURE_PARTIAL_VIEW_MUTATION,
          REBUILD_PARTIAL_AFTER_LINEAGE,
        ],
      };
    }

    // No restart plan: in-app /resume injection is retired on 2.1.226.
    return {
      messages: [
        ...lines,
        ...formatRebuildRelaunchGuidance({
          operation: "compact",
          oldSessionId: runtime.sourceSessionId ?? "unknown",
          newSessionId: rebuilt.sessionId,
          threadId,
        }),
      ],
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { messages: [...lines, `rebuild failed: ${message}`, "session left running unchanged"] };
  }
}
