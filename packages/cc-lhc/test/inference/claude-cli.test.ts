import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  classifyStderr,
  createClaudeCliModelCall,
  createConcurrencyLimiter,
  killAllInferenceChildren,
  SLOT_TIMEOUT_MESSAGE,
} from "../../src/inference/claude-cli.js";

const FIXTURE_BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "fake-claude.mjs");

function fakeCall(env: Record<string, string>, deps: { timeoutMs?: number; maxConcurrency?: number } = {}) {
  chmodSync(FIXTURE_BIN, 0o755);
  const call = createClaudeCliModelCall({
    binary: () => process.execPath,
    spawnFn: ((...spawnArgs: Parameters<typeof spawn>) =>
      spawn(process.execPath, [FIXTURE_BIN, ...(spawnArgs[1] ?? [])], spawnArgs[2])) as typeof spawn,
    ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
    ...(deps.maxConcurrency === undefined ? {} : { maxConcurrency: deps.maxConcurrency }),
  });
  const prior = { ...process.env };
  Object.assign(process.env, env);
  return {
    call,
    restore() {
      for (const key of Object.keys(env)) {
        if (prior[key] === undefined) delete process.env[key];
        else process.env[key] = prior[key];
      }
    },
  };
}

const baseInput = {
  provider: "cc-cli" as const,
  model: "sonnet",
  messages: [{ role: "user" as const, content: "summarize this" }],
};

afterEach(() => {
  killAllInferenceChildren();
});

