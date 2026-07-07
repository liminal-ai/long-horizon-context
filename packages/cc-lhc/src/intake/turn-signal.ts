// Turn-state signal derived from the rollout tail the wrapper already parses.
// This is a fold over lines the watcher tails anyway — NOT a parallel tracker:
// Claude Code's own record of its activity is the only party that knows
// whether a turn is open, and every line of it flows through intake.
//
// Shapes verified against live 2.1.x rollouts (2026-07-07):
// - assistant lines always carry message.stop_reason: "tool_use" mid-loop,
//   "end_turn" at turn close, "stop_sequence" on synthetic/error lines
//   ("No response requested.", API errors) — all of which end the turn.
// - a user prompt or tool_result line means claude is (about to be) working.
// - interrupts append a user text line "[Request interrupted by user]" /
//   "[Request interrupted by user for tool use]" — the turn is over.
// - runtime notes (task notifications, re-served "[runtime note]" lines) are
//   machine chrome: neutral. The turn they trigger announces itself through
//   the assistant/tool lines that follow.

import type { RolloutLineItem, ToolResultBlock } from "../rollout/types.js";
import { contentBlocks, isAssistantLine, isMetaUserLine, isUserLine, runtimeNoteText } from "./map.js";

const INTERRUPT_MARKER = "[Request interrupted";

export type TurnSignal = "opens" | "closes" | "neutral";

function isInterruptText(text: string): boolean {
  return text.trimStart().startsWith(INTERRUPT_MARKER);
}

function classifyUserLine(item: RolloutLineItem): TurnSignal {
  const message = item.message;
  if (message === undefined) return "neutral";

  const content = message.content;
  if (typeof content === "string") {
    if (isInterruptText(content)) return "closes";
    if (isMetaUserLine(item, content)) return "neutral";
    if (runtimeNoteText(content) !== null) return "neutral";
    return content === "" ? "neutral" : "opens";
  }

  const blocks = contentBlocks(content);
  const text = blocks
    .filter((block) => block.type === "text")
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("");
  if (isInterruptText(text)) return "closes";

  const toolResults = blocks.filter((block): block is ToolResultBlock => block.type === "tool_result");
  if (toolResults.length > 0) {
    const resultText = toolResults.map((block) => (typeof block.content === "string" ? block.content : "")).join("");
    return isInterruptText(resultText) ? "closes" : "opens";
  }

  if (isMetaUserLine(item, text)) return "neutral";
  if (runtimeNoteText(text) !== null) return "neutral";
  if (blocks.some((block) => block.type === "image")) return "opens";
  return text === "" ? "neutral" : "opens";
}

/**
 * CONTENT first, stop_reason as refinement: 2.1.202 stamps stop_reason on
 * every assistant line ("tool_use" mid-loop, "end_turn"/"stop_sequence" at
 * close — verified live), but 2.1.201 writes assistant lines with NO
 * stop_reason at all (see test/fixtures/rollout-samples.jsonl). A
 * stop_reason-only fold sticks OPEN forever on those rollouts and the gate
 * refuses indefinitely.
 */
function classifyAssistantLine(item: RolloutLineItem): TurnSignal {
  const content = item.message?.content;
  const blocks = contentBlocks(content);
  // A tool_use block means claude has more to do, whatever the line says.
  if (blocks.some((block) => block.type === "tool_use")) return "opens";

  const stop = item.message?.stop_reason;
  if (typeof stop === "string") return stop === "tool_use" ? "opens" : "closes";

  // No stop_reason (2.1.201 shape): a text-bearing line without tool calls is
  // the turn's final response. Thinking-only/empty lines stay neutral —
  // closing on them could end the fold mid-turn.
  const hasText =
    (typeof content === "string" && content !== "") ||
    blocks.some((block) => block.type === "text" && typeof block.text === "string" && block.text !== "");
  return hasText ? "closes" : "neutral";
}

/** What one rollout line says about claude's turn state; fold in order. */
export function classifyTurnSignal(item: RolloutLineItem): TurnSignal {
  if (item.isSidechain === true) return "neutral";
  if (isUserLine(item)) return classifyUserLine(item);
  if (isAssistantLine(item)) return classifyAssistantLine(item);
  return "neutral";
}
