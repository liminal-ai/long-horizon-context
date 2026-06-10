// Pure supplemental suite (test plan, Flow 3): the epic's turn rule table,
// golden-cased row by row against the pure transition function. The full
// table is enumerated — every event kind in both states — because a passing
// subset is not coverage of the contract. The corruption row (>1 open turn)
// is deliberately absent: it lives in the pipeline's state-load check, not in
// the function (test/turns.test.ts TC-3.7).
import { describe, expect, it } from "vitest";
import { turns, type EventKind } from "../src/index.js";

const NO_TURN = { openTurnId: null };
const TURN_OPEN = { openTurnId: "t1" };

// (state, kind) → expected effect, one row per rule-table entry.
const GOLDEN: ReadonlyArray<{
  state: turns.TurnState;
  kind: EventKind;
  expected: turns.TurnEffect["kind"];
}> = [
  // user_prompt: opens with no turn, closes-then-opens over an open turn
  { state: NO_TURN, kind: "user_prompt", expected: "open" },
  { state: TURN_OPEN, kind: "user_prompt", expected: "close_then_open" },
  // turn_end: closes an open turn, inert with none (event still recorded)
  { state: NO_TURN, kind: "turn_end", expected: "none" },
  { state: TURN_OPEN, kind: "turn_end", expected: "close" },
  // every other kind: no transition in either state (stamping is membership,
  // not transition)
  { state: NO_TURN, kind: "assistant_text", expected: "none" },
  { state: TURN_OPEN, kind: "assistant_text", expected: "none" },
  { state: NO_TURN, kind: "assistant_thinking", expected: "none" },
  { state: TURN_OPEN, kind: "assistant_thinking", expected: "none" },
  { state: NO_TURN, kind: "runtime_note", expected: "none" },
  { state: TURN_OPEN, kind: "runtime_note", expected: "none" },
  { state: NO_TURN, kind: "tool_call", expected: "none" },
  { state: TURN_OPEN, kind: "tool_call", expected: "none" },
  { state: NO_TURN, kind: "tool_result", expected: "none" },
  { state: TURN_OPEN, kind: "tool_result", expected: "none" },
];

const ALL_KINDS: EventKind[] = [
  "user_prompt",
  "assistant_text",
  "assistant_thinking",
  "runtime_note",
  "tool_call",
  "tool_result",
  "turn_end",
];

describe("golden: turn state machine rule table", () => {
  for (const { state, kind, expected } of GOLDEN) {
    const stateName = state.openTurnId === null ? "no open turn" : "turn open";
    it(`${kind} with ${stateName} → ${expected}`, () => {
      expect(turns.transition(state, kind)).toEqual({ kind: expected });
    });
  }

  it("the golden table enumerates every kind in both states — full contract coverage", () => {
    for (const kind of ALL_KINDS) {
      for (const state of [NO_TURN, TURN_OPEN]) {
        expect(
          GOLDEN.find(
            (row) => row.kind === kind && row.state.openTurnId === state.openTurnId,
          ),
          `missing golden row: ${kind} with openTurnId=${String(state.openTurnId)}`,
        ).toBeDefined();
      }
    }
  });
});
