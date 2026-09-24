import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  summaryWorkerAuthSettings as userAuthSettings,
  SUMMARY_WORKER_CLI_ARGS as WORKER_ARGS,
  SUMMARY_WORKER_SYSTEM_PROMPT as WORKER_SYSTEM_PROMPT,
} from "lhc";
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
  it("keeps Lee's system prompt; a template's system text goes to stdin ahead of its user text", async () => {
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
    expect(captured.stdin).toBe("System A\n\nUser A\n\nUser B");
    expect(captured.systemPrompt).toBe(WORKER_SYSTEM_PROMPT);
    expect(captured.model).toBe("sonnet");
  });

  it("always passes --no-session-persistence so derivation calls leave no rollout", async () => {
    const seen: string[][] = [];
    const call = createClaudeCliModelCall({
      binary: () => process.execPath,
      spawnFn: ((...spawnArgs: Parameters<typeof spawn>) => {
        seen.push([...(spawnArgs[1] ?? [])]);
        return spawn(process.execPath, [FIXTURE_BIN, ...(spawnArgs[1] ?? [])], spawnArgs[2]);
      }) as typeof spawn,
    });
    const priorMode = process.env.CC_LHC_FAKE_MODE;
    process.env.CC_LHC_FAKE_MODE = "ok";
    try {
      await call(baseInput);
    } finally {
      if (priorMode === undefined) delete process.env.CC_LHC_FAKE_MODE;
      else process.env.CC_LHC_FAKE_MODE = priorMode;
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("--no-session-persistence");
    expect(seen[0]![0]).toBe("-p");
  });

  it("resolves an explicit relative claude binary from our cwd, since the child runs in a scratch dir", async () => {
    const commands: string[] = [];
    const run = (bin: string) =>
      createClaudeCliModelCall({
        binary: () => bin,
        spawnFn: ((...spawnArgs: Parameters<typeof spawn>) => {
          commands.push(String(spawnArgs[0]));
          return spawn(process.execPath, [FIXTURE_BIN, ...(spawnArgs[1] ?? [])], spawnArgs[2]);
        }) as typeof spawn,
      })(baseInput);
    const priorMode = process.env.CC_LHC_FAKE_MODE;
    process.env.CC_LHC_FAKE_MODE = "ok";
    try {
      await run("./bin/claude");
      await run("claude");
    } finally {
      if (priorMode === undefined) delete process.env.CC_LHC_FAKE_MODE;
      else process.env.CC_LHC_FAKE_MODE = priorMode;
    }
    expect(commands).toEqual([join(process.cwd(), "bin", "claude"), "claude"]);
  });

  it("uses default system prompt when none provided", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-cli-"));
    const stdinFile = join(dir, "stdin.json");
    const harness = fakeCall({ CC_LHC_FAKE_MODE: "stdin-file", CC_LHC_FAKE_STDIN_FILE: stdinFile });
    await harness.call(baseInput);
    harness.restore();
    const captured = JSON.parse(readFileSync(stdinFile, "utf8")) as { systemPrompt: string };
    expect(captured.systemPrompt).toBe(WORKER_SYSTEM_PROMPT);
    expect(Buffer.byteLength(WORKER_SYSTEM_PROMPT)).toBe(504);
    expect(WORKER_SYSTEM_PROMPT.startsWith("Your role is to smooth or summarize conversation excerpts")).toBe(true);
  });

  it("runs with no settings files, tools, MCP or extra turns, in an empty scratch directory removed afterwards", async () => {
    const config = mkdtempSync(join(tmpdir(), "cc-lhc-cli-cfg-"));
    const seen: Array<{ args: string[]; cwd: string; entries: string[]; env: NodeJS.ProcessEnv | undefined }> = [];
    const call = createClaudeCliModelCall({
      binary: () => process.execPath,
      spawnFn: ((...spawnArgs: Parameters<typeof spawn>) => {
        const cwd = String(spawnArgs[2]?.cwd);
        seen.push({ args: [...(spawnArgs[1] ?? [])], cwd, entries: readdirSync(cwd), env: spawnArgs[2]?.env });
        return spawn(process.execPath, [FIXTURE_BIN, ...(spawnArgs[1] ?? [])], spawnArgs[2]);
      }) as typeof spawn,
    });
    const prior = { mode: process.env.CC_LHC_FAKE_MODE, config: process.env.CLAUDE_CONFIG_DIR };
    process.env.CC_LHC_FAKE_MODE = "ok";
    process.env.CLAUDE_CONFIG_DIR = config;
    try {
      await call(baseInput);
    } finally {
      if (prior.mode === undefined) delete process.env.CC_LHC_FAKE_MODE;
      else process.env.CC_LHC_FAKE_MODE = prior.mode;
      if (prior.config === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prior.config;
    }
    expect(WORKER_ARGS).toEqual(["--setting-sources", "", "--tools", "", "--strict-mcp-config", "--max-turns", "1"]);
    expect(seen[0]!.args.slice(0, 2 + WORKER_ARGS.length)).toEqual(["-p", "--no-session-persistence", ...WORKER_ARGS]);
    expect(seen[0]!.args).not.toContain("--settings");
    expect(seen[0]!.entries).toEqual([]);
    expect(seen[0]!.env).toMatchObject({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CONFIG_DIR: config });
    expect(existsSync(seen[0]!.cwd)).toBe(false);
  });

  it("carries only the auth part of the user's settings into --settings", () => {
    const config = mkdtempSync(join(tmpdir(), "cc-lhc-cli-cfg-"));
    expect(userAuthSettings({ CLAUDE_CONFIG_DIR: config })).toBeNull();
    writeFileSync(
      join(config, "settings.json"),
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "http://proxy",
          ANTHROPIC_AUTH_TOKEN: "tok",
          ANTHROPIC_DEFAULT_SONNET_MODEL: "x",
          FOO: "1",
        },
        apiKeyHelper: "/bin/key",
        outputStyle: "Explanatory",
        permissions: { allow: ["Edit"] },
        hooks: { Stop: [] },
      }),
    );
    expect(userAuthSettings({ CLAUDE_CONFIG_DIR: config })).toEqual({
      env: { ANTHROPIC_BASE_URL: "http://proxy", ANTHROPIC_AUTH_TOKEN: "tok" },
      apiKeyHelper: "/bin/key",
    });
    writeFileSync(join(config, "settings.json"), JSON.stringify({ env: { FOO: "1" }, outputStyle: "x" }));
    expect(userAuthSettings({ CLAUDE_CONFIG_DIR: config })).toBeNull();
  });

  it("classifies auth stderr", async () => {
    const harness = fakeCall({ CC_LHC_FAKE_MODE: "auth" });
    const result = await harness.call(baseInput);
    harness.restore();
    expect(result).toEqual({ ok: false, kind: "auth", message: expect.stringContaining("OAuth") });
  });

  it("classifies a no-login reported on stdout with empty stderr as auth", async () => {
    const harness = fakeCall({ CC_LHC_FAKE_MODE: "auth-stdout" });
    const result = await harness.call(baseInput);
    harness.restore();
    expect(result).toEqual({ ok: false, kind: "auth", message: "Not logged in · Please run /login" });
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

  // Deterministic ChildProcess-compatible seam (no real child, no timing):
  // stdin.write reports the platform's child-exited failure asynchronously
  // (nextTick, like Windows' "write EOF"), then the child closes with the
  // scripted code on a later setImmediate — error strictly before close.
  function scriptedSpawn(script: { stdinError?: Error; exitCode: number; stdout?: string }): typeof spawn {
    return ((..._args: Parameters<typeof spawn>) => {
      const stdin = new EventEmitter() as EventEmitter & { write: (d: unknown) => boolean; end: () => void };
      stdin.write = () => {
        if (script.stdinError !== undefined) {
          process.nextTick(() => stdin.emit("error", script.stdinError));
          return false;
        }
        return true;
      };
      stdin.end = () => {};
      const child = new EventEmitter() as EventEmitter & {
        stdin: typeof stdin;
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: () => void;
      };
      child.stdin = stdin;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setImmediate(() => {
        if (script.stdout !== undefined) child.stdout.emit("data", script.stdout);
        child.emit("close", script.exitCode);
      });
      return child as unknown as ChildProcess;
    }) as typeof spawn;
  }

  it("fails closed on exit 0 when the prompt was never delivered (stdin failure), and settles/releases once", async () => {
    const limiter = createConcurrencyLimiter(1);
    const failing = createClaudeCliModelCall({
      binary: () => "claude",
      spawnFn: scriptedSpawn({
        stdinError: Object.assign(new Error("write EOF"), { code: "EOF" }),
        exitCode: 0,
        stdout: "plausible summary that never saw the prompt",
      }),
      limiter,
      maxConcurrency: 1,
      timeoutMs: 1_000,
    });
    const result = await failing(baseInput);
    expect(result).toEqual({ ok: false, kind: "other", message: expect.stringContaining("stdin delivery failed") });
    if (!result.ok) expect(result.message).toContain("write EOF");

    // The failed call released its slot exactly once: a follow-up call on the
    // SAME single-slot limiter runs immediately and a clean exit-0 child with
    // delivered stdin still succeeds unchanged.
    const succeeding = createClaudeCliModelCall({
      binary: () => "claude",
      spawnFn: scriptedSpawn({ exitCode: 0, stdout: "ok" }),
      limiter,
      maxConcurrency: 1,
      timeoutMs: 1_000,
    });
    await expect(succeeding(baseInput)).resolves.toEqual({ ok: true, text: "ok" });
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
