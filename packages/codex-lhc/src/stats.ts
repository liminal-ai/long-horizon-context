export interface CaptureStats {
  linesSeen: number;
  eventsSent: number;
  skippedSidechain: number;
  skippedUnknown: number;
  skippedMeta: number;
  skippedImage: number;
  /** session_meta lines after the first in a rollout tail (mirrors mapRolloutLines). */
  embeddedSessionMeta: number;
  /** EVENTS dropped by replay dedupe (signature already seen while the replay window was open). */
  skippedReplay: number;
  /**
   * LINES re-tailed as a rebuilt-rollout prefix after an in-app resume. Kept
   * apart from both linesSeen (they are not new activity) and skippedReplay
   * (that counter is event-unit) so each stat stays a single coherent unit.
   */
  replayedPrefixLines: number;
  parseFailures: number;
  derivationsPending: number | null;
  threadId: string | null;
}

export function emptyCaptureStats(): CaptureStats {
  return {
    linesSeen: 0,
    eventsSent: 0,
    skippedSidechain: 0,
    skippedUnknown: 0,
    skippedMeta: 0,
    skippedImage: 0,
    embeddedSessionMeta: 0,
    skippedReplay: 0,
    replayedPrefixLines: 0,
    parseFailures: 0,
    derivationsPending: null,
    threadId: null,
  };
}

/** Greppable one-line summary for stderr. */
export function formatCaptureStatsLine(stats: CaptureStats): string {
  const parts = [
    "codex-lhc-capture",
    `lines=${stats.linesSeen}`,
    `events=${stats.eventsSent}`,
    `skipped_sidechain=${stats.skippedSidechain}`,
    `skipped_unknown=${stats.skippedUnknown}`,
    `skipped_meta=${stats.skippedMeta}`,
    `skipped_image=${stats.skippedImage}`,
    `embedded_session_meta=${stats.embeddedSessionMeta}`,
    `skipped_replay=${stats.skippedReplay}`,
    `replayed_prefix=${stats.replayedPrefixLines}`,
    `parse_fail=${stats.parseFailures}`,
  ];
  if (stats.derivationsPending !== null) {
    parts.push(`derivations_pending=${stats.derivationsPending}`);
  }
  parts.push(`thread=${stats.threadId ?? "none"}`);
  return parts.join(" ");
}
