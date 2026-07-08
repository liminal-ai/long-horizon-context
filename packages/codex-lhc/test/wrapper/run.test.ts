import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { spawn } from "@lydell/node-pty";
import { inspect, messages } from "lhc";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultRegistryPath } from "../../src/intake/paths.js";
import { DEFAULT_LEADER_BYTE } from "../../src/wrapper/modal.js";
import { ENTER_ALT_SCREEN, LEAVE_ALT_SCREEN } from "../../src/wrapper/panel.js";
import { onTerminalResize, resizePty, run, type PtySpawn } from "../../src/wrapper/run.js";

const FAKE_CODEX = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "fake-codex.mjs");
const SESSION_ID = "550e8400-e29b-41d4-a716-446655440099";
const USER_PROMPT = "sanitized user prompt";
const ASSISTANT_TEXT = "sanitized assistant response";

const spawnFakeCodex: PtySpawn = (file, args, options) => {
  const argv = Array.isArray(args) ? args : [args];
  return spawn(file, [FAKE_CODEX, ...argv], options);
};

function fakeStdin(): NodeJS.ReadStream {
  const stream = new PassThrough() as unknown as NodeJS.ReadStream;
  Object.defineProperty(stream, "isTTY", { value: false, configurable: true });
  return stream;
}

function fakeStderr(): NodeJS.WriteStream {
  return new PassThrough() as unknown as NodeJS.WriteStream;
}

function fakeStdout(cols: number, rows: number): NodeJS.WriteStream {
  const stream = new PassThrough() as unknown as NodeJS.WriteStream;
  Object.defineProperty(stream, "columns", { value: cols, configurable: true });
  Object.defineProperty(stream, "rows", { value: rows, configurable: true });
  Object.defineProperty(stream, "isTTY", { value: false, configurable: true });
  return stream;
}

function tempEnvPair(): { lhcHome: string; codexHome: string } {
  const lhcHome = mkdtempSync(join(tmpdir(), "codex-lhc-run-home-"));
  const codexHome = mkdtempSync(join(tmpdir(), "codex-lhc-run-codex-"));
  process.env.CODEX_LHC_HOME = lhcHome;
  process.env.CODEX_LHC_FAKE_CODEX_HOME = codexHome;
  process.env.CODEX_LHC_FAKE_SESSION_ID = SESSION_ID;
  process.env.CODEX_LHC_FAKE_MODE = "rollout";
  delete process.env.CODEX_LHC_FAKE_EXIT_CODE;
  delete process.env.CODEX_LHC_NO_INFERENCE;
  return { lhcHome, codexHome };
}

function writeInstantRollout(codexHome: string, sessionId: string = SESSION_ID): string {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dayDir = join(codexHome, "sessions", year, month, day);
  mkdirSync(dayDir, { recursive: true });
  const rolloutPath = join(dayDir, `rollout-${stamp}-${sessionId}.jsonl`);
  const lines = [
    JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "session_meta",
      payload: { session_id: sessionId, id: sessionId, cwd: process.cwd() },
    }),
    JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: USER_PROMPT }],
      },
    }),
    JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "response_item",
      payload: {
        type: "message",
        id: "msg_fake_assistant",
        role: "assistant",
        content: [{ type: "output_text", text: ASSISTANT_TEXT }],
      },
    }),
  ];
  writeFileSync(rolloutPath, `${lines.join("\n")}\n`);
  return rolloutPath;
}

function threadIdFromStatsLine(line: string | undefined): string {
  const match = /thread=([^\s\n]+)/.exec(line ?? "");
  if (match?.[1] === undefined || match[1] === "none") {
    throw new Error(`expected thread id in stats line, got: ${line ?? "undefined"}`);
  }
  return match[1];
}

function messageTexts(
  listed: Awaited<ReturnType<typeof messages.list>>,
): string[] {
  if (!listed.ok) throw new Error(`messages.list failed: ${listed.error.reason}`);
  const texts: string[] = [];
  for (const record of listed.value) {
    for (const block of record.blocks) {
      if (block.blockType === "text" && typeof block.content.text === "string") {
        texts.push(block.content.text);
      }
    }
  }
  return texts;
}

describe("resizePty", () => {
  it("calls pty.resize with the given dimensions", () => {
    const resize = vi.fn();
    resizePty({ resize }, 120, 40);
    expect(resize).toHaveBeenCalledWith(120, 40);
  });
});

