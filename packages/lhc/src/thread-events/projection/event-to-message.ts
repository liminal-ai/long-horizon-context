import type { JsonObject, JsonValue, PersistedThreadEvent } from "../schema.js";
import type { MessageBlockKind, MessageKind } from "../types.js";

export interface MessageProjectionDraft {
  messageKind: MessageKind;
  blockKind: MessageBlockKind;
  payload: JsonObject;
}

export function projectEventToMessageDraft(event: PersistedThreadEvent): MessageProjectionDraft | undefined {
  switch (event.eventKind) {
    case "thread_created":
    case "turn_end":
      return undefined;
    case "user_prompt":
      return { messageKind: "user", blockKind: "text", payload: stripTag(event.payload) };
    case "assistant_text":
      return { messageKind: "assistant", blockKind: "text", payload: stripTag(event.payload) };
    case "assistant_thinking":
      return { messageKind: "assistant", blockKind: "thinking", payload: stripTag(event.payload) };
    case "tool_call":
      return { messageKind: "assistant", blockKind: "tool_call", payload: stripTag(event.payload) };
    case "tool_result":
      return { messageKind: "tool_result", blockKind: "tool_result", payload: stripTag(event.payload) };
    case "runtime_note": {
      const payload = event.payload as JsonObject;
      if (payload.systemKind === "lifecycle") {
        return undefined;
      }
      return { messageKind: "system", blockKind: "text", payload: stripTag(payload) };
    }
  }
}

function stripTag(payload: object): JsonObject {
  const result: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "_tag" || value === undefined) {
      continue;
    }
    result[key] = value as JsonValue;
  }
  return result;
}
