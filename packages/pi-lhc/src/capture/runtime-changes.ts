import type { MessageEventInput } from "lhc";
import type { MapCtx } from "./map-message.js";
import { eventKey } from "./idempotency.js";

// AC-2.8: model_select / thinking_level_select hooks → runtime_note events, in
// order relative to surrounding messages. PI fires these only in-stream and no
// durable record holds them otherwise, so they are captured the moment they
// fire. They ride the existing `runtime_note` kind (no new intake kind), with
// text structured enough to recover the change — the new value and the previous
// one — which is what later epics use to attribute a turn to its model.

const HARNESS = "pi";

interface ModelDescriptor {
  provider: string;
  id: string;
}

function describeModel(model: ModelDescriptor): string {
  return `${model.provider}/${model.id}`;
}

/** Note text for a model change — carries the new and previous model. */
export function formatModelChange(ev: {
  model: ModelDescriptor;
  previousModel?: ModelDescriptor;
}): string {
  const to = describeModel(ev.model);
  const from = ev.previousModel !== undefined ? describeModel(ev.previousModel) : "(none)";
  return `model changed: ${from} → ${to}`;
}

/** Note text for a thinking-level change — carries the new and previous level. */
export function formatThinkingLevelChange(ev: { level: string; previousLevel: string }): string {
  return `thinking level changed: ${ev.previousLevel} → ${ev.level}`;
}

function runtimeNote(text: string, ctx: MapCtx): MessageEventInput {
  return {
    eventKind: "runtime_note",
    idempotencyKey: eventKey({
      piSessionId: ctx.piSessionId,
      entryId: ctx.entryId,
      fallbackId: ctx.fallbackId,
      blockIndex: 0,
      kind: "runtime_note",
      role: "system",
      content: text,
    }),
    actor: "system",
    harness: HARNESS,
    payload: { text },
  };
}

/** One `runtime_note` recording the new + previous model. */
export function mapModelSelect(
  ev: { model: ModelDescriptor; previousModel?: ModelDescriptor },
  ctx: MapCtx,
): MessageEventInput {
  return runtimeNote(formatModelChange(ev), ctx);
}

/** One `runtime_note` recording the new + previous thinking level. */
export function mapThinkingLevelSelect(
  ev: { level: string; previousLevel: string },
  ctx: MapCtx,
): MessageEventInput {
  return runtimeNote(formatThinkingLevelChange(ev), ctx);
}
