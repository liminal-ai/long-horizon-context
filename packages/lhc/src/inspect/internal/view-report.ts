// View-contents report composition uses only describe + model context. The
// stored arrangement, gaps, config, per-band token counts, and source-state
// provenance come from `threadView.describe`; serving cost comes from measuring
// `threadView.getLlmRequestContext` messages with the shared estimator. Nothing
// here recomputes selection, rendering, derivation choice, or boundary state.

import type { Band, LlmRequestContextMessage, ViewContentsReport } from "../../shared-tech/index.js";
import { type OpResult, storageFailure } from "../../shared-tech/index.js";
import { estimateTokens } from "../../shared-tech/token-counting/index.js";
import * as threadView from "../../thread-view/index.js";
import type { ThreadRef } from "../../threads/index.js";

const BAND_ORDER: readonly Band[] = ["brief", "detailed", "smooth"];

function messageText(message: LlmRequestContextMessage): string {
  return message.content.map((part) => part.text).join("");
}

function measuredTokens(messages: readonly LlmRequestContextMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(messageText(message)), 0);
}

export async function composeViewReport(ref: ThreadRef): Promise<OpResult<ViewContentsReport>> {
  const described = await threadView.describe(ref);
  if (!described.ok) return described;
  const context = await threadView.getLlmRequestContext(ref);
  if (!context.ok) return context;
  const stored = described.value;
  const storedBandCount = stored?.bands.length ?? 0;

  const bandMessages = context.value.messages.slice(0, storedBandCount);
  const tailMessages = context.value.messages.slice(storedBandCount);

  // Cross-check count only: the arrangement is describe's; model context has
  // to be serving the same snapshot's bands. A mismatch means the two reads saw
  // different stored state, so report it rather than papering over it.
  if (bandMessages.length !== storedBandCount) {
    return storageFailure(
      `view report cross-check failed: describe saw ${storedBandCount} stored band(s) but model context produced ${bandMessages.length} band message(s); the view changed between reads`,
    );
  }

  // Band sections: stored arrangement entries grouped in served order
  // (brief → detailed → smooth), gap entries included. Their reasons live in
  // `gaps`. storedTokens is the band row's count from the stored snapshot, not
  // recomputed here.
  const bands: ViewContentsReport["bands"] =
    stored === null
      ? []
      : BAND_ORDER.flatMap((band) => {
          const entries = stored.arrangement
            .filter((entry) => entry.band === band)
            .map((entry) => ({
              subjectKind: entry.subjectKind,
              subjectId: entry.subjectId,
              derivationUsed: entry.derivationUsed,
              degraded: entry.degraded,
            }));
          const storedBand = stored.bands.find((row) => row.band === band);
          if (entries.length === 0 && storedBand === undefined) return [];
          return [{ band, entries, storedTokens: storedBand?.storedTokens ?? 0 }];
        });

  const bandTokens = measuredTokens(bandMessages);
  const tailTokens = measuredTokens(tailMessages);

  return {
    ok: true,
    value: {
      meta:
        stored === null
          ? null
          : {
              viewId: stored.viewId,
              createdAt: stored.createdAt,
              profile: stored.profileName,
              config: stored.config,
              compactPoint: stored.compactPoint,
              coveredFrom: stored.coveredFrom,
            },
      bands,
      gaps: stored?.gaps ?? [],
      tail: { messageCount: tailMessages.length, tokens: tailTokens },
      loadCost: { bandTokens, tailTokens, total: bandTokens + tailTokens },
      sourceState: stored?.sourceState ?? null,
    },
  };
}
