import type { MessageEventInput } from "lhc";
import type { MapCtx } from "./map-message.js";
import { NotImplementedError } from "../shared/not-implemented.js";

// AC-2.8: model_select / thinking_level_select hooks → runtime_note events, in
// order relative to surrounding messages.

/** One `runtime_note` recording the new + previous model. Story 2. */
export function mapModelSelect(
  ev: { model: { provider: string; id: string }; previousModel?: { provider: string; id: string } },
  ctx: MapCtx,
): MessageEventInput {
  throw new NotImplementedError("capture.mapModelSelect");
}

/** One `runtime_note` recording the new + previous thinking level. Story 2. */
export function mapThinkingLevelSelect(
  ev: { level: string; previousLevel: string },
  ctx: MapCtx,
): MessageEventInput {
  throw new NotImplementedError("capture.mapThinkingLevelSelect");
}
