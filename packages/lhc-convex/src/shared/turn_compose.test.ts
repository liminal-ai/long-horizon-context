// @vitest-environment node

import { describe, expect, test } from "vitest";
import { CONTRACT_PIN, turnComposeFixture } from "./frozen_cases.js";
import golden from "./goldens/frozen/turn-compose.golden.json" with { type: "json" };
import { composePreDetailedAssembly, composeRenderingInput } from "./turn_compose.js";

// PORT LAG (sanctioned): the TS SDK moved ahead on lhc-rs-port — turn/message
// labels (753a177), thinking-signature + model identity (d0f00bb/795da41).
// This frozen differential is skipped until the port-propagation checkpoint
// (bead long-horizon-context-bu9); un-skip when the port syncs (convex-wave S3).
// The golden is generated from the contract pin, so un-skipping compares the
// port against pinned bytes, not the moving sibling tree.
describe.skip("frozen turn composition differential", () => {
  test("tool-run grouping, fallbacks, gaps, and dialogue assembly stay byte-for-byte equivalent", () => {
    expect(golden.pin).toBe(CONTRACT_PIN);
    const { messages, derivations } = turnComposeFixture();
    expect(JSON.stringify(composeRenderingInput(messages, derivations))).toBe(golden.cases.composeRenderingInput);
    expect(JSON.stringify(composePreDetailedAssembly(messages, derivations))).toBe(
      golden.cases.composePreDetailedAssembly,
    );
  });
});