describe("onTerminalResize", () => {
  it("reads cols/rows from stdout", () => {
    const resize = vi.fn();
    const stdout = fakeStdout(100, 30);
    onTerminalResize({ resize }, stdout);
    expect(resize).toHaveBeenCalledWith(100, 30);
  });

  it("falls back when stdout has no dimensions", () => {
    const resize = vi.fn();
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
    onTerminalResize({ resize }, stdout);
    expect(resize).toHaveBeenCalledWith(80, 24);
  });
});

describe("run", () => {
  const savedEnv: Record<string, string | undefined> = {};

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("forwards stub child stdout and propagates exit code", async () => {
    const stdout = fakeStdout(80, 24);
    const stdin = fakeStdin();
    const output: string[] = [];
    stdout.on("data", (chunk: Buffer) => {
      output.push(chunk.toString());
    });

    const exitCode = await run(["-c", "echo hello; exit 3"], {
      codexBin: "bash",
      stdin,
      stdout,
      noCapture: true,
    });

    expect(output.join("")).toContain("hello");
    expect(exitCode).toBe(3);
  });

  it("records startedAt before spawn so an instant rollout write is discoverable", async () => {
    const { codexHome } = tempEnvPair();
    process.env.CODEX_LHC_FAKE_MODE = "empty";
    const stdout = fakeStdout(80, 24);
    const stderr = fakeStderr();
    const stdin = fakeStdin();
    const errLines: string[] = [];
    stderr.on("data", (chunk: Buffer) => {
      errLines.push(chunk.toString());
    });

    const exitCode = await run([], {
      codexBin: process.execPath,
      spawnPty: (file, args, options) => {
        writeInstantRollout(codexHome);
        return spawnFakeCodex(file, args, options);
      },
      stdin,
      stdout,
      stderr,
      noInference: true,
      captureDeps: { discoverDeps: { codexHome, pollMs: 20 } },
    });

    stdin.end();
    expect(exitCode).toBe(0);
    const statsLine = errLines.find((line) => line.includes("codex-lhc-capture"));
    expect(statsLine).toMatch(/events=[1-9]/);
    expect(statsLine).not.toMatch(/thread=none/);
  });

  it("captures fake-codex rollout into an LHC thread", async () => {
    const { codexHome } = tempEnvPair();
    const stdout = fakeStdout(80, 24);
    const stderr = fakeStderr();
    const stdin = fakeStdin();
    const errLines: string[] = [];
    stderr.on("data", (chunk: Buffer) => {
      errLines.push(chunk.toString());
    });

    const runPromise = run([], {
      codexBin: process.execPath,
      spawnPty: spawnFakeCodex,
      stdin,
      stdout,
      stderr,
      noInference: true,
      captureDeps: { discoverDeps: { codexHome, pollMs: 20 } },
    });

    stdin.end();
    const exitCode = await runPromise;

    expect(exitCode).toBe(0);
    const statsLine = errLines.find((line) => line.includes("codex-lhc-capture"));
    expect(statsLine).toBeDefined();
    expect(statsLine).toMatch(/events=[1-9]/);
    expect(statsLine).toMatch(/thread=/);
    expect(statsLine).not.toMatch(/thread=none/);

    const threadId = threadIdFromStatsLine(statsLine);
    const threadRef = { threadId, registryPath: defaultRegistryPath() };
    const overview = await inspect.overview(threadRef);
    expect(overview.ok).toBe(true);
    if (overview.ok) {
      expect(overview.value.messages.visible).toBeGreaterThanOrEqual(2);
    }

    const listed = await messages.list(threadRef);
    const texts = messageTexts(listed);
    expect(texts).toContain(USER_PROMPT);
    expect(texts).toContain(ASSISTANT_TEXT);
  });

  it("prints capture stats on exit and honors fake exit code", async () => {
    const { codexHome } = tempEnvPair();
    process.env.CODEX_LHC_FAKE_EXIT_CODE = "7";
    const stdout = fakeStdout(80, 24);
    const stderr = fakeStderr();
    const stdin = fakeStdin();
    const errLines: string[] = [];
    stderr.on("data", (chunk: Buffer) => {
      errLines.push(chunk.toString());
    });

    const exitCode = await run([], {
      codexBin: process.execPath,
      spawnPty: spawnFakeCodex,
      stdin,
      stdout,
      stderr,
      noInference: true,
      captureDeps: { discoverDeps: { codexHome, pollMs: 20 } },
    });

    stdin.end();
    expect(exitCode).toBe(7);
    expect(errLines.some((line) => line.includes("codex-lhc-capture"))).toBe(true);
  });

  it("skips capture in --no-capture passthrough mode", async () => {
    tempEnvPair();
    const stdout = fakeStdout(80, 24);
    const stderr = fakeStderr();
    const stdin = fakeStdin();
    const errLines: string[] = [];
    stderr.on("data", (chunk: Buffer) => {
      errLines.push(chunk.toString());
    });

    const exitCode = await run([], {
      codexBin: process.execPath,
      spawnPty: spawnFakeCodex,
      stdin,
      stdout,
      stderr,
      noCapture: true,
    });

    stdin.end();
    expect(exitCode).toBe(0);
    expect(errLines.some((line) => line.includes("codex-lhc-capture"))).toBe(false);
  });

  it("ignores wrapper-initiated swap kills and still propagates the replacement exit", async () => {
    tempEnvPair();
    process.env.CODEX_LHC_FAKE_MODE = "sleep";
    process.env.CODEX_LHC_FAKE_SLEEP_MS = "120000";
    const stdout = fakeStdout(80, 24);
    const stderr = fakeStderr();
    const stdin = fakeStdin();

    const exitCode = await run([], {
      codexBin: process.execPath,
      spawnPty: spawnFakeCodex,
      stdin,
      stdout,
      stderr,
      noCapture: true,
      onChildControl: (control) => {
        setTimeout(() => {
          const oldChild = control.getCurrent();
          control.markSwapKill(oldChild);
          oldChild.kill("SIGTERM");
          process.env.CODEX_LHC_FAKE_MODE = "rollout";
          process.env.CODEX_LHC_FAKE_EXIT_CODE = "4";
          control.spawnReplacement([]);
        }, 50);
      },
    });

    stdin.end();
    expect(exitCode).toBe(4);
  });

  it("does not propagate a killed failed-new child while recovery becomes current", async () => {
    tempEnvPair();
    process.env.CODEX_LHC_FAKE_MODE = "sleep";
    process.env.CODEX_LHC_FAKE_SLEEP_MS = "120000";
    const stdout = fakeStdout(80, 24);
    const stderr = fakeStderr();
    const stdin = fakeStdin();

    const exitCode = await run([], {
      codexBin: process.execPath,
      spawnPty: spawnFakeCodex,
      stdin,
      stdout,
      stderr,
      noCapture: true,
      onChildControl: (control) => {
        setTimeout(() => {
          const oldChild = control.getCurrent();
          control.markSwapKill(oldChild);
          oldChild.kill("SIGTERM");

          process.env.CODEX_LHC_FAKE_MODE = "sleep";
          process.env.CODEX_LHC_FAKE_SLEEP_MS = "120000";
          const failedNew = control.spawnReplacement([]);
          control.markSwapKill(failedNew);
          failedNew.kill("SIGTERM");

          process.env.CODEX_LHC_FAKE_MODE = "rollout";
          process.env.CODEX_LHC_FAKE_EXIT_CODE = "6";
          process.env.CODEX_LHC_FAKE_STDIN_TIMEOUT_MS = "20";
          control.spawnReplacement([]);
        }, 50);
      },
    });

    stdin.end();
    expect(exitCode).toBe(6);
  });

  it("buffers stdin across kill→respawn and flushes to the new child", async () => {
    tempEnvPair();
    process.env.CODEX_LHC_FAKE_MODE = "sleep";
    process.env.CODEX_LHC_FAKE_SLEEP_MS = "120000";
    const stdout = fakeStdout(80, 24);
    const stderr = fakeStderr();
    const stdin = fakeStdin();
    const gapMarker = "GAP-BYTES";
    const replacementWrites: Buffer[] = [];
    let spawnCount = 0;

    const spawnPty: PtySpawn = (file, args, options) => {
      spawnCount += 1;
      const pty = spawnFakeCodex(file, args, options);
      if (spawnCount >= 2) {
        const origWrite = pty.write.bind(pty);
        pty.write = (data: string | Buffer) => {
          replacementWrites.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
          return origWrite(data);
        };
      }
      return pty;
    };

    const exitCode = await run([], {
      codexBin: process.execPath,
      spawnPty,
      stdin,
      stdout,
      stderr,
      noCapture: true,
      onChildControl: (control) => {
        void (async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          const oldChild = control.getCurrent();
          control.markSwapKill(oldChild);
          oldChild.kill("SIGTERM");
          await oldChild.waitForExit();
          stdin.write(gapMarker);
          process.env.CODEX_LHC_FAKE_MODE = "rollout";
          process.env.CODEX_LHC_FAKE_STDIN_TIMEOUT_MS = "500";
          control.spawnReplacement([]);
        })();
      },
    });

    stdin.end();
    expect(exitCode).toBe(0);
    expect(Buffer.concat(replacementWrites).toString()).toContain(gapMarker);
  }, 10_000);

  it("dedupes replayed rollout content on a second run against the same thread", async () => {
    const { codexHome } = tempEnvPair();
    const stdout = fakeStdout(80, 24);
    const stderr = fakeStderr();
    const stdin1 = fakeStdin();
    const errLines: string[] = [];
    stderr.on("data", (chunk: Buffer) => {
      errLines.push(chunk.toString());
    });

    const spawnFake = spawnFakeCodex;

    const firstExit = await run([], {
      codexBin: process.execPath,
      spawnPty: spawnFake,
      stdin: stdin1,
      stdout,
      stderr,
      noInference: true,
      captureDeps: { discoverDeps: { codexHome, pollMs: 20 } },
    });
    stdin1.end();
    expect(firstExit).toBe(0);

    const firstStats = errLines.find((line) => line.includes("codex-lhc-capture"));
    expect(firstStats).toMatch(/skipped_replay=0/);
    const threadId = threadIdFromStatsLine(firstStats);
    const threadRef = { threadId, registryPath: defaultRegistryPath() };
    const firstOverview = await inspect.overview(threadRef);
    expect(firstOverview.ok).toBe(true);
    const visibleAfterFirst = firstOverview.ok ? firstOverview.value.messages.visible : 0;
    expect(visibleAfterFirst).toBeGreaterThanOrEqual(2);

    const stdin2 = fakeStdin();
    const secondExit = await run(["resume", SESSION_ID], {
      codexBin: process.execPath,
      spawnPty: spawnFake,
      stdin: stdin2,
      stdout,
      stderr,
      noInference: true,
      captureDeps: { discoverDeps: { codexHome, pollMs: 20 } },
    });
    stdin2.end();
    expect(secondExit).toBe(0);

    const statsLines = errLines.filter((line) => line.includes("codex-lhc-capture"));
    expect(statsLines.length).toBeGreaterThanOrEqual(2);
    expect(statsLines.at(-1)).toMatch(/skipped_replay=[1-9]/);

    const secondOverview = await inspect.overview(threadRef);
    expect(secondOverview.ok).toBe(true);
    if (secondOverview.ok) {
      expect(secondOverview.value.messages.visible).toBe(visibleAfterFirst);
    }
  });
});

