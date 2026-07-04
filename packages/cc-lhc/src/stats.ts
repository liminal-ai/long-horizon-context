export interface CaptureStats {
  linesSeen: number;
  eventsSent: number;
  skippedSidechain: number;
  skippedUnknown: number;
  skippedMeta: number;
  skippedImage: number;
  skippedReplay: number;
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
    skippedReplay: 0,
    parseFailures: 0,
    derivationsPending: null,
    threadId: null,
  };
}

/** Greppable one-line summary for stderr. */
export function formatCaptureStatsLine(stats: CaptureStats): string {
  const parts = [
    "cc-lhc-capture",
    `lines=${stats.linesSeen}`,
    `events=${stats.eventsSent}`,
    `skipped_sidechain=${stats.skippedSidechain}`,
    `skipped_unknown=${stats.skippedUnknown}`,
    `skipped_meta=${stats.skippedMeta}`,
    `skipped_image=${stats.skippedImage}`,
    `skipped_replay=${stats.skippedReplay}`,
    `parse_fail=${stats.parseFailures}`,
  ];
  if (stats.derivationsPending !== null) {
    parts.push(`derivations_pending=${stats.derivationsPending}`);
  }
  parts.push(`thread=${stats.threadId ?? "none"}`);
  return parts.join(" ");
}
