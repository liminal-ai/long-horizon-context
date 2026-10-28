import type { ModelCallInput } from "../inference-types.js";
import { chunkBriefV1 } from "./chunk-brief-v1.js";
import { chunkBriefV2 } from "./chunk-brief-v2.js";
import { chunkBriefV3 } from "./chunk-brief-v3.js";
import { detailedTurnCompressionV1 } from "./detailed-turn-compression-v1.js";
import { detailedTurnCompressionV2 } from "./detailed-turn-compression-v2.js";
import { detailedTurnCompressionV3 } from "./detailed-turn-compression-v3.js";
import { smoothingV1 } from "./smoothing-v1.js";
import { toolResultV1 } from "./tool-result-v1.js";
import { toolResultV2 } from "./tool-result-v2.js";

export interface PromptTemplate<I = unknown> {
  name: string;
  render(input: I): ModelCallInput["messages"];
}

export const PROMPT_REGISTRY: Record<string, PromptTemplate<never>> = {
  [smoothingV1.name]: smoothingV1,
  [toolResultV1.name]: toolResultV1,
  [toolResultV2.name]: toolResultV2,
  [detailedTurnCompressionV1.name]: detailedTurnCompressionV1,
  [detailedTurnCompressionV2.name]: detailedTurnCompressionV2,
  [detailedTurnCompressionV3.name]: detailedTurnCompressionV3,
  [chunkBriefV1.name]: chunkBriefV1,
  [chunkBriefV2.name]: chunkBriefV2,
  [chunkBriefV3.name]: chunkBriefV3,
};

export const PROMPT_NAMES: readonly string[] = Object.keys(PROMPT_REGISTRY);

export const DEFAULT_PROMPT_NAMES: Record<string, string> = {
  smoothed_prompt: smoothingV1.name,
  tool_result_summary: toolResultV2.name,
  detailed_turn_compression: detailedTurnCompressionV3.name,
  chunk_summary_brief: chunkBriefV3.name,
};
