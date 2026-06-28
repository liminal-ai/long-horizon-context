import { describe, expect, it } from "vitest";
import { createDeterministicInferenceCallbacks, type InferenceCallbacks, initLhc } from "../src/index.js";
import { deriveToolResultSummary } from "../src/messages/internal/handlers.js";
import type { HandlerRunContext } from "../src/shared-tech/derivation.js";

function makeRun(inferenceCallbacks: InferenceCallbacks): HandlerRunContext {
  const sdk = initLhc({
    inferenceCallbacks,
    mode: "manual",
    retry: { budget: 3, backoffBaseMs: 0, backoffCapMs: 0 },
  });
  return {
    threadId: "th_test",
    filePath: "/tmp/tool-result-summary-test.sqlite",
    openDb: () => {
      throw new Error("deriveToolResultSummary tests do not read the database");
    },
    inferenceCallbacks,
    clock: sdk.config.clock,
    config: sdk.config,
  };
}

const largeContent = "tool-output-token ".repeat(600);

describe("tool_result_summary inference diagnostics", () => {
  it("forced fallback path does not stamp inferenceAttempted", async () => {
    const run = makeRun(createDeterministicInferenceCallbacks());
    const derived = await deriveToolResultSummary(
      run,
      "m4",
      {
        toolName: "read_file",
        content: largeContent,
        outcome: "succeeded",
      },
      { useInference: false },
    );
    expect("write" in derived).toBe(true);
    if (!("write" in derived)) return;
    expect(derived.write.metadata).toEqual({ outcome: "succeeded" });
    expect(derived.write.metadata?.inferenceAttempted).toBeUndefined();
  });

  it("inference path stamps success metadata when inference succeeds", async () => {
    const callbacks: InferenceCallbacks = {
      ...createDeterministicInferenceCallbacks(),
      summarizeToolResult: async () => ({
        ok: true,
        text: "summarized tool output",
        provenance: { provider: "openai", model: "gpt-4o", prompt: "tool-result-v2" },
      }),
    };
    const run = makeRun(callbacks);
    const derived = await deriveToolResultSummary(
      run,
      "m4",
      {
        toolName: "read_file",
        content: largeContent,
        outcome: "failed",
      },
      { useInference: true },
    );
    expect("write" in derived).toBe(true);
    if (!("write" in derived)) return;
    expect(derived.write.metadata).toMatchObject({
      outcome: "failed",
      inferenceAttempted: true,
      inferenceSucceeded: true,
      provenance: { provider: "openai", model: "gpt-4o", prompt: "tool-result-v2" },
    });
  });

  it("inference path returns structured failure without success metadata", async () => {
    const callbacks: InferenceCallbacks = {
      ...createDeterministicInferenceCallbacks(),
      summarizeToolResult: async () => ({
        ok: false,
        retryable: true,
        reason: "provider_failure: rate_limit: too many requests",
      }),
    };
    const run = makeRun(callbacks);
    const derived = await deriveToolResultSummary(
      run,
      "m4",
      {
        toolName: "read_file",
        content: largeContent,
        outcome: "succeeded",
      },
      { useInference: true },
    );
    expect(derived).toEqual({
      ok: false,
      retryable: true,
      reason: "provider_failure: rate_limit: too many requests",
    });
  });
});
