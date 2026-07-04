import { DEFAULT_PROMPT_NAMES, type ModelAssignment } from "lhc";

export const INFERENCE_ASSIGNMENT_KINDS = [
  "smoothed_prompt",
  "tool_result_summary",
  "detailed_turn_compression",
  "chunk_summary_brief",
] as const;

export type InferenceAssignmentKind = (typeof INFERENCE_ASSIGNMENT_KINDS)[number];

const DEFAULT_SYSTEM_THINKING = "none" as const;

/** cc-lhc inference assignments: lhc default prompts and target ratios, cc-cli provider. */
export function ccAssignments(): Record<InferenceAssignmentKind, ModelAssignment> {
  return {
    smoothed_prompt: {
      provider: "cc-cli",
      // Sonnet across the board (Lee's ruling, 2026-07-04): haiku returned
      // empty output and meta-commentary refusals on smoothing in live use.
      model: "sonnet",
      prompt: DEFAULT_PROMPT_NAMES.smoothed_prompt ?? "smoothing-v1",
      thinking: DEFAULT_SYSTEM_THINKING,
    },
    tool_result_summary: {
      provider: "cc-cli",
      model: "sonnet",
      prompt: DEFAULT_PROMPT_NAMES.tool_result_summary ?? "tool-result-v2",
      thinking: DEFAULT_SYSTEM_THINKING,
    },
    detailed_turn_compression: {
      provider: "cc-cli",
      model: "sonnet",
      // Stated prompt target (v3) is lower than these ratios — see detailed-turn-compression-v3.ts.
      prompt: DEFAULT_PROMPT_NAMES.detailed_turn_compression ?? "detailed-turn-compression-v3",
      // Steering ballparks — same discipline as lhc defaults; adjust freely.
      targetMinRatio: 0.35,
      targetMaxRatio: 0.65,
      targetAimRatio: 0.5,
      thinking: DEFAULT_SYSTEM_THINKING,
    },
    chunk_summary_brief: {
      provider: "cc-cli",
      model: "sonnet",
      // Stated prompt target (v3) is lower than these ratios — see chunk-brief-v3.ts.
      prompt: DEFAULT_PROMPT_NAMES.chunk_summary_brief ?? "chunk-brief-v3",
      targetMinRatio: 0.08,
      targetMaxRatio: 0.2,
      targetAimRatio: 0.12,
      thinking: DEFAULT_SYSTEM_THINKING,
    },
  };
}