describe("createClaudeCliModelCall", () => {
  it("writes user content to stdin and maps success stdout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-cli-"));
    const stdinFile = join(dir, "stdin.json");
    const harness = fakeCall({ CC_LHC_FAKE_MODE: "stdin-file", CC_LHC_FAKE_STDIN_FILE: stdinFile });
    const result = await harness.call({
      ...baseInput,
      messages: [
        { role: "system", content: "System A" },
        { role: "user", content: "User A" },
        { role: "user", content: "User B" },
      ],
    });
    harness.restore();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe("ok");
    const captured = JSON.parse(readFileSync(stdinFile, "utf8")) as {
      stdin: string;
      systemPrompt: string;
      model: string;
    };
    expect(captured.stdin).toBe("User A\n\nUser B");
    expect(captured.systemPrompt).toBe("System A");
    expect(captured.model).toBe("sonnet");
  });

  it("uses default system prompt when none provided", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-cli-"));
    const stdinFile = join(dir, "stdin.json");
    const harness = fakeCall({ CC_LHC_FAKE_MODE: "stdin-file", CC_LHC_FAKE_STDIN_FILE: stdinFile });
    await harness.call(baseInput);
    harness.restore();
    const captured = JSON.parse(readFileSync(stdinFile, "utf8")) as { systemPrompt: string };
    expect(captured.systemPrompt).toBe("You are a text processor. Follow the user instruction exactly.");
  });

  it("classifies auth stderr", async () => {
    const harness = fakeCall({ CC_LHC_FAKE_MODE: "auth" });
    const result = await harness.call(baseInput);
    harness.restore();
    expect(result).toEqual({ ok: false, kind: "auth", message: expect.stringContaining("OAuth") });
  });

  it("classifies rate-limit stderr", async () => {
    const harness = fakeCall({ CC_LHC_FAKE_MODE: "rate_limit" });
    const result = await harness.call(baseInput);
    harness.restore();
    expect(result).toEqual({ ok: false, kind: "rate_limit", message: expect.stringContaining("429") });
  });

  it("classifies generic nonzero exit as other", async () => {
    const harness = fakeCall({ CC_LHC_FAKE_MODE: "generic" });
    const result = await harness.call(baseInput);
    harness.restore();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("other");
  });

  it("kills on timeout and returns timeout failure", async () => {
    const harness = fakeCall({ CC_LHC_FAKE_MODE: "sleep", CC_LHC_FAKE_SLEEP_MS: "5000" }, { timeoutMs: 80 });
    const result = await harness.call(baseInput);
    harness.restore();
    expect(result).toEqual({ ok: false, kind: "timeout", message: expect.stringContaining("timed out") });
  });

  it("limits concurrent child processes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-cli-"));
    const counterFile = join(dir, "counter.json");
    writeFileSync(counterFile, JSON.stringify({ current: 0, peak: 0 }));
    const harness = fakeCall(
      {
        CC_LHC_FAKE_MODE: "concurrency",
        CC_LHC_FAKE_COUNTER_FILE: counterFile,
        CC_LHC_FAKE_SLEEP_MS: "300",
      },
      { maxConcurrency: 2 },
    );
    await Promise.all([harness.call(baseInput), harness.call(baseInput), harness.call(baseInput)]);
    harness.restore();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const counter = JSON.parse(readFileSync(counterFile, "utf8")) as { peak: number };
    // Only the upper bound is ours to guarantee: the limiter must cap
    // concurrency at 2. Whether the box actually ran two children at once is
    // scheduler-dependent and flakes under load (observed twice: peak=1).
    expect(counter.peak).toBeLessThanOrEqual(2);
  }, 10_000);

  it("returns empty stdout for adapter empty_output classification", async () => {
    const harness = fakeCall({ CC_LHC_FAKE_MODE: "empty" });
    const result = await harness.call(baseInput);
    harness.restore();
    expect(result).toEqual({ ok: true, text: "" });
  });

  it("rejects non cc-cli provider", async () => {
    const harness = fakeCall({ CC_LHC_FAKE_MODE: "success" });
    const result = await harness.call({ ...baseInput, provider: "other" });
    harness.restore();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("invalid_request");
  });

  it("returns slot timeout without spawning when semaphore wait exceeds timeoutMs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-cli-slot-"));
    const sentinelPath = join(dir, "spawn.log");
    chmodSync(FIXTURE_BIN, 0o755);
    const spawnFn = ((...spawnArgs: Parameters<typeof spawn>) =>
      spawn(process.execPath, [FIXTURE_BIN, ...(spawnArgs[1] ?? [])], spawnArgs[2])) as typeof spawn;
    const limiter = createConcurrencyLimiter(1);
    const holdCall = createClaudeCliModelCall({
      binary: () => process.execPath,
      spawnFn,
      limiter,
      maxConcurrency: 1,
      timeoutMs: 500,
    });
    const blockedCall = createClaudeCliModelCall({
      binary: () => process.execPath,
      spawnFn,
      limiter,
      maxConcurrency: 1,
      timeoutMs: 50,
    });
    const prior = { ...process.env };
    Object.assign(process.env, {
      CC_LHC_FAKE_MODE: "hold-slot",
      CC_LHC_FAKE_SENTINEL_FILE: sentinelPath,
      CC_LHC_FAKE_SLEEP_MS: "200",
    });

    const hold = holdCall(baseInput);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const blocked = blockedCall({
      ...baseInput,
      messages: [{ role: "user", content: "second" }],
    });
    const [holdResult, blockedResult] = await Promise.all([hold, blocked]);

    for (const key of ["CC_LHC_FAKE_MODE", "CC_LHC_FAKE_SENTINEL_FILE", "CC_LHC_FAKE_SLEEP_MS"]) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }

    expect(blockedResult).toEqual({ ok: false, kind: "timeout", message: SLOT_TIMEOUT_MESSAGE });
    expect(holdResult.ok).toBe(true);
    expect(existsSync(sentinelPath)).toBe(true);
    expect(readFileSync(sentinelPath, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("survives stdin EPIPE when child exits before consuming stdin", async () => {
    const harness = fakeCall({ CC_LHC_FAKE_MODE: "immediate-exit" });
    const largeBody = "x".repeat(256 * 1024);
    const result = await harness.call({
      ...baseInput,
      messages: [{ role: "user", content: largeBody }],
    });
    harness.restore();
    expect(result).toEqual({ ok: false, kind: "auth", message: expect.stringContaining("OAuth") });
  });
});

describe("classifyStderr", () => {
  it("detects auth and rate patterns", () => {
    expect(classifyStderr("please login with OAuth")).toBe("auth");
    expect(classifyStderr("429 overloaded")).toBe("rate_limit");
    expect(classifyStderr("boom")).toBe("other");
  });
});
