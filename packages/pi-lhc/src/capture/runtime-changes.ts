import type { MessageEventInput } from "lhc";
import { eventKey } from "./idempotency.js";
import type { MapCtx } from "./map-message.js";

// model_select / thinking_level_select hooks become typed LHC runtime-change
// events in order relative to surrounding messages. Current PI persists the
// change entry before emitting the hook; index.ts supplies that entry id when
// available so repeated same-value changes remain distinct and redelivery
// dedupes.

const HARNESS = "pi";

interface ModelDescriptor {
  provider: string;
  id: string;
}

function describeModel(model: ModelDescriptor): string {
  return `${model.provider}/${model.id}`;
}

function runtimeKey(kind: "model_change" | "thinking_level_change", ctx: MapCtx, content: string): string {
  return eventKey({
    piSessionId: ctx.piSessionId,
    entryId: ctx.entryId,
    fallbackId: ctx.fallbackId,
    blockIndex: 0,
    kind,
    role: "system",
    content,
  });
}

function modelChange(previousModel: string, newModel: string, ctx: MapCtx): MessageEventInput {
  return {
    eventKind: "model_change",
    idempotencyKey: runtimeKey("model_change", ctx, `${previousModel}->${newModel}`),
    actor: "system",
    harness: HARNESS,
    payload: { previousModel, newModel },
  };
}

function thinkingLevelChange(previousLevel: string, newLevel: string, ctx: MapCtx): MessageEventInput {
  return {
    eventKind: "thinking_level_change",
    idempotencyKey: runtimeKey("thinking_level_change", ctx, `${previousLevel}->${newLevel}`),
    actor: "system",
    harness: HARNESS,
    payload: { previousLevel, newLevel },
  };
}

/** One typed `model_change` recording the new + previous model. */
export function mapModelSelect(
  ev: { model: ModelDescriptor; previousModel?: ModelDescriptor },
  ctx: MapCtx,
): MessageEventInput {
  const newModel = describeModel(ev.model);
  const previousModel = ev.previousModel !== undefined ? describeModel(ev.previousModel) : "(none)";
  return modelChange(previousModel, newModel, ctx);
}

/** One typed `thinking_level_change` recording the new + previous thinking level. */
export function mapThinkingLevelSelect(ev: { level: string; previousLevel: string }, ctx: MapCtx): MessageEventInput {
  return thinkingLevelChange(ev.previousLevel, ev.level, ctx);
}