describe("modal integration", () => {
  const savedEnv: Record<string, string | undefined> = {};

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("withholds the leader byte from the pty while entering modal", async () => {
    tempEnvPair();
    process.env.CODEX_LHC_FAKE_MODE = "sleep";
    process.env.CODEX_LHC_FAKE_SLEEP_MS = "30000";
    const stdout = fakeStdout(80, 24);
    const stdin = fakeStdin();
    const ptyWrites: Buffer[] = [];
    const spawnPty: PtySpawn = (file, args, options) => {
      const pty = spawnFakeCodex(file, args, options);
      const origWrite = pty.write.bind(pty);
      pty.write = (data: string | Buffer) => {
        ptyWrites.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
        return origWrite(data);
      };
      return pty;
    };

    void run([], {
      codexBin: process.execPath,
      spawnPty,
      stdin,
      stdout,
      noCapture: true,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    stdin.write(Buffer.from("a"));
    stdin.write(Buffer.from([DEFAULT_LEADER_BYTE]));
    await vi.waitFor(() => expect(ptyWrites.some((chunk) => chunk.includes(0x61))).toBe(true));
    expect(ptyWrites.some((chunk) => chunk.includes(DEFAULT_LEADER_BYTE))).toBe(false);
    stdin.end();
  }, 10_000);

  it("dispatches a typed command and renders receipts in the panel", async () => {
    const { codexHome } = tempEnvPair();
    process.env.CODEX_LHC_FAKE_MODE = "sleep";
    process.env.CODEX_LHC_FAKE_SLEEP_MS = "30000";
    const stdout = fakeStdout(80, 24);
    const stdin = fakeStdin();
    const output: string[] = [];
    stdout.on("data", (chunk: Buffer) => {
      output.push(chunk.toString("latin1"));
    });

    const dispatch = vi.fn(async () => ({ messages: ["panel-receipt-line"] }));

    void run([], {
      codexBin: process.execPath,
      spawnPty: (file, args, options) => {
        writeInstantRollout(codexHome);
        return spawnFakeCodex(file, args, options);
      },
      stdin,
      stdout,
      noInference: true,
      captureDeps: { discoverDeps: { codexHome, pollMs: 20 } },
      dispatchLhcCommand: dispatch,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    stdin.write(Buffer.from([DEFAULT_LEADER_BYTE]));
    await vi.waitFor(() => expect(output.join("")).toContain(ENTER_ALT_SCREEN));
    stdin.write("stats\r");
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledWith("/lhc-stats", expect.anything()));
    await vi.waitFor(() => expect(output.join("")).toContain("panel-receipt-line"));
    stdin.end();
  }, 10_000);

  it("restores the main screen on dismiss after receipts", async () => {
    const { codexHome } = tempEnvPair();
    process.env.CODEX_LHC_FAKE_MODE = "sleep";
    process.env.CODEX_LHC_FAKE_SLEEP_MS = "30000";
    const stdout = fakeStdout(80, 24);
    const stdin = fakeStdin();
    const output: string[] = [];
    stdout.on("data", (chunk: Buffer) => {
      output.push(chunk.toString("latin1"));
    });

    void run([], {
      codexBin: process.execPath,
      spawnPty: (file, args, options) => {
        writeInstantRollout(codexHome);
        return spawnFakeCodex(file, args, options);
      },
      stdin,
      stdout,
      noInference: true,
      captureDeps: { discoverDeps: { codexHome, pollMs: 20 } },
      dispatchLhcCommand: async () => ({ messages: ["done"] }),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    stdin.write(Buffer.from([DEFAULT_LEADER_BYTE, ...Buffer.from("stats\r")]));
    await vi.waitFor(() => expect(output.join("")).toContain("done"));
    stdin.write(Buffer.from([0x03]));
    await vi.waitFor(() => expect(output.join("")).toContain(LEAVE_ALT_SCREEN));
    stdin.end();
  }, 10_000);

  it("dismisses the panel before swap machinery runs", async () => {
    const { codexHome } = tempEnvPair();
    process.env.CODEX_LHC_FAKE_MODE = "sleep";
    process.env.CODEX_LHC_FAKE_SLEEP_MS = "30000";
    const stdout = fakeStdout(80, 24);
    const stderr = fakeStderr();
    const stdin = fakeStdin();
    const output: string[] = [];
    const errLines: string[] = [];
    stdout.on("data", (chunk: Buffer) => {
      output.push(chunk.toString("latin1"));
    });
    stderr.on("data", (chunk: Buffer) => {
      errLines.push(chunk.toString());
    });

    void run([], {
      codexBin: process.execPath,
      spawnPty: (file, args, options) => {
        writeInstantRollout(codexHome);
        return spawnFakeCodex(file, args, options);
      },
      stdin,
      stdout,
      stderr,
      noInference: true,
      captureDeps: { discoverDeps: { codexHome, pollMs: 20 } },
      testExecuteSessionSwap: async () =>
        ({
          ok: false,
          phase: "rebuild",
          receipt: { ok: false, status: "rebuild_failed", messages: [], oldSessionId: "probe" },
          error: new Error("probe"),
        }) as never,
      dispatchLhcCommand: async (_line, ctx) => {
        await ctx.swap.executeSessionSwap!({} as never);
        return { messages: ["swap-receipt"] };
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    stdin.write(Buffer.from([DEFAULT_LEADER_BYTE]));
    await vi.waitFor(() => expect(output.join("")).toContain(ENTER_ALT_SCREEN));
    stdin.write("compact\r");
    await vi.waitFor(() => expect(output.join("")).toContain(LEAVE_ALT_SCREEN));
    await vi.waitFor(() => expect(errLines.some((line) => line.includes("[codex-lhc] swap-receipt"))).toBe(true));
    stdin.end();
  }, 10_000);

  it("leaves the alt screen on signal exit while modal is open", async () => {
    tempEnvPair();
    process.env.CODEX_LHC_FAKE_MODE = "sleep";
    process.env.CODEX_LHC_FAKE_SLEEP_MS = "120000";
    const stdout = fakeStdout(80, 24);
    const stdin = fakeStdin();
    const output: string[] = [];
    stdout.on("data", (chunk: Buffer) => {
      output.push(chunk.toString("latin1"));
    });

    void run([], {
      codexBin: process.execPath,
      spawnPty: spawnFakeCodex,
      stdin,
      stdout,
      noCapture: true,
    });

    stdin.write(Buffer.from([DEFAULT_LEADER_BYTE]));
    await vi.waitFor(() => expect(output.join("")).toContain(ENTER_ALT_SCREEN));
    process.emit("SIGINT");
    await vi.waitFor(() => expect(output.join("")).toContain(LEAVE_ALT_SCREEN));
    stdin.end();
  }, 10_000);
});
