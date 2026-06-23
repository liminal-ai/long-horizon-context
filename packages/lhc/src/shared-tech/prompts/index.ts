// The name-keyed prompt registry (DD-8): one module per template exporting
// `{ name, render(input) → messages }`; config selects by name and dial-in
// swaps by adding a module and editing config — no handler, adapter, or host
// changes. Versioning is in the name (`smoothing-v1`).
import type { ModelCallInput } from "../inference-types.js";
import { chunkBriefV1 } from "./chunk-brief-v1.js";
import { chunkBriefV2 } from "./chunk-brief-v2.js";
import { lowerBandV1 } from "./lower-band-v1.js";
import { smoothTurnCompressionV1 } from "./smooth-turn-compression-v1.js";
import { smoothingV1 } from "./smoothing-v1.js";
import { toolResultV1 } from "./tool-result-v1.js";
import { toolResultV2 } from "./tool-result-v2.js";

export interface PromptTemplate<I = unknown> {
  name: string;
  render(input: I): ModelCallInput["messages"];
}

// Every config-selectable name. `never` pins the registry read-only at the
// type level — rendering goes through the adapter, which owns the only
// kind→input pairing.
export const PROMPT_REGISTRY: Record<string, PromptTemplate<never>> = {
  [smoothingV1.name]: smoothingV1,
  [toolResultV1.name]: toolResultV1,
  [toolResultV2.name]: toolResultV2,
  [lowerBandV1.name]: lowerBandV1,
  [smoothTurnCompressionV1.name]: smoothTurnCompressionV1,
  [chunkBriefV1.name]: chunkBriefV1,
  [chunkBriefV2.name]: chunkBriefV2,
};

// Every config-selectable prompt name — the catalog an operator's assignment
// config picks from. Exposed through the SDK surface (sdk.ts) so valid names
// are discoverable without reading source.
export const PROMPT_NAMES: readonly string[] = Object.keys(PROMPT_REGISTRY);

// The default template per derivation type — the defaults an operator's first
// config reaches for, and what test fixtures assign.
export const DEFAULT_PROMPT_NAMES: Record<string, string> = {
  smoothed_prompt: smoothingV1.name,
  tool_result_summary: toolResultV2.name,
  smooth_turn_compression: smoothTurnCompressionV1.name,
  chunk_summary_brief: chunkBriefV2.name,
};
