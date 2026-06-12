// View-contents report composition (Flow 2, DD-4): describe + pull are the
// only sources. The stored arrangement, gaps, config, per-band stored token
// counts, and source-state provenance come from `threadView.describe`; the
// serving cost comes from MEASURING `threadView.pull`'s output with the
// shared estimator — parity with what agents receive is by construction
// (AC-2.3), and AC-2.2's boundary-aware tail shortening is inherited from
// pull, never re-implemented. Nothing here recomputes selection, rendering,
// form choice, or boundary state.
import { storageFailure, type OpResult } from "../../../shared/errors.js";
import type { ViewContentsReport } from "../../../shared/inspect.js";
import type { Band, ViewMessage } from "../../../shared/view.js";
import { estimateTokens } from "../../../tech-utils/token-counting/index.js";
import * as threadView from "../../thread-view/index.js";
import type { ThreadRef } from "../../threads/index.js";

const BAND_ORDER: readonly Band[] = ["brief", "detailed", "smooth"];

function measuredTokens(messages: readonly ViewMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message.content), 0);
}

export async function composeViewReport(
  ref: ThreadRef,
): Promise<OpResult<ViewContentsReport>> {
  const described = await threadView.describe(ref);
  if (!described.ok) return described;
  const pulled = await threadView.pull(ref);
  if (!pulled.ok) return pulled;
  const stored = described.value;

  const bandMessages = pulled.value.messages.filter((message) => message.band !== undefined);
  const tailMessages = pulled.value.messages.filter((message) => message.band === undefined);

  // Cross-check count only (Flow 2): the arrangement is describe's; pull just
  // has to be serving the same snapshot's bands. A mismatch means the two
  // reads saw different stored state (a compact landed between them) —
  // report it, never paper over it. Existing code, no additions (tech
  // design §Interface Definitions).
  const storedBandCount = stored?.bands.length ?? 0;
  if (bandMessages.length !== storedBandCount) {
    return storageFailure(
      `view report cross-check failed: describe saw ${storedBandCount} stored band(s) but pull served ${bandMessages.length} band message(s); the view changed between reads`,
    );
  }

  // Band sections: stored arrangement entries grouped in served order
  // (brief → detailed → smooth), gap entries included — they are arrangement
  // rows; their reasons live in `gaps`. storedTokens is the band row's count
  // verbatim (AC-2.1: from the stored snapshot, not recomputed).
  const bands: ViewContentsReport["bands"] =
    stored === null
      ? []
      : BAND_ORDER.flatMap((band) => {
          const entries = stored.arrangement
            .filter((entry) => entry.band === band)
            .map((entry) => ({
              subjectKind: entry.subjectKind,
              subjectId: entry.subjectId,
              formUsed: entry.formUsed,
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
