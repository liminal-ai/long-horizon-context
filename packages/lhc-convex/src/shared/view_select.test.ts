// @vitest-environment node

import { describe, expect, test } from "vitest";
import { CONTRACT_PIN, VIEW_SELECT_CONFIG, viewSelectFixture } from "./frozen_cases.js";
import golden from "./goldens/frozen/view-select.golden.json" with { type: "json" };
import { selectArrangement as selectConvex } from "./view_select.js";

describe("frozen selection differential", () => {
  test("the Convex pure walk is byte-for-byte equivalent to the pinned frozen implementation", () => {
    // Golden generated from packages/lhc at the contract pin by
    // regen_frozen_goldens.test.ts — never from the live sibling tree.
    expect(golden.pin).toBe(CONTRACT_PIN);
    const convex = selectConvex(viewSelectFixture(), VIEW_SELECT_CONFIG);
    expect(JSON.stringify(convex)).toBe(golden.cases.selectArrangement);
  });

  test("an entry exactly filling the smooth budget is included (<= mutation proof)", () => {
    const selected = selectConvex(viewSelectFixture(), VIEW_SELECT_CONFIG);
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
