// Event to message + typed blocks. Verbatim means payload fields are copied
// into block content untouched: nothing here trims, normalizes, splits, or
// summarizes. Token estimates come from the one counting util, called directly:
// it is pure and deterministic, so golden counts beat stubs.
import { estimateTokens } from "../../shared-tech/token-counting/index.js";
import type { Block, RecordedEvent } from "../index.js";

export interface ProjectedMessage {
  blocks: Block[];
  tokenEstimate: number;
}

// turn_end is recorded in the event order but produces no message.
export function projectEvent(event: RecordedEvent): ProjectedMessage | null {
  switch (event.eventKind) {
    case "user_prompt":
    case "runtime_note":
      return {
        blocks: [{ blockType: "text", content: { text: event.payload.text } }],
        tokenEstimate: estimateTokens(event.payload.text),
      };
    case "assistant_text": {
      const content: Record<string, unknown> = { text: event.payload.text };
      if (event.payload.provider !== undefined) content.provider = event.payload.provider;
      if (event.payload.model !== undefined) content.model = event.payload.model;
      if (event.payload.api !== undefined) content.api = event.payload.api;
      return {
        blocks: [{ blockType: "text", content }],
        tokenEstimate: estimateTokens(event.payload.text),
      };
    }
    case "assistant_thinking": {
      // Verbatim payload copy: text always; signature + model identity when sent.
      const content: Record<string, unknown> = { text: event.payload.text };
      if (event.payload.signature !== undefined) content.signature = event.payload.signature;
      if (event.payload.provider !== undefined) content.provider = event.payload.provider;
      if (event.payload.model !== undefined) content.model = event.payload.model;
      if (event.payload.api !== undefined) content.api = event.payload.api;
      // Count signature bytes too — when served back to the provider they sit in
      // the live context window (the fable live-vs-LHC token gap).
      const estimateSource =
        event.payload.signature !== undefined && event.payload.signature !== ""
          ? `${event.payload.text}${event.payload.signature}`
          : event.payload.text;
      return {
        blocks: [{ blockType: "text", content }],
        tokenEstimate: estimateTokens(estimateSource),
      };
    }
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
        tokenEstimate: estimateTokens(`${event.payload.previousModel} ${event.payload.newModel}`),
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
        tokenEstimate: estimateTokens(`${event.payload.previousLevel} ${event.payload.newLevel}`),
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
        // Tool calls count their serialized arguments.
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
    case "compact_continuation_marker": {
      // Typed marker: model-visible when served; not ordinary user chat.
      // Token estimate covers the stable model-facing instruction text.
      const content = {
        kind: event.payload.kind,
        continuationTurnId: event.payload.continuationTurnId,
        cause: event.payload.cause,
        action: event.payload.action,
        newUserRequest: event.payload.newUserRequest,
        waitForUser: event.payload.waitForUser,
      };
      const modelFacing = [
        "[compact continuation]",
        `cause=${event.payload.cause}`,
        `action=${event.payload.action}`,
        "newUserRequest=false",
        "waitForUser=false",
        `continuationTurnId=${event.payload.continuationTurnId}`,
      ].join(" ");
      return {
        blocks: [{ blockType: "compact_continuation_marker", content }],
        tokenEstimate: estimateTokens(modelFacing),
      };
    }
    case "turn_end":
      return null;
  }
}
