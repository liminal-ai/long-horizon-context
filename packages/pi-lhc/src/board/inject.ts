// Serve-time board injection for the PI `context` hook. Pure over the message
// array: affected messages are shallow-copied, never mutated — the hook result
// shapes one provider request and nothing else. Two placements:
//  - the prompt block rides the latest real user message (wrapped in
//    <user-prompt> so live instruction stays distinguishable from recall);
//  - entries anchored to a tool call of the current run render inside that
//    tool result, so pulled content arrives on the very next model step.
import type { AgentMessage, ContentPart, ToolResultMessage, UserMessage } from "../pi/types.js";
import { anchoredEntries, type BoardState, renderEntry, renderPromptBlock } from "./index.js";

function withPromptBlock(message: UserMessage, block: string): UserMessage {
  if (typeof message.content === "string") {
    return {
      ...message,
      content: `<user-prompt>\n${message.content}\n</user-prompt>\n\n${block}`,
    };
  }
  const parts: ContentPart[] = [
    { type: "text", text: "<user-prompt>\n" },
    ...message.content,
    { type: "text", text: "\n</user-prompt>\n\n" },
    { type: "text", text: block },
  ];
  return { ...message, content: parts };
}

function withAnchoredBlock(message: ToolResultMessage, rendered: string): ToolResultMessage {
  const parts: ContentPart[] = [...message.content, { type: "text", text: rendered }];
  return { ...message, content: parts };
}

/** Returns a new message array with board content injected, or undefined when
 *  there is nothing to inject (hook then leaves the request untouched). */
export function injectBoard(state: BoardState, messages: readonly AgentMessage[]): AgentMessage[] | undefined {
  if (!state.enabled || state.entries.length === 0) return undefined;

  const promptBlock = renderPromptBlock(state);
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      lastUserIdx = i;
      break;
    }
  }

  let changed = false;
  const next = messages.map((message, idx) => {
    if (message.role === "user" && idx === lastUserIdx && promptBlock !== null) {
      changed = true;
      return withPromptBlock(message, promptBlock);
    }
    if (message.role === "toolResult") {
      const anchored = anchoredEntries(state, message.toolCallId);
      if (anchored.length > 0) {
        changed = true;
        return withAnchoredBlock(message, anchored.map(renderEntry).join("\n\n"));
      }
    }
    return message;
  });

  return changed ? next : undefined;
}
