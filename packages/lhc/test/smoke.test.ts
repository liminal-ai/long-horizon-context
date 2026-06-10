import { describe, expect, it } from "vitest";
import { estimateTokens, runCli, TOKEN_ESTIMATOR_ID } from "../src/index.js";

// Story 1 made the threads commands real (test/threads.test.ts), Story 2 the
// intake-stream commands (test/intake.test.ts), Story 3 messages list
// (test/projection.test.ts), Story 4 turns list (test/turns.test.ts), and
// Story 5 both list-queued-work commands (test/work-queue.test.ts); no
// stubbed commands remain, so the Story 0 fail-closed-stub rail test retired
// with its last entry.

describe("FC-0.3: CLI rail", () => {
  it("responds to --help with usage for every planned command", async () => {
    const result = await runCli(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage:");
    for (const command of [
      "threads new-thread",
      "threads resolve",
      "threads list",
      "intake-stream message-events",
      "intake-stream list-events",
      "messages list",
      "messages list-queued-work",
      "turns list",
      "turns list-queued-work",
    ]) {
      expect(result.stdout).toContain(command);
    }
  });

  it("unknown commands exit non-zero with a structured error", async () => {
    const result = await runCli(["frobnicate", "everything"]);
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      error: { errorClass: string; code: string; reason: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.errorClass).toBe("caller_error");
    expect(parsed.error.code).toBe("unknown_command");
    expect(parsed.error.reason).toContain("frobnicate");
  });

  it("no command at all exits non-zero with a structured error", async () => {
    const result = await runCli([]);
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout) as { ok: boolean };
    expect(parsed.ok).toBe(false);
  });
});

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
