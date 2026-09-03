// Event to message + typed blocks. Verbatim means payload fields are copied
// into block content untouched: nothing here trims, normalizes, splits, or
// summarizes. Token estimates come from the one counting util, called directly:
// it is pure and deterministic, so golden counts beat stubs.
import { type ApiBlock, blobTokenEstimate, placeholderText } from "../../shared-tech/index.js";
import { estimateTokens } from "../../shared-tech/token-counting/index.js";
import type { Block, BlockType, RecordedEvent } from "../index.js";

// A message that carried content blocks beyond text keeps block 0 as its
// text-shaped form — the text of its text blocks with a short placeholder
// (type, media type, size, title) where each non-text block sits — so every
// reader of block 0 (bands, derivations, retrieval, token pricing) sees that
// the block existed without seeing its bytes. Rows 1..n hold the API blocks
// verbatim (blob payloads already replaced by references at intake), in order,
// so serving can replay the exact content array.
function apiBlockRows(blocks: readonly ApiBlock[] | undefined): Block[] {
  return (blocks ?? []).map((block) => ({ blockType: block.type as BlockType, content: block }));
}

function textShaped(text: string, blocks: readonly ApiBlock[] | undefined): string {
  if (blocks === undefined || blocks.length === 0) return text;
  return blocks
    .map(placeholderText)
    .filter((line) => line !== "")
    .join("\n");
}

function blobTokens(blocks: readonly ApiBlock[] | undefined): number {
  return (blocks ?? []).reduce((sum, block) => sum + blobTokenEstimate(block), 0);
}

export interface ProjectedMessage {
  blocks: Block[];
  tokenEstimate: number;
}

// turn_end is recorded in the event order but produces no message.
export function projectEvent(event: RecordedEvent): ProjectedMessage | null {
  switch (event.eventKind) {
    case "user_prompt": {
      const text = textShaped(event.payload.text, event.payload.blocks);
      return {
        blocks: [{ blockType: "text", content: { text } }, ...apiBlockRows(event.payload.blocks)],
        tokenEstimate: estimateTokens(text) + blobTokens(event.payload.blocks),
      };
    }
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
        blocks: [
          { blockType: "text", content },
          ...apiBlockRows(event.payload.block === undefined ? undefined : [event.payload.block]),
        ],
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
          ...apiBlockRows(event.payload.block === undefined ? undefined : [event.payload.block]),
        ],
        // Tool calls count their serialized arguments.
        tokenEstimate: estimateTokens(JSON.stringify(event.payload.arguments)),
      };
    case "tool_result": {
      const content = textShaped(event.payload.content, event.payload.blocks);
      return {
        blocks: [
          {
            blockType: "tool_result",
            content: {
              toolCallId: event.payload.toolCallId,
              content,
              isError: event.payload.isError ?? false,
            },
          },
          ...apiBlockRows(event.payload.blocks),
        ],
        // Tool results count the full text-shaped content — the same string
        // block 0 carries in full — plus the blob estimate of any nested
        // image or document the text cannot see.
        tokenEstimate: estimateTokens(content) + blobTokens(event.payload.blocks),
      };
    }
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
