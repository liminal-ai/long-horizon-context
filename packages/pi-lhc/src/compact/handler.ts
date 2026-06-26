import type { OpResult, SessionThreadView } from "lhc";
import type { SessionState } from "../lifecycle/state.js";
import type {
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
  SessionEntry,
} from "../pi/types.js";
import type { LhcInstance } from "../shared/instance.js";
import { DEFAULT_COMPACT_PROFILE } from "./profile.js";
import { assembleCompactionResult, mapFirstKeptToEntryId } from "./result-mapping.js";
import type { LhcSeedEntryMap } from "./seed-entry-map.js";

export type CompactCancelCode =
  | "open_turn"
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
  findSeedEntryMap: (entries: readonly SessionEntry[]) => LhcSeedEntryMap | null;
  recordCancel?: (diagnostic: CompactDiagnostic) => void | Promise<void>;
}

function compactSignal(event: SessionBeforeCompactEvent): { aborted: boolean } {
  return {
    get aborted() {
      return event.signal.aborted;
    },
  };
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

    const previewOutcome = await deps.instance.sdk.threadView.previewCompact(deps.state.threadRef, {
      params: DEFAULT_COMPACT_PROFILE,
      signal: compactSignal(event),
    });
    if (!previewOutcome.ok) {
      return await cancel("compact_error", previewOutcome.error.reason);
    }

    const outcome = previewOutcome.value;
    if (outcome.kind === "turn_not_ready") {
      if (deps.state.health.lastCaptureFailure !== undefined) {
        return await cancel("capture_incomplete", deps.state.health.lastCaptureFailure.message);
      }
      return await cancel("open_turn", "open turn has members");
    }
    if (outcome.kind === "error") {
      return await cancel("compact_error", outcome.reason);
    }

    const preview = outcome.preview;
    if (!preview.wouldProduceBands) {
      return await cancel("no_op", "closed history fits full-tail budget");
    }
    if (preview.firstKeptMessageId === null) {
      return await cancel("mapping_failed", "no PI-mappable first kept message");
    }

    const sessionView = await deps.getSessionView();
    if (!sessionView.ok) {
      return await cancel("compact_error", sessionView.error.reason);
    }

    const mapping = mapFirstKeptToEntryId(
      preview.firstKeptMessageId,
      sessionView.value,
      deps.findSeedEntryMap(ctx.sessionManager.getEntries()),
      event.branchEntries,
      deps.piSessionId ?? "",
    );
    if ("mappingFailed" in mapping) {
      return await cancel("mapping_failed", mapping.reason);
    }

    const compactOutcome = await deps.instance.sdk.threadView.compact(deps.state.threadRef, {
      params: DEFAULT_COMPACT_PROFILE,
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
