// Event → message + typed blocks (Flow 2, projection half). Verbatim means
// verbatim: payload fields are copied into block content untouched — nothing
// here trims, normalizes, splits, or summarizes (AC-2.5 is the absence of
// such a code path). Token estimates come from the one counting util, called
// directly: it is pure and deterministic, so golden counts beat stubs.
import { estimateTokens } from "../../../tech-utils/token-counting/index.js";
import type { Block, RecordedEvent } from "../index.js";

export interface ProjectedMessage {
  blocks: Block[];
  tokenEstimate: number;
}

// turn_end is recorded in the event order but produces no message (AC-2.3).
export function projectEvent(event: RecordedEvent): ProjectedMessage | null {
  switch (event.eventKind) {
    case "user_prompt":
    case "assistant_text":
    case "assistant_thinking":
    case "runtime_note":
      return {
        blocks: [{ blockType: "text", content: { text: event.payload.text } }],
        tokenEstimate: estimateTokens(event.payload.text),
      };
    case "model_change":
      return {
        blocks: [
          {
            blockType: "model_change",
            content: {
              previousModel: event.payload.previousModel,
              newModel: event.payload.newModel,
            },
          },
        ],
        tokenEstimate: estimateTokens(
          `${event.payload.previousModel} ${event.payload.newModel}`,
        ),
      };
    case "thinking_level_change":
      return {
        blocks: [
          {
            blockType: "thinking_level_change",
            content: {
              previousLevel: event.payload.previousLevel,
              newLevel: event.payload.newLevel,
            },
          },
        ],
        tokenEstimate: estimateTokens(
          `${event.payload.previousLevel} ${event.payload.newLevel}`,
        ),
      };
    case "tool_call":
      return {
        blocks: [
          {
            blockType: "tool_call",
            content: {
              toolCallId: event.payload.toolCallId,
              toolName: event.payload.toolName,
              arguments: event.payload.arguments,
            },
          },
        ],
        // Tool calls count their serialized arguments (design: Flow 2).
        tokenEstimate: estimateTokens(JSON.stringify(event.payload.arguments)),
      };
    case "tool_result":
      return {
        blocks: [
          {
            blockType: "tool_result",
            content: {
              toolCallId: event.payload.toolCallId,
              content: event.payload.content,
              isError: event.payload.isError ?? false,
            },
          },
        ],
        // Tool results count the full content string — the same string the
        // block carries in full.
        tokenEstimate: estimateTokens(event.payload.content),
      };
    case "turn_end":
      return null;
  }
}
