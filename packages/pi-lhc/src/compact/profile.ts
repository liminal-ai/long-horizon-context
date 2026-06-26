import type { ViewCompactParams } from "lhc";

/** Explicit compact params pi-lhc passes to previewCompact and compact. */
export const DEFAULT_COMPACT_PROFILE = {
  lowerBound: 120_000,
  percentages: { full: 25, smooth: 35, detailed: 20, brief: 20 },
} as const satisfies ViewCompactParams & {
  lowerBound: number;
  percentages: { full: number; smooth: number; detailed: number; brief: number };
};

const bandSum =
  DEFAULT_COMPACT_PROFILE.percentages.full +
  DEFAULT_COMPACT_PROFILE.percentages.smooth +
  DEFAULT_COMPACT_PROFILE.percentages.detailed +
  DEFAULT_COMPACT_PROFILE.percentages.brief;
if (bandSum !== 100 || DEFAULT_COMPACT_PROFILE.lowerBound <= 0) {
  throw new Error(
    `DEFAULT_COMPACT_PROFILE is invalid: lowerBound=${DEFAULT_COMPACT_PROFILE.lowerBound}, band sum=${bandSum}`,
  );
}
