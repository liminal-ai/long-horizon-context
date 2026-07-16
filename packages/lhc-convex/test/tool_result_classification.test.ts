import { describe, expect, test } from "vitest";
import { classifyToolResult } from "../src/shared/classify_tool_result.js";

describe("tool-result classification", () => {
  test("maps tool names and bash commands to operation classes", () => {
    expect(
      classifyToolResult({ toolName: "read", outcome: "succeeded", rawOutput: "export const value = 1;" })
        .operationClass,
    ).toBe("read");
    expect(
      classifyToolResult({
        toolName: "write",
        outcome: "succeeded",
        rawOutput: "Successfully wrote 1234 bytes to src/file.ts",
      }).operationClass,
    ).toBe("mutation_write");
    expect(
      classifyToolResult({
        toolName: "edit",
        outcome: "succeeded",
        rawOutput: "Successfully replaced 1 block(s) in src/file.ts",
      }).operationClass,
    ).toBe("mutation_edit");
    expect(
      classifyToolResult({
        toolName: "bash",
        toolInput: { command: "rg TODO src" },
        outcome: "succeeded",
        rawOutput: "src/file.ts:12:// TODO",
      }).operationClass,
    ).toBe("search_or_listing");
    expect(
      classifyToolResult({
        toolName: "bash",
        toolInput: { command: "pnpm test" },
        outcome: "failed",
        rawOutput: "Tests 1 failed, 2 passed\nCommand exited with code 1",
      }).operationClass,
    ).toBe("verification");
    expect(
      classifyToolResult({
        toolName: "bash",
        toolInput: { command: "git diff -- src/file.ts" },
        outcome: "succeeded",
        rawOutput: "diff --git a/src/file.ts b/src/file.ts",
      }).operationClass,
    ).toBe("vcs_inspection");
    expect(
      classifyToolResult({
        toolName: "multi_tool_use.parallel",
        outcome: "unknown",
        rawOutput: "read package.json: succeeded, 1750 bytes returned.",
      }).operationClass,
    ).toBe("multi_tool");
  });

  test("extracts deterministic failure facts for command-not-found output", () => {
    const first = classifyToolResult({
      toolName: "bash",
      toolInput: { command: "frobnicate --version" },
      outcome: "failed",
      rawOutput: "zsh: frobnicate: command not found\nCommand exited with code 127",
    });
    const second = classifyToolResult({
      toolName: "bash",
      toolInput: { command: "frobnicate --version" },
      outcome: "failed",
      rawOutput: "zsh: frobnicate: command not found\nCommand exited with code 127",
    });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      operationClass: "command",
      responseShape: "simple_failure",
      promptMode: "failure",
      facts: {
        exitCode: 127,
        failureType: "command_not_found",
        missingCommand: "frobnicate",
        retryGuidance: "install the command or invoke it through the project package runner",
      },
    });
  });

  test("routes receipt and test-shaped responses to prompt modes", () => {
    expect(
      classifyToolResult({
        toolName: "write",
        outcome: "succeeded",
        rawOutput: "Successfully wrote 1234 bytes to path/file.ts",
      }),
    ).toMatchObject({
      responseShape: "structured_receipt",
      promptMode: "receipt",
      facts: { targetPath: "path/file.ts", byteCount: 1234, mutationDetailsAvailable: false },
    });

    expect(
      classifyToolResult({
        toolName: "bash",
        toolInput: { command: "pnpm test" },
        outcome: "failed",
        rawOutput:
          "Tests 1 failed, 2 passed\nx writes output\nAssertionError: expected true\nCommand exited with code 1",
      }),
    ).toMatchObject({
      operationClass: "verification",
      responseShape: "test_result",
      promptMode: "test_summary",
      facts: {
        testSummary: expect.objectContaining({ failed: 1, passed: 2, total: 3, exitCode: 1 }),
      },
    });
  });

  test("handles empty and very large unexpected output without throwing", () => {
    expect(() => classifyToolResult({ toolName: "", outcome: "unknown", rawOutput: "" })).not.toThrow();
    expect(() =>
      classifyToolResult({
        toolName: "bash",
        toolInput: {},
        outcome: "succeeded",
        rawOutput: "log line\n".repeat(50_000),
      }),
    ).not.toThrow();
  });
});
