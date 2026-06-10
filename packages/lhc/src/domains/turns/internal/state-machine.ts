// The turn rule table as a pure function (Flow 3). Every row of the epic's
// table is one golden case against this function: prompt with no open turn →
// open; prompt with open turn → close_then_open; turn_end with open turn →
// close; turn_end with none → none; every other kind → none (stamping is
// membership, not transition). The corruption row (>1 open turn) is handled
// by the pipeline at state load, not here — only the pipeline writes turn
// state, so a violation means external interference and fails the batch
// before any event reaches this function.
import type { EventKind } from "../../intake-stream/index.js";

export interface TurnState {
  openTurnId: string | null;
}

export type TurnEffect =
  | { kind: "none" }
  | { kind: "open" }
  | { kind: "close" }
  | { kind: "close_then_open" };

export function transition(state: TurnState, eventKind: EventKind): TurnEffect {
  switch (eventKind) {
    case "user_prompt":
      return state.openTurnId === null ? { kind: "open" } : { kind: "close_then_open" };
    case "turn_end":
      return state.openTurnId === null ? { kind: "none" } : { kind: "close" };
    case "assistant_text":
    case "assistant_thinking":
    case "runtime_note":
    case "tool_call":
    case "tool_result":
      return { kind: "none" };
  }
}
