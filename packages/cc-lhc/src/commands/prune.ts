import type { Lhc, PruneReceipt, ThreadRef } from "lhc";
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

function formatPruneReceipt(receipt: PruneReceipt): string {
  return [
    `prune boundary ${receipt.previousBoundary} -> ${receipt.newBoundary}`,
    `zone tokens ${receipt.zoneTokensBefore} -> ${receipt.zoneTokensAfter}`,
    `tool_results_pruned=${receipt.toolResultsPruned}`,
    receipt.noOp ? "no-op" : "applied",
  ].join("\n");
}

function parseTargetTokens(commandLine: string): number | undefined {
  const parts = commandLine.trim().split(/\s+/);
  if (parts.length < 2) return undefined;
  const parsed = Number.parseInt(parts[1] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
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

export async function runPruneCommand(commandLine: string, runtime: LhcCommandRuntime): Promise<DispatchOutcome> {
  const blocked = notReady(runtime);
  if (blocked !== null) return blocked;

  const leaseGeneration = runtime.getCaptureGeneration?.() ?? runtime.captureGeneration ?? 0;
  const fenced = mutationFence(runtime, leaseGeneration);
  if (fenced !== null) return { messages: [fenced] };

  const sdk = runtime.sdk as Lhc;
  const threadRef = runtime.threadRef as ThreadRef;
  const threadId = threadIdFromRef(threadRef);
  const targetTokens = parseTargetTokens(commandLine);
  const pruneResult = await sdk.threadView.prune(threadRef, targetTokens === undefined ? {} : { targetTokens });
  const afterPrune = mutationFence(runtime, leaseGeneration);
  if (afterPrune !== null) {
    return { messages: [CAPTURE_PARTIAL_VIEW_MUTATION] };
  }
  if (!pruneResult.ok) return { messages: [`prune error: ${pruneResult.error.reason}`] };

  const receipt = pruneResult.value;
  const lines = [formatPruneReceipt(receipt)];
  if (receipt.noOp) return { messages: lines };

  const view = await sdk.threadView.getSessionThreadView(threadRef);
  const afterView = mutationFence(runtime, leaseGeneration);
  if (afterView !== null) return { messages: [...lines, CAPTURE_PARTIAL_VIEW_MUTATION] };
  if (!view.ok) return { messages: [...lines, `view error: ${view.error.reason}`] };

  try {
    const afterStat = mutationFence(runtime, leaseGeneration);
    if (afterStat !== null) return { messages: [...lines, CAPTURE_PARTIAL_VIEW_MUTATION] };
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

    return {
      messages: [
        ...lines,
        ...formatRebuildRelaunchGuidance({
          operation: "prune",
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
