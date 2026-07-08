import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { spawn } from "@lydell/node-pty";
import { inspect, messages } from "lhc";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultRegistryPath } from "../../src/intake/paths.js";
import { runCompactCommand } from "../../src/commands/compact.js";
import { formatReceiptLine } from "../../src/commands/context.js";
import { DEFAULT_LEADER_BYTE } from "../../src/wrapper/modal.js";
import { ENTER_ALT_SCREEN, LEAVE_ALT_SCREEN } from "../../src/wrapper/panel.js";
import {
  onTerminalResize,
  OUTPUT_HOLD_OVERFLOW_MESSAGE,
  resizePty,
  run,
  type PtySpawn,
  type RunChildControl,
} from "../../src/wrapper/run.js";
import { executeSessionSwap } from "../../src/wrapper/session-swap.js";
import { createWrapperLog } from "../../src/wrapper/wrapper-log.js";

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

  it("buffers stdin from onBeforeRespawn through live terminate grace into the replacement", async () => {
    const { codexHome } = tempEnvPair();
    process.env.CODEX_LHC_FAKE_MODE = "sleep";
    process.env.CODEX_LHC_FAKE_SLEEP_MS = "120000";
    const stdout = fakeStdout(80, 24);
    const stderr = fakeStderr();
    const stdin = fakeStdin();
    const output: string[] = [];
    stdout.on("data", (chunk: Buffer) => output.push(chunk.toString("latin1")));
    const gapMarker = "PRE-SPAWN-GAP";
    const replacementWrites: Buffer[] = [];
    let spawnCount = 0;
    let swapStarted = false;

    const spawnPty: PtySpawn = (file, args, options) => {
      spawnCount += 1;
      const pty = spawnFakeCodex(file, args, options);
      if (spawnCount >= 2) {
        const origWrite = pty.write.bind(pty);
        pty.write = (data: string | Buffer) => {
          if (swapStarted) {
            replacementWrites.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
          }
          return origWrite(data);
        };
      }
      return pty;
    };

    void run([], {
      codexBin: process.execPath,
      spawnPty: (file, args, options) => {
        writeInstantRollout(codexHome);
        return spawnPty(file, args, options);
      },
      stdin,
      stdout,
      stderr,
      noInference: true,
      captureDeps: { discoverDeps: { codexHome, pollMs: 20 } },
      testExecuteSessionSwap: async (input) => {
        swapStarted = true;
        return executeSessionSwap({
          ...input,
          codexHome,
          noInference: true,
          terminateGraceMs: 400,
          confirmWindowMs: 2_000,
          confirmPollMs: 50,
        });
      },
      dispatchLhcCommand: async (line, ctx) => {
        if (line !== "/lhc-compact") return { messages: [] };
        return runCompactCommand(ctx);
      },
      onChildControl: (ctrl) => {
        const origMark = ctrl.markSwapKill.bind(ctrl);
        ctrl.markSwapKill = (child) => {
          if (swapStarted) stdin.write(gapMarker);
          origMark(child);
        };
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    stdin.write(Buffer.from([DEFAULT_LEADER_BYTE]));
    await vi.waitFor(() => expect(output.join("")).toContain(ENTER_ALT_SCREEN));
    stdin.write("compact\r");
    await vi.waitFor(
      () => expect(Buffer.concat(replacementWrites).toString()).toContain(gapMarker),
      { timeout: 15_000 },
    );
    stdin.end();
  }, 20_000);

  it("logs and buffers stdin when pty.write throws in passthrough", async () => {
    const { lhcHome } = tempEnvPair();
    const logPath = join(lhcHome, "wrapper.log");
    const wrapperLog = createWrapperLog(logPath);
    process.env.CODEX_LHC_FAKE_MODE = "sleep";
    process.env.CODEX_LHC_FAKE_SLEEP_MS = "120000";
    const stdout = fakeStdout(80, 24);
    const stderr = fakeStderr();
    const stdin = fakeStdin();
    let throwOnWrite = true;

    const spawnPty: PtySpawn = (file, args, options) => {
      const pty = spawnFakeCodex(file, args, options);
      const origWrite = pty.write.bind(pty);
      pty.write = (data: string | Buffer) => {
        if (throwOnWrite) throw new Error("pty write probe");
        return origWrite(data);
      };
      return pty;
    };

    void run([], {
      codexBin: process.execPath,
      spawnPty,
      stdin,
      stdout,
      stderr,
      wrapperLog,
      noCapture: true,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    stdin.write("probe-bytes");
    await vi.waitFor(async () =>
      (await readFile(logPath, "utf8")).includes("pty write failed; 11 bytes buffered: pty write probe"),
    );
    stdin.end();
  }, 10_000);

  it("logs when stdin flush to replacement throws", async () => {
    const { lhcHome, codexHome } = tempEnvPair();
    const logPath = join(lhcHome, "wrapper.log");
    const wrapperLog = createWrapperLog(logPath);
    process.env.CODEX_LHC_FAKE_MODE = "sleep";
    process.env.CODEX_LHC_FAKE_SLEEP_MS = "120000";
    const stdout = fakeStdout(80, 24);
    const stderr = fakeStderr();
    const stdin = fakeStdin();
    let control: RunChildControl | undefined;

    void run([], {
      codexBin: process.execPath,
      spawnPty: (file, args, options) => {
        writeInstantRollout(codexHome);
        return spawnFakeCodex(file, args, options);
      },
      stdin,
      stdout,
      stderr,
      wrapperLog,
      noInference: true,
      captureDeps: { discoverDeps: { codexHome, pollMs: 20 } },
      onChildControl: (ctrl) => {
        control = ctrl;
      },
      dispatchLhcCommand: async (_line, ctx) => {
        ctx.swap.onBeforeRespawn?.();
        stdin.write("flush-probe");
        expect(control).toBeDefined();
        const origSpawn = control!.spawnReplacement.bind(control);
        control!.spawnReplacement = (argv) => {
          const child = origSpawn(argv);
          child.pty.write = () => {
            throw new Error("flush probe");
          };
          return child;
        };
        control!.spawnReplacement([]);
        return { messages: [], swapSettle: { confirmed: true, dismissedForRespawn: true } };
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    stdin.write(Buffer.from([DEFAULT_LEADER_BYTE]));
    stdin.write("compact\r");
    await vi.waitFor(async () =>
      (await readFile(logPath, "utf8")).includes(
        "stdin flush to replacement failed; 11 bytes dropped: flush probe",
      ),
    );
    stdin.end();
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

  it("keeps the panel open when swap rebuild fails before dismissal", async () => {
    const { codexHome } = tempEnvPair();
    process.env.CODEX_LHC_FAKE_MODE = "sleep";
    process.env.CODEX_LHC_FAKE_SLEEP_MS = "30000";
    const stdout = fakeStdout(80, 24);
    const stderr = fakeStderr();
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
      stderr,
      noInference: true,
      captureDeps: { discoverDeps: { codexHome, pollMs: 20 } },
      testExecuteSessionSwap: async () =>
        ({
          ok: false,
          phase: "rebuild",
          receipt: { ok: false, status: "rebuild_failed", messages: ["swap rebuild failed"], oldSessionId: "probe" },
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
    await vi.waitFor(() => expect(output.join("")).toContain("swap-receipt"));
    expect(output.join("")).not.toContain(LEAVE_ALT_SCREEN);
    stdin.end();
  }, 10_000);

  it("leaves the alt screen and flushes held output before respawn/kill on confirmed swap", async () => {
    const { codexHome } = tempEnvPair();
    process.env.CODEX_LHC_FAKE_MODE = "sleep";
    process.env.CODEX_LHC_FAKE_SLEEP_MS = "120000";
    const timeline: string[] = [];
    let swapStarted = false;
    const stdout = fakeStdout(80, 24);
    const stderr = fakeStderr();
    const stdin = fakeStdin();
    const output: string[] = [];
    stdout.on("data", (chunk: Buffer) => {
      output.push(chunk.toString("latin1"));
    });
    const originalWrite = stdout.write.bind(stdout);
    let sawLeave = false;
    vi.spyOn(stdout, "write").mockImplementation((chunk, ...args) => {
      const text = String(chunk);
      if (text.includes(LEAVE_ALT_SCREEN)) {
        timeline.push("leave-alt-screen");
        sawLeave = true;
      } else if (sawLeave && !timeline.includes("held-flush") && /tick\d/.test(text)) {
        timeline.push("held-flush");
      }
      return originalWrite(chunk, ...args);
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
      testExecuteSessionSwap: async (input) => {
        swapStarted = true;
        return executeSessionSwap({
          ...input,
          codexHome,
          noInference: true,
          terminateGraceMs: 30,
          confirmWindowMs: 1_000,
          confirmPollMs: 25,
          onBeforeRespawn: () => {
            timeline.push("rebuild-written");
            input.onBeforeRespawn?.();
          },
        });
      },
      dispatchLhcCommand: async (line, ctx) => {
        if (line !== "/lhc-compact") return { messages: [] };
        return runCompactCommand(ctx);
      },
      onChildControl: (ctrl) => {
        const origMark = ctrl.markSwapKill.bind(ctrl);
        ctrl.markSwapKill = (child) => {
          if (swapStarted) timeline.push("terminate-child");
          origMark(child);
        };
        const origSpawn = ctrl.spawnReplacement.bind(ctrl);
        ctrl.spawnReplacement = (argv) => {
          if (swapStarted) timeline.push("spawn-replacement");
          return origSpawn(argv);
        };
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    stdin.write(Buffer.from([DEFAULT_LEADER_BYTE]));
    await vi.waitFor(() => expect(output.join("")).toContain(ENTER_ALT_SCREEN));
    stdin.write("compact\r");
    await vi.waitFor(() => expect(timeline.includes("spawn-replacement")).toBe(true), { timeout: 15_000 });

    const rebuildIdx = timeline.indexOf("rebuild-written");
    const leaveIdx = timeline.indexOf("leave-alt-screen");
    const heldIdx = timeline.indexOf("held-flush");
    const terminateIdx = timeline.indexOf("terminate-child");
    const spawnIdx = timeline.indexOf("spawn-replacement");
    expect(rebuildIdx).toBeGreaterThan(-1);
    expect(leaveIdx).toBeGreaterThan(rebuildIdx);
    if (heldIdx >= 0) expect(heldIdx).toBeGreaterThan(leaveIdx);
    expect(terminateIdx).toBeGreaterThan(leaveIdx);
    expect(spawnIdx).toBeGreaterThan(terminateIdx);
    expect(output.join("")).toContain(LEAVE_ALT_SCREEN);
    stdin.end();
  }, 20_000);

  it("reopens the panel with a failure receipt when swap fails after dismissal", async () => {
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
      dispatchLhcCommand: async (_line, ctx) => {
        ctx.swap.onBeforeRespawn?.();
        const settle = ctx.swap.onSwapFailureAfterDismiss!(
          "swap did not confirm for new-session",
          ["compact view=v4"],
        );
        return { messages: ["compact view=v4"], swapSettle: settle };
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    stdin.write(Buffer.from([DEFAULT_LEADER_BYTE]));
    await vi.waitFor(() => output.join("").includes(ENTER_ALT_SCREEN));
    stdin.write("compact\r");
    await vi.waitFor(() => expect(output.join("")).toContain("swap did not confirm"));
    const joined = output.join("");
    const firstLeave = joined.indexOf(LEAVE_ALT_SCREEN);
    const reopenEnter = joined.indexOf(ENTER_ALT_SCREEN, firstLeave + 1);
    expect(firstLeave).toBeGreaterThan(-1);
    expect(reopenEnter).toBeGreaterThan(firstLeave);
    stdin.end();
  }, 10_000);

  it("prints an exit report when recovery fails after panel dismissal", async () => {
    const { codexHome } = tempEnvPair();
    process.env.CODEX_LHC_FAKE_MODE = "sleep";
    process.env.CODEX_LHC_FAKE_SLEEP_MS = "30000";
    const stdout = fakeStdout(80, 24);
    const stderr = fakeStderr();
    const stdin = fakeStdin();
    const timeline: string[] = [];

    const exitPromise = run([], {
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
      onChildControl: (ctrl) => {
        const child = ctrl.getCurrent();
        expect(child.isAlive()).toBe(true);
        const origKill = child.kill.bind(child);
        child.kill = (signal) => {
          timeline.push(`child-kill:${signal}`);
          origKill(signal);
        };
        void child.waitForExit().then(() => {
          timeline.push("child-exited");
        });
      },
      dispatchLhcCommand: async (_line, ctx) => {
        ctx.swap.onBeforeRespawn?.();
        return {
          messages: ["compact view=v4"],
          swapSettle: ctx.swap.onSwapFailureAfterDismiss!(
            "swap recovery failed",
            ["compact view=v4"],
            { terminalExit: true },
          ),
          wrapperExitCode: 1,
        };
      },
    });

    const origStderrWrite = stderr.write.bind(stderr);
    vi.spyOn(stderr, "write").mockImplementation((chunk, ...args) => {
      const text = String(chunk);
      if (text.includes(formatReceiptLine("swap recovery failed"))) {
        timeline.push("exit-report-written");
      }
      return origStderrWrite(chunk, ...args);
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    stdin.write(Buffer.from([DEFAULT_LEADER_BYTE]));
    stdin.write("compact\r");
    stdin.end();
    const exitCode = await exitPromise;

    expect(exitCode).toBe(1);
    expect(timeline.some((entry) => entry.startsWith("child-kill:"))).toBe(true);
    const childExitIdx = timeline.indexOf("child-exited");
    const reportIdx = timeline.indexOf("exit-report-written");
    expect(childExitIdx).toBeGreaterThan(-1);
    expect(reportIdx).toBeGreaterThan(childExitIdx);
  }, 10_000);

  it("shows recovery failure in the panel when dismissal has not happened", async () => {
    const { codexHome } = tempEnvPair();
    process.env.CODEX_LHC_FAKE_MODE = "sleep";
    process.env.CODEX_LHC_FAKE_SLEEP_MS = "30000";
    const stdout = fakeStdout(80, 24);
    const stderr = fakeStderr();
    const stdin = fakeStdin();
    const output: string[] = [];
    stdout.on("data", (chunk: Buffer) => output.push(chunk.toString("latin1")));

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
      testExecuteSessionSwap: async () => ({
        ok: false,
        phase: "recovery",
        recovered: false,
        exitCode: 1,
        error: new Error("recovery spawn failed"),
        rebuilt: {
          sessionId: "new",
          rolloutPath: "/tmp/new.jsonl",
          lineCount: 1,
          replayedPrefixLines: 1,
        },
        receipt: {
          ok: false,
          status: "recovery_failed",
          oldSessionId: "old",
          messages: ["swap recovery failed"],
        },
      }),
      dispatchLhcCommand: async (line, ctx) => {
        if (line !== "/lhc-compact") return { messages: [] };
        return runCompactCommand(ctx);
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    stdin.write(Buffer.from([DEFAULT_LEADER_BYTE]));
    await vi.waitFor(() => output.join("").includes(ENTER_ALT_SCREEN));
    stdin.write("compact\r");
    await vi.waitFor(() => output.join("").includes("swap recovery failed"));
    expect(output.join("")).toContain(ENTER_ALT_SCREEN);
    stdin.end();
  }, 10_000);

  it("logs a late swap failure when passthrough resumed after dismissed user panel (generation mismatch)", async () => {
    const { codexHome, lhcHome } = tempEnvPair();
    const logPath = join(lhcHome, "wrapper.log");
    const wrapperLog = createWrapperLog(logPath);
    process.env.CODEX_LHC_FAKE_MODE = "sleep";
    process.env.CODEX_LHC_FAKE_SLEEP_MS = "30000";
    const stdout = fakeStdout(80, 24);
    const stdin = fakeStdin();
    const output: string[] = [];
    stdout.on("data", (chunk: Buffer) => {
      output.push(chunk.toString("latin1"));
    });

    let releaseFailure!: () => void;
    const failureGate = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });

    void run([], {
      codexBin: process.execPath,
      spawnPty: (file, args, options) => {
        writeInstantRollout(codexHome);
        return spawnFakeCodex(file, args, options);
      },
      stdin,
      stdout,
      wrapperLog,
      noInference: true,
      captureDeps: { discoverDeps: { codexHome, pollMs: 20 } },
      dispatchLhcCommand: async (_line, ctx) => {
        ctx.swap.onBeforeRespawn?.();
        await failureGate;
        return {
          messages: ["compact view=v4"],
          swapSettle: ctx.swap.onSwapFailureAfterDismiss!(
            "swap did not confirm for new-session",
            ["compact view=v4"],
          ),
        };
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    stdin.write(Buffer.from([DEFAULT_LEADER_BYTE]));
    await vi.waitFor(() => expect(output.join("")).toContain(ENTER_ALT_SCREEN));
    stdin.write("compact\r");
    await vi.waitFor(() => expect(output.join("")).toContain(LEAVE_ALT_SCREEN));

    stdin.write(Buffer.from([DEFAULT_LEADER_BYTE]));
    await vi.waitFor(() => expect(output.filter((chunk) => chunk.includes(ENTER_ALT_SCREEN)).length).toBeGreaterThanOrEqual(2));
    stdin.write(Buffer.from("status"));
    await vi.waitFor(() => expect(output.join("")).toContain("long-horizon commands> status"));

    releaseFailure();
    await vi.waitFor(async () =>
      (await readFile(logPath, "utf8")).includes("swap failed after panel dismissal"),
    );

    const joined = output.join("");
    const secondEnter = joined.indexOf(ENTER_ALT_SCREEN, joined.indexOf(LEAVE_ALT_SCREEN) + 1);
    const afterUserPanel = joined.slice(secondEnter);
    expect(afterUserPanel).toContain("long-horizon commands> status");
    expect(afterUserPanel).not.toContain("swap did not confirm");

    const logText = await readFile(logPath, "utf8");
    expect(logText).toMatch(/\[warn\].*swap failed after panel dismissal \(user panel active\)/);
    expect(logText).toMatch(/swap did not confirm/);
    stdin.end();
  }, 20_000);

  it("routes passthrough diagnostics to wrapper log with zero stdout/stderr writes", async () => {
    process.env.CODEX_LHC_LEADER = "invalid";
    const { codexHome, lhcHome } = tempEnvPair();
    const logPath = join(lhcHome, "wrapper.log");
    const wrapperLog = createWrapperLog(logPath);
    process.env.CODEX_LHC_FAKE_MODE = "tick";

    const stdout = fakeStdout(80, 24);
    const stderr = fakeStderr();
    const stdin = fakeStdin();
    const passthroughWrites: string[] = [];
    let modalOpen = false;
    const isChildTick = (chunk: string): boolean => /^(tick\d+\r\n)+$/.test(chunk);
    const isAllowedPassthroughWrite = (chunk: string): boolean => {
      if (chunk.includes(ENTER_ALT_SCREEN) || chunk.includes(LEAVE_ALT_SCREEN)) return true;
      const stripped = chunk.replaceAll(ENTER_ALT_SCREEN, "").replaceAll(LEAVE_ALT_SCREEN, "");
      if (stripped.length === 0) return true;
      return isChildTick(stripped);
    };

    const trackPassthrough = (chunk: string): void => {
      if (chunk.includes(ENTER_ALT_SCREEN)) modalOpen = true;
      if (chunk.includes(LEAVE_ALT_SCREEN)) modalOpen = false;
      if (!modalOpen) passthroughWrites.push(chunk);
    };

    const wrapperPassthroughWrites = (): string[] =>
      passthroughWrites.filter((chunk) => !isAllowedPassthroughWrite(chunk));

    const stdoutWrite = vi.spyOn(stdout, "write").mockImplementation((chunk, ...args) => {
      trackPassthrough(String(chunk));
      return (PassThrough.prototype.write as typeof stdout.write).call(stdout, chunk, ...args);
    });
    const stderrWrite = vi.spyOn(stderr, "write").mockImplementation((chunk, ...args) => {
      trackPassthrough(String(chunk));
      return (PassThrough.prototype.write as typeof stderr.write).call(stderr, chunk, ...args);
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
      wrapperLog,
      noInference: true,
      outputHoldCapBytes: 32,
      captureDeps: { discoverDeps: { codexHome, pollMs: 20 } },
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(wrapperPassthroughWrites()).toEqual([]);

    process.kill(process.pid, "SIGUSR1");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(wrapperPassthroughWrites()).toEqual([]);

    wrapperLog.warn("capture diagnostic");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(wrapperPassthroughWrites()).toEqual([]);

    stdin.write(Buffer.from([DEFAULT_LEADER_BYTE]));
    await vi.waitFor(() => expect(modalOpen).toBe(true), { timeout: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(wrapperPassthroughWrites()).toEqual([]);
    wrapperLog.warn(OUTPUT_HOLD_OVERFLOW_MESSAGE);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(wrapperPassthroughWrites()).toEqual([]);

    const logText = await readFile(logPath, "utf8");
    expect(logText).toMatch(/\[warn\].*CODEX_LHC_LEADER/);
    expect(logText).toMatch(/\[info\].*codex-lhc-capture lines=/);
    expect(logText).toMatch(/\[warn\] capture diagnostic/);
    expect(logText).toMatch(new RegExp(`\\[warn\\] ${OUTPUT_HOLD_OVERFLOW_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
    stdin.end();
  }, 30_000);

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
