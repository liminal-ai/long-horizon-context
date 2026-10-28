import type { Band, LlmRequestContextMessage, ViewContentsReport } from "../../shared-tech/index.js";
import { type OpResult, resolveInstanceTokenEstimator, storageFailure } from "../../shared-tech/index.js";
import * as threadView from "../../thread-view/index.js";
import type { ThreadRef } from "../../threads/index.js";

const BAND_ORDER: readonly Band[] = ["brief", "detailed", "smooth"];

function messageText(message: LlmRequestContextMessage): string {
  return message.content.map((part) => part.text).join("");
}

function measuredTokens(messages: readonly LlmRequestContextMessage[]): number {
  const estimator = resolveInstanceTokenEstimator("inspect.view");
  return messages.reduce((sum, message) => sum + estimator.estimate(messageText(message)), 0);
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

  if (bandMessages.length !== storedBandCount) {
    return storageFailure(
      `view report cross-check failed: describe saw ${storedBandCount} stored band(s) but model context produced ${bandMessages.length} band message(s); the view changed between reads`,
    );
  }

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
