// The name-keyed prompt registry (DD-8): one module per template exporting
// `{ name, render(input) → messages }`; config selects by name and dial-in
// swaps by adding a module and editing config — no handler, adapter, or host
// changes. Versioning is in the name (`smoothing-v1`).
import type { FormKind } from "../../shared/derivation.js";
import type { ModelCallInput } from "../types.js";
import { chunkBriefV1 } from "./chunk-brief-v1.js";
import { chunkDetailedV1 } from "./chunk-detailed-v1.js";
import { lowerBandV1 } from "./lower-band-v1.js";
import { smoothingV1 } from "./smoothing-v1.js";
import { toolCallV1 } from "./tool-call-v1.js";
import { toolResultV1 } from "./tool-result-v1.js";
import { turnComposeV1 } from "./turn-compose-v1.js";

export interface PromptTemplate<I = unknown> {
  name: string;
  render(input: I): ModelCallInput["messages"];
}

// Every config-selectable name. `never` pins the registry read-only at the
// type level — rendering goes through the adapter, which owns the only
// kind→input pairing.
export const PROMPT_REGISTRY: Record<string, PromptTemplate<never>> = {
  [smoothingV1.name]: smoothingV1,
  [toolCallV1.name]: toolCallV1,
  [toolResultV1.name]: toolResultV1,
  [turnComposeV1.name]: turnComposeV1,
  [lowerBandV1.name]: lowerBandV1,
  [chunkDetailedV1.name]: chunkDetailedV1,
  [chunkBriefV1.name]: chunkBriefV1,
};

// Every config-selectable prompt name — the catalog an operator's assignment
// config picks from. Exposed through the SDK surface (sdk.ts) so valid names
// are discoverable without reading source.
export const PROMPT_NAMES: readonly string[] = Object.keys(PROMPT_REGISTRY);

// The default template per kind — the seven names an operator's first config
// reaches for, and what test fixtures assign.
export const DEFAULT_PROMPT_NAMES: Record<FormKind, string> = {
  smoothed_prompt: smoothingV1.name,
  tool_call_summary: toolCallV1.name,
  tool_result_summary: toolResultV1.name,
  turn_rendering: turnComposeV1.name,
  lower_band_projection: lowerBandV1.name,
  chunk_summary_detailed: chunkDetailedV1.name,
  chunk_summary_brief: chunkBriefV1.name,
};
