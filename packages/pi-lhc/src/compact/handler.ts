import type { ViewCompactParams } from "lhc";
import { estimateTokens, type LlmRequestContextMessage, type OpResult, type SessionThreadView } from "lhc";
import type { SessionState } from "../lifecycle/state.js";
import type {
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
  SessionEntry,
} from "../pi/types.js";
import type { LhcInstance } from "../shared/instance.js";
import { COMPACT_FLOOR_TOKENS, DEFAULT_COMPACT_PROFILE } from "./profile.js";
import {
  assembleCompactionResult,
  type FirstKeptMapping,
  isSummaryOnlyTail,
  mapFirstKeptToEntryId,
  summaryOnlyFirstKeptMapping,
} from "./result-mapping.js";
import type { LhcSeedEntryMap } from "./seed-entry-map.js";

export type CompactCancelCode =
  | "no_op"
  | "compact_error"
  | "no_thread"
  | "mapping_failed"
  | "invalid_compact_result"
  | "capture_incomplete";

export interface CompactDiagnostic {
  code: CompactCancelCode;
  reason: string;
}

export interface CompactHandlerDeps {
  state: SessionState | null;
  instance: LhcInstance | null;
  piSessionId: string | null;
  flushPendingCapture: (ctx: ExtensionContext) => Promise<void>;
  getSessionView: () => Promise<OpResult<SessionThreadView>>;
  findSeedEntryMap: (branchEntries: readonly SessionEntry[], activeThreadId: string) => LhcSeedEntryMap | null;
  recordCancel?: (diagnostic: CompactDiagnostic) => void | Promise<void>;
  /** Compact params for this compact (per-model resolution happens at the
   *  call site from ctx.model). Absent → the shipped default profile. */
  compactParams?: ViewCompactParams;
}

function compactSignal(event: SessionBeforeCompactEvent): { aborted: boolean } {
  return {
    get aborted() {
      return event.signal.aborted;
    },
  };
}

function servingContextTokens(messages: readonly LlmRequestContextMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message.content.map((part) => part.text).join("")), 0);
}

function formatTokenThousands(tokens: number): string {
  return `~${Math.round(tokens / 1000)}k`;
}

export async function handleSessionBeforeCompact(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  deps: CompactHandlerDeps,
): Promise<SessionBeforeCompactResult> {
  const cancel = async (code: CompactCancelCode, reason: string): Promise<SessionBeforeCompactResult> => {
    await deps.recordCancel?.({ code, reason });
    return { cancel: true };
  };

  try {
    if (deps.state === null || deps.instance === null) {
      return await cancel("no_thread", "no active LHC thread");
    }

    await deps.flushPendingCapture(ctx);
    if (deps.state.health.lastCaptureFailure !== undefined) {
      return await cancel("capture_incomplete", deps.state.health.lastCaptureFailure.message);
    }

    const contextOutcome = await deps.instance.sdk.threadView.getLlmRequestContext(deps.state.threadRef);
    if (!contextOutcome.ok) {
      return await cancel("compact_error", contextOutcome.error.reason);
    }
    const servingTokens = servingContextTokens(contextOutcome.value.messages);
    // The floor exists for one case: a human typing /compact on a tiny thread
    // where there is nothing to reclaim. Threshold and overflow compacts are
    // forced by context pressure — flooring them can wedge a session whose
    // model window is small enough that the trigger point sits under the floor
    // (auto-compact would cancel forever, overflow recovery included).
    if (event.reason === "manual" && servingTokens < COMPACT_FLOOR_TOKENS) {
      return await cancel(
        "no_op",
        `thread ${formatTokenThousands(servingTokens)} tokens is below the ${formatTokenThousands(COMPACT_FLOOR_TOKENS)} compact floor — nothing to reclaim`,
      );
    }

    const compactParams = deps.compactParams ?? DEFAULT_COMPACT_PROFILE;
    const previewOutcome = await deps.instance.sdk.threadView.previewCompact(deps.state.threadRef, {
      params: compactParams,
      signal: compactSignal(event),
    });
    if (!previewOutcome.ok) {
      return await cancel("compact_error", previewOutcome.error.reason);
    }

    const outcome = previewOutcome.value;
    if (outcome.kind === "error") {
      return await cancel("compact_error", outcome.reason);
    }

    // An explicit compact command always proceeds — the handler never
    // second-guesses it against the stored snapshot (Lee's ruling, twice:
    // "blocking me from recompacting is dumb"). The only cancels are the
    // floor gate above and real failures below.
    //
    // firstKeptMessageId is nullable after selector eviction of an oversized
    // final turn. Separate two cases:
    // - compact_continuation_marker is now PI-mappable, so a live marker
    //   still produces a real firstKept and uses the live/seed map.
    // - a true empty mappable tail (compactPoint > 0, no mappable message)
    //   is a host splice: Pi gets the band summary and no raw kept tail.
    const preview = outcome.preview;
    let mapping: FirstKeptMapping;
    if (isSummaryOnlyTail(preview)) {
      mapping = summaryOnlyFirstKeptMapping();
    } else {
      if (preview.firstKeptMessageId === null) {
        return await cancel("mapping_failed", "compact arrangement kept no messages (unexpected — report this)");
      }

      const sessionView = await deps.getSessionView();
      if (!sessionView.ok) {
        return await cancel("compact_error", sessionView.error.reason);
      }

      const mapped = mapFirstKeptToEntryId(
        preview.firstKeptMessageId,
        sessionView.value,
        deps.findSeedEntryMap(event.branchEntries, sessionView.value.threadId),
        event.branchEntries,
        deps.piSessionId ?? "",
      );
      if ("mappingFailed" in mapped) {
        return await cancel("mapping_failed", mapped.reason);
      }
      mapping = mapped;
    }

    const compactOutcome = await deps.instance.sdk.threadView.compact(deps.state.threadRef, {
      params: compactParams,
      signal: compactSignal(event),
    });
    if (!compactOutcome.ok) {
      return await cancel("compact_error", compactOutcome.error.reason);
    }

    const receipt = compactOutcome.value;
    if (!Array.isArray(receipt.renderedBands)) {
      return await cancel("invalid_compact_result", "compact receipt missing renderedBands");
    }

    const compaction = assembleCompactionResult(receipt, mapping.firstKeptEntryId, event.preparation.tokensBefore);

    return { compaction };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return await cancel("compact_error", message);
  }
}
