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
 * Selected arm: omit (pre-exhibit floor).
 * Evidence: see packages/cc-lhc/test/fixtures/signature-ladder-evidence.md
 * and retained native-shape notes under test/fixtures/native-thinking-census.json.
 */

export type ThinkingRebuildArm = "signed_verbatim" | "unsigned_visible" | "omit";

/** Current certified arm for rebuilt Claude rollouts. */
export const SELECTED_THINKING_REBUILD_ARM: ThinkingRebuildArm = "omit";

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
