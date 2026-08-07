// @vitest-environment node

import { describe, expect, test } from "vitest";
import {
  type ComposeDerivationRow,
  type ComposeMessage,
  composePreDetailedAssembly,
  composeRenderingInput,
} from "./turn_compose.js";

function fixture(): {
  messages: ComposeMessage[];
  derivations: Map<string, ComposeDerivationRow>;
} {
  return {
    messages: [
      {
        messageId: "m1",
        kind: "user_prompt",
        blocks: [{ blockType: "text", content: { text: "  Please inspect this.  " } }],
      },
      {
        messageId: "m2",
        kind: "tool_call",
        blocks: [
          { blockType: "tool_call", content: { toolCallId: "call-1", toolName: "read", arguments: { path: "a" } } },
        ],
      },
      {
        messageId: "m3",
        kind: "assistant_thinking",
        blocks: [{ blockType: "text", content: { text: "checking" } }],
      },
      {
        messageId: "m4",
        kind: "tool_result",
        blocks: [{ blockType: "tool_result", content: { toolCallId: "call-1", content: "file body", isError: false } }],
      },
      {
        messageId: "m5",
        kind: "runtime_note",
        blocks: [{ blockType: "text", content: { text: "after tool" } }],
      },
      {
        messageId: "m6",
        kind: "assistant_text",
        blocks: [{ blockType: "text", content: { text: "Done." } }],
      },
    ],
    derivations: new Map([
      ["m1/smoothed_prompt", { state: "failed", reason: "provider_failure", sourceVersion: 2 }],
      [
        "m4/tool_result_summary",
        { state: "ready", content: "read succeeded", metadata: { outcome: "succeeded" }, sourceVersion: 1 },
      ],
    ]),
  };
}

// PORT LAG (sanctioned): the TS SDK moved ahead on lhc-rs-port — turn/message
// labels (753a177), thinking-signature + model identity (d0f00bb/795da41).
// This frozen differential is skipped until the port-propagation checkpoint
// (bead long-horizon-context-bu9); un-skip when the port syncs.
describe.skip("frozen turn composition differential", () => {
  test("tool-run grouping, fallbacks, gaps, and dialogue assembly stay byte-for-byte equivalent", async () => {
    const frozenModulePath = new URL("../../../lhc/src/turns/internal/compose.ts", import.meta.url).href;
    const frozen = (await import(frozenModulePath)) as {
      composeRenderingInput: typeof composeRenderingInput;
      composePreDetailedAssembly: typeof composePreDetailedAssembly;
    };
    const { messages, derivations } = fixture();
    expect(composeRenderingInput(messages, derivations)).toEqual(frozen.composeRenderingInput(messages, derivations));
    expect(composePreDetailedAssembly(messages, derivations)).toEqual(
      frozen.composePreDetailedAssembly(messages, derivations),
    );
  });
});
