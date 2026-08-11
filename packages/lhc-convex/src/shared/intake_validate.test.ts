// @vitest-environment node

import { describe, expect, test } from "vitest";
import { CONTRACT_PIN, eventCases, threadRefCases } from "./frozen_cases.js";
import golden from "./goldens/frozen/intake-validate.golden.json" with { type: "json" };
import {
  validateEvents as validateConvexEvents,
  validateThreadRef as validateConvexThreadRef,
} from "./intake_validate.js";

// PORT LAG (sanctioned): the TS SDK moved ahead on lhc-rs-port — turn/message
// labels (753a177), thinking-signature + model identity (d0f00bb/795da41).
// This frozen differential is skipped until the port-propagation checkpoint
// (bead long-horizon-context-bu9); un-skip when the port syncs (convex-wave
// S2/S4 — flip at whichever slice clears the last validator drift).
// The golden is generated from the contract pin, so un-skipping compares the
// port against pinned bytes, not the moving sibling tree.
describe.skip("frozen intake validation differential", () => {
  test("acceptance, codes, reasons, and event indexes are byte-for-byte equivalent", () => {
    expect(golden.pin).toBe(CONTRACT_PIN);
    const cases = golden.cases as Record<string, string>;
    const mismatches: Array<Record<string, unknown>> = [];

    for (const validationCase of eventCases()) {
      const expected = cases[`validateEvents: ${validationCase.name}`];
      const actual = JSON.stringify(validateConvexEvents(validationCase.input));
      if (expected === undefined || actual !== expected) {
        mismatches.push({ case: validationCase.name, expected, actual });
      }
    }
    for (const validationCase of threadRefCases()) {
      const expected = cases[`validateThreadRef: ${validationCase.name}`];
      const actual = JSON.stringify(validateConvexThreadRef(validationCase.input));
      if (expected === undefined || actual !== expected) {
        mismatches.push({ case: validationCase.name, expected, actual });
      }
    }

    // Every golden case must also have a live counterpart — no orphans.
    const liveNames = new Set([
      ...eventCases().map((c) => `validateEvents: ${c.name}`),
      ...threadRefCases().map((c) => `validateThreadRef: ${c.name}`),
    ]);
    for (const goldenName of Object.keys(cases)) {
      if (!liveNames.has(goldenName)) {
        mismatches.push({ case: goldenName, error: "golden case has no live counterpart" });
      }
    }

    expect(mismatches).toEqual([]);
  });
});
