import { describe, expect, test } from "vitest";
import { serviceFixture, validEvent } from "./fixtures/index.js";

describe("per-kind inference routing", () => {
  test("one drain routes all four inference kinds through their assigned model lanes", async () => {
    const fixture = serviceFixture({
      guards: { detailedTurnCompression: { tinyTurnTokens: 1 } },
      toolResult: { smallTierTokens: 1, smallTargetRatio: 0.15, midTargetRatio: 0.04 },
      chunkPolicy: { targetProjectedTokens: 1, maxProjectedTokens: 1 },
    });
    const { filePath } = await fixture.createThread();
    const accepted = await fixture.sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: "route this prompt" } }),
      validEvent("tool_call", {
        payload: { toolCallId: "route-call", toolName: "read", arguments: { path: "large.txt" } },
      }),
      validEvent("tool_result", {
        payload: { toolCallId: "route-call", content: "large routed tool output ".repeat(120), isError: false },
      }),
      validEvent("assistant_text", { payload: { text: "routing complete" } }),
      validEvent("turn_end"),
    ]);
    expect(accepted.ok).toBe(true);

    const drained = await fixture.sdk.work.drain({ filePath });
    expect(drained.ok).toBe(true);
    if (!drained.ok) return;
    expect(drained.value.remaining).toBe(0);

    const messages = await fixture.sdk.messages.report({ filePath });
    const turns = await fixture.sdk.turns.report({ filePath });
    const chunks = await fixture.sdk.turns.report({ filePath }, { chunkId: "c1" });
    expect(messages.ok).toBe(true);
    expect(turns.ok).toBe(true);
    expect(chunks.ok).toBe(true);
    if (!messages.ok || !turns.ok || !chunks.ok) return;

    const expected = {
      smoothed_prompt: "canned smoothed_prompt text from the fake host",
      tool_result_summary: "canned tool_result_summary text from the fake host",
      detailed_turn_compression: "canned detailed_turn_compression text from the fake host",
      chunk_summary_brief: "canned chunk_summary_brief text from the fake host",
    } as const;
    const rows = [...messages.value, ...turns.value, ...chunks.value];
    for (const [kind, content] of Object.entries(expected)) {
      const derivation = rows.find((row) => row.derivationType === kind);
      expect(derivation).toMatchObject({
        state: "ready",
        content,
        metadata: {
          inferenceAttempted: true,
          inferenceSucceeded: true,
          provenance: { provider: "test", model: `model-${kind}` },
        },
      });
    }
  });
});
