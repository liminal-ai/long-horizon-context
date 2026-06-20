import type { EventKind } from "../../intake-stream/index.js";
import type { WorkKind } from "../../shared-tech/work-queue/index.js";

export const MESSAGE_WORK_KINDS: Partial<Record<EventKind, WorkKind>> = {
  user_prompt: "prompt_smoothing",
  tool_result: "tool_result_summary",
};

export const MESSAGE_WORK_DERIVATIONS: Partial<Record<WorkKind, "smoothed_prompt" | "tool_result_summary">> = {
  prompt_smoothing: "smoothed_prompt",
  tool_result_summary: "tool_result_summary",
};
