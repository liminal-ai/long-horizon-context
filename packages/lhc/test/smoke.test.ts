import { describe, expect, it } from "vitest";
import { estimateTokens, runCli, TOKEN_ESTIMATOR_ID } from "../src/index.js";

const PLANNED_COMMANDS: ReadonlyArray<{ argv: string[]; op: string }> = [
  { argv: ["threads", "new-thread", "--file-path", "/tmp/x.sqlite"], op: "threads.new-thread" },
  { argv: ["threads", "resolve", "--thread-id", "th_x"], op: "threads.resolve" },
  { argv: ["threads", "list"], op: "threads.list" },
  { argv: ["intake-stream", "message-events", "--thread-id", "th_x"], op: "intake-stream.message-events" },
  { argv: ["intake-stream", "list-events", "--file-path", "/tmp/x.sqlite"], op: "intake-stream.list-events" },
  { argv: ["messages", "list", "--thread-id", "th_x"], op: "messages.list" },
  { argv: ["messages", "list-queued-work", "--thread-id", "th_x"], op: "messages.list-queued-work" },
  { argv: ["turns", "list", "--thread-id", "th_x"], op: "turns.list" },
  { argv: ["turns", "list-queued-work", "--thread-id", "th_x"], op: "turns.list-queued-work" },
];

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

  it("every planned command routes to a fail-closed stub with the exact stub error shape", async () => {
    for (const { argv, op } of PLANNED_COMMANDS) {
      const result = await runCli(argv);
      expect(result.exitCode, `exit code for: ${argv.join(" ")}`).toBe(1);
      const parsed = JSON.parse(result.stdout) as unknown;
      expect(parsed, `stub shape for: ${argv.join(" ")}`).toEqual({
        ok: false,
        error: {
          errorClass: "system_error",
          code: "storage_failure",
          reason: `not implemented: ${op}`,
        },
      });
    }
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
