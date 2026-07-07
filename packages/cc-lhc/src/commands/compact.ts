import type { Band, CompactReceipt, Lhc, ThreadRef } from "lhc";

import type { DispatchOutcome, LhcCommandRuntime } from "./dispatch.js";
import { writeRebuiltRollout } from "../rollout/write-rebuilt.js";

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

export async function runCompactCommand(_commandLine: string, runtime: LhcCommandRuntime): Promise<DispatchOutcome> {
  const blocked = notReady(runtime);
  if (blocked !== null) return blocked;

  const sdk = runtime.sdk as Lhc;
  const threadRef = runtime.threadRef as ThreadRef;

  const preview = await sdk.threadView.previewCompact(threadRef, {});
  if (!preview.ok) return { messages: [`compact preview error: ${preview.error.reason}`] };
  if (preview.value.kind === "error") return { messages: [`compact blocked: ${preview.value.reason}`] };

  const compactResult = await sdk.threadView.compact(threadRef, {});
  if (!compactResult.ok) return { messages: [`compact error: ${compactResult.error.reason}`] };

  const receipt = compactResult.value;
  const lines = [formatCompactReceipt(receipt)];

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
