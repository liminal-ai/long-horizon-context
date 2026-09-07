/**
 * Signed-thinking rebuild ladder (Slice 1).
 *
 * Governing design: evidence-first, never invent/mutate a signature.
 *
 * Arms:
 * 1. signed_verbatim — native compact/reload preserves prior signatures
 * 2. unsigned_visible — non-empty thinking without opaque signature certified
 * 3. omit — omit thinking blocks from rebuilt Claude rollouts
 *
 * Every arm retains the original signed block in the LHC canonical record.
 *
 * Selected arm: signed_verbatim (2026-09-07 segmentation repair). The rebuilt
 * tail replays every captured signed block exactly as recorded — including the
 * dominant empty-visible-text + signature shape and redacted blocks — so the
 * model keeps its own recent reasoning across a Smart Compact. Unsigned
 * thinking is still dropped rather than given an invented signature. The
 * earlier omit floor and its evidence remain in
 * packages/cc-lhc/test/fixtures/signature-ladder-evidence.md; omit stays
 * selectable only by an explicit change here, never as a runtime fallback.
 */

export type ThinkingRebuildArm = "signed_verbatim" | "unsigned_visible" | "omit";

/** Current certified arm for rebuilt Claude rollouts. */
export const SELECTED_THINKING_REBUILD_ARM: ThinkingRebuildArm = "signed_verbatim";

export function describeThinkingRebuildArm(arm: ThinkingRebuildArm = SELECTED_THINKING_REBUILD_ARM): string {
  switch (arm) {
    case "signed_verbatim":
      return "signed_verbatim: emit thinking with captured opaque signature";
    case "unsigned_visible":
      return "unsigned_visible: emit non-empty thinking text without signature";
    case "omit":
      return "omit: do not emit thinking blocks in rebuilt Claude rollouts";
  }
}
