import { describe, expect, test } from "vitest";
import { estimateTokens } from "../src/shared/token_counting/index.js";
import { truncateForFallback } from "../src/shared/tool_result_rendering.js";
import { toolResultTargetTokens } from "../src/shared/tool_result_summary.js";
import { serviceFixture, validEvent } from "./fixtures/index.js";

async function deriveToolResult(
  fixture: ReturnType<typeof serviceFixture>,
  input: {
    content: string;
    isError?: boolean;
    toolName?: string;
    toolInput?: Record<string, unknown>;
  },
) {
  const { filePath } = await fixture.createThread();
  const accepted = await fixture.sdk.intakeStream.messageEvents({ filePath }, [
    validEvent("tool_call", {
      payload: {
        toolCallId: "call-summary",
        toolName: input.toolName ?? "read",
        arguments: input.toolInput ?? { path: "src/file.ts" },
      },
    }),
    validEvent("tool_result", {
      payload: {
        toolCallId: "call-summary",
        content: input.content,
        ...(input.isError === undefined ? {} : { isError: input.isError }),
      },
    }),
  ]);
  expect(accepted.ok).toBe(true);
  if (!accepted.ok) throw new Error(accepted.error.reason);
  const messageId = accepted.value.events[1]?.messageId;
  if (messageId === undefined) throw new Error("tool result did not materialize a message");
  const drained = await fixture.sdk.work.drain({ filePath });
  expect(drained.ok).toBe(true);
  if (!drained.ok) throw new Error(drained.error.reason);
  const shown = await fixture.sdk.messages.show({ filePath }, messageId);
  expect(shown.ok).toBe(true);
  if (!shown.ok) throw new Error(shown.error.reason);
  const summary = shown.value.derivations.find((row) => row.derivationType === "tool_result_summary");
  if (summary === undefined) throw new Error("tool result summary was not written");
  return { filePath, messageId, summary, drain: drained.value };
}

describe("tool_result_summary tiering and inference", () => {
  test("failed tool results use deterministic truncation without attempting inference", async () => {
    const content = "failed tool output ".repeat(100);
    const fixture = serviceFixture({
      toolResult: { smallTierTokens: 1, smallTargetRatio: 0.15, midTargetRatio: 0.04 },
      models: { tool_result_summary: "throw:failed results must not call the model" },
    });
    const { summary } = await deriveToolResult(fixture, { content, isError: true });

    expect(summary.state).toBe("ready");
    expect(summary.content).toBe(truncateForFallback(content));
    expect(summary.metadata).toEqual({ outcome: "failed" });
    expect(summary.metadata?.inferenceAttempted).toBeUndefined();
  });

  test("a result exactly at smallTierTokens passes through verbatim", async () => {
    const content = "exact boundary token ".repeat(100);
    const tokens = estimateTokens(content);
    expect(content.length).toBeGreaterThan(500);
    const fixture = serviceFixture({
      toolResult: { smallTierTokens: tokens, smallTargetRatio: 0.15, midTargetRatio: 0.04 },
      models: { tool_result_summary: "throw:the <= boundary must not call the model" },
    });
    const { summary } = await deriveToolResult(fixture, { content });

    expect(summary.state).toBe("ready");
    expect(summary.content).toBe(content);
    expect(summary.metadata).toEqual({ outcome: "succeeded" });
  });

  test("a large result is classified, routed through tool_result_summary, and stamps success metadata", async () => {
    const content = "src/a.ts:1:first match\nsrc/b.ts:2:second match\n".repeat(80);
    const tokens = estimateTokens(content);
    const targetTokens = Math.max(1, Math.ceil(tokens * 0.04));
    const fixture = serviceFixture({
      toolResult: { smallTierTokens: 1, smallTargetRatio: 0.15, midTargetRatio: 0.04 },
      models: { tool_result_summary: "success:summarized tool output" },
    });
    const { filePath, messageId, summary } = await deriveToolResult(fixture, {
      content,
      toolName: "bash",
      toolInput: { command: "rg TODO src" },
    });

    expect(summary.state).toBe("ready");
    expect(summary.content).toBe("summarized tool output");
    expect(summary.metadata).toMatchObject({
      outcome: "succeeded",
      inferenceAttempted: true,
      inferenceSucceeded: true,
      provenance: { provider: "test", model: "success:summarized tool output", prompt: "tool-result-v2" },
    });

    const logs = await fixture.sdk.logging.queryDerivationLog(
      { filePath },
      { subjectId: messageId, derivationType: "tool_result_summary", eventKind: "inference_succeeded" },
    );
    expect(logs.ok).toBe(true);
    if (!logs.ok) return;
    expect(logs.value).toHaveLength(1);
    const payload = logs.value[0]?.["payload"] as Record<string, unknown>;
    const requestMessages = payload["requestMessages"] as Array<{ role: string; content: string }>;
    expect(
      requestMessages.some((message) => message.content.includes(`Target length: about ${targetTokens} tokens.`)),
    ).toBe(true);
    expect(requestMessages.some((message) => message.content.includes("Prompt mode: search_summary"))).toBe(true);
    expect(requestMessages.some((message) => message.content.includes('"command": "rg TODO src"'))).toBe(true);
  });

  test("inference failure lands the deterministic floor once with failure metadata", async () => {
    const content = "large successful output ".repeat(100);
    const fixture = serviceFixture({
      toolResult: { smallTierTokens: 1, smallTargetRatio: 0.15, midTargetRatio: 0.04 },
      models: { tool_result_summary: "script:network:tool-result-one-shot" },
    });
    const { summary, drain } = await deriveToolResult(fixture, { content });

    expect(summary.state).toBe("ready");
    expect(summary.content).toBe(truncateForFallback(content));
    expect(summary.metadata).toMatchObject({
      outcome: "succeeded",
      inferenceAttempted: true,
      inferenceSucceeded: false,
      fallbackUsed: true,
      fallbackFloor: "deterministic_truncation",
      lastError: "provider_failure: network: scripted network failure",
    });
    expect(drain.claimed).toBe(1);
    expect(drain.completed).toBe(1);
    expect(drain.failed).toBe(0);
    expect(drain.remaining).toBe(0);
  });

  test("target token math uses the small ratio at the exact boundary and the mid ratio above it", () => {
    const config = { smallTierTokens: 1_000, smallTargetRatio: 0.15, midTargetRatio: 0.04 };
    expect(toolResultTargetTokens(1_000, config)).toBe(150);
    expect(toolResultTargetTokens(1_001, config)).toBe(41);
    expect(toolResultTargetTokens(1, { ...config, smallTargetRatio: 0.01 })).toBe(1);
  });
});
