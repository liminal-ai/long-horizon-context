import type { Lhc, PruneReceipt, ThreadRef } from "lhc";

import type { DispatchOutcome, LhcCommandRuntime } from "./dispatch.js";
import { writeRebuiltRollout } from "../rollout/write-rebuilt.js";

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

export async function runPruneCommand(commandLine: string, runtime: LhcCommandRuntime): Promise<DispatchOutcome> {
  const blocked = notReady(runtime);
  if (blocked !== null) return blocked;

  const sdk = runtime.sdk as Lhc;
  const threadRef = runtime.threadRef as ThreadRef;
  const targetTokens = parseTargetTokens(commandLine);
  const pruneResult = await sdk.threadView.prune(
    threadRef,
    targetTokens === undefined ? {} : { targetTokens },
  );
  if (!pruneResult.ok) return { messages: [`prune error: ${pruneResult.error.reason}`] };

  const receipt = pruneResult.value;
  const lines = [formatPruneReceipt(receipt)];
  if (receipt.noOp) return { messages: lines };

  const view = await sdk.threadView.getSessionThreadView(threadRef);
  if (!view.ok) return { messages: [...lines, `view error: ${view.error.reason}`] };

  try {
    const rebuilt = await writeRebuiltRollout({
      view: view.value,
      cwd: runtime.cwd,
      ...(runtime.sourceRolloutPath === undefined ? {} : { sourceRolloutPath: runtime.sourceRolloutPath }),
      swapReceipt: { oldSessionId: runtime.sourceSessionId ?? "unknown" },
    });
    lines.push("resuming session in-place...");
    return {
      messages: lines,
      restart: {
        oldSessionId: runtime.sourceSessionId ?? "unknown",
        newSessionId: rebuilt.sessionId,
        rolloutPath: rebuilt.rolloutPath,
        rebuiltLineCount: rebuilt.lineCount,
        expectedReintakeLines: rebuilt.expectedReintakeLines,
        replayedPrefixLines: rebuilt.replayedPrefixLines,
      },
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { messages: [...lines, `rebuild failed: ${message}`, "session left running unchanged"] };
  }
}
