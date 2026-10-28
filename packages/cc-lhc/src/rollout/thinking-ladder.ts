export type ThinkingRebuildArm = "signed_verbatim" | "unsigned_visible" | "omit";

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
