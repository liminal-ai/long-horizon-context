// @vitest-environment node

import { describe, expect, test } from "vitest";
import { type SelectionInputs, selectArrangement as selectConvex } from "./view_select.js";

function fixture(): SelectionInputs {
  return {
    messages: [
      { messageId: "m1", order: 1, kind: "user_prompt", tokenEstimate: 100, turnId: "t1", text: "one" },
      { messageId: "m2", order: 2, kind: "assistant_text", tokenEstimate: 100, turnId: "t1", text: "one-a" },
      { messageId: "m3", order: 3, kind: "user_prompt", tokenEstimate: 100, turnId: "t2", text: "two" },
      { messageId: "m4", order: 4, kind: "assistant_text", tokenEstimate: 100, turnId: "t2", text: "two-a" },
      { messageId: "m5", order: 5, kind: "user_prompt", tokenEstimate: 1, turnId: "t3", text: "tail" },
    ],
    turns: [
      { turnId: "t1", turnOrder: 1, status: "closed", openedAt: 0, closedAt: 2 },
      { turnId: "t2", turnOrder: 2, status: "closed", openedAt: 2, closedAt: 4 },
      { turnId: "t3", turnOrder: 3, status: "open", openedAt: 4, closedAt: null },
    ],
    chunks: [],
    derivations: new Map([
      ["t1/turn_rendering", { state: "ready" as const, content: "alpha" }],
      ["t2/turn_rendering", { state: "ready" as const, content: "b" }],
    ]),
    maxEventOrder: 5,
    derivationCounts: { turn_rendering: { ready: 2 } },
  };
}

describe("frozen selection differential", () => {
  test("the Convex pure walk is byte-for-byte equivalent to the frozen implementation", async () => {
    // Keep the frozen package outside this package's TypeScript project while
    // still loading the actual implementation at test runtime.
    const frozenModulePath = new URL("../../../lhc/src/thread-view/internal/select.ts", import.meta.url).href;
    const frozen = (await import(frozenModulePath)) as {
      selectArrangement: typeof selectConvex;
    };
    const inputs = fixture();
    const config = {
      lowerBound: 100,
      percentages: { full: 10, smooth: 2, detailed: 44, brief: 44 },
    };
    const convex = selectConvex(inputs, config);
    expect(convex).toEqual(frozen.selectArrangement(inputs, config));
  });

  test("an entry exactly filling the smooth budget is included (<= mutation proof)", () => {
    const selected = selectConvex(fixture(), {
      lowerBound: 100,
      percentages: { full: 10, smooth: 2, detailed: 44, brief: 44 },
    });
    expect(selected.compactPoint).toBe(4);
    expect(selected.entries.filter((entry) => entry.band === "smooth").map((entry) => entry.subjectId)).toEqual([
      "t1",
      "t2",
    ]);
    expect(
      selected.entries.filter((entry) => entry.band === "smooth").reduce((sum, entry) => sum + entry.tokens, 0),
    ).toBe(2);
  });
});
