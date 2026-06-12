import { describe, expect, it } from "vitest";
import { estimateTokens, TOKEN_ESTIMATOR_ID } from "../src/index.js";

// The FC-0.3 CLI-rail tests retired with the CLI surface (Epic 05 Story 1):
// the package is SDK-only and test/retirement.test.ts owns the proof.

describe("FC-0.5: token counting", () => {
  it("pins the estimator identity", () => {
    expect(TOKEN_ESTIMATOR_ID).toBe("js-tiktoken:o200k_base");
  });

  it("returns golden counts for known strings", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("hello world")).toBe(2);
  });

  it("same input, same count, every run", () => {
    const inputs = [
      "hello world",
      "The quick brown fox jumps over the lazy dog.",
      "tokens: émojis 🎉 and 中文 text",
      JSON.stringify({ toolCallId: "call-1", arguments: { path: "notes.txt" } }),
    ];
    for (const input of inputs) {
      const first = estimateTokens(input);
      expect(first).toBeGreaterThan(0);
      expect(estimateTokens(input)).toBe(first);
      expect(estimateTokens(input)).toBe(first);
    }
  });
});
