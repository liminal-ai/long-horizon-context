/**
 * LIM-118: TC-3.1a-c, TC-3.2a. Control Panel command grammar and no mutation
 * on removed or invalid spellings.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { Lhc } from "lhc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveContextWindow } from "../../src/governor/config.js";

import type { CaptureSession, CaptureSessionDeps } from "../../src/intake/session.js";
import { emptyCaptureStats } from "../../src/stats.js";
import { CommandInFlightGuard } from "../../src/wrapper/command-guard.js";
import { firstLoadMarkerPath, markShown, ONBOARDING_VERSION } from "../../src/wrapper/first-load.js";
import {
  createInputState,
  DEFAULT_LEADER_BYTE,
  type InputAction,
  type InputState,
  processInputChunk,
} from "../../src/wrapper/modal.js";
import { renderPanel } from "../../src/wrapper/panel.js";
import { buildPanelViewSnapshot, HOME_ACTIONS, parsePanelCommand } from "../../src/wrapper/panel-commands.js";
import { run } from "../../src/wrapper/run.js";
import { panelText } from "../helpers/panel-text.js";

function renderPanelForTest(state: InputState): string {
  const panelView = buildPanelViewSnapshot({
    providerContextTokens: 31_000,
    targetTokens: 180_000,
    triggerTokens: 360_000,
    contextWindow: resolveContextWindow(1_000_000, null),
    captureHealth: "ready",
    profile: "default",
  });
  return renderPanel({ ...state, panelView }, 100, 30);
}

const LEADER = Buffer.from([DEFAULT_LEADER_BYTE]);
const mocks = vi.hoisted(() => ({
  captureFactory: null as ((opts: CaptureSessionDeps) => CaptureSession) | null,
}));

vi.mock("../../src/intake/session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/intake/session.js")>();
  return {
    ...actual,
    startCaptureSession: (opts: CaptureSessionDeps = {}) => {
      if (mocks.captureFactory !== null) return mocks.captureFactory(opts);
      return actual.startCaptureSession(opts);
    },
  };
});
function feed(
  state: InputState,
  ...chunks: Array<string | Buffer>
): {
  state: InputState;
  actions: InputAction[];
} {
  let current = state;
  const actions: InputAction[] = [];
  for (const chunk of chunks) {
    const result = processInputChunk(typeof chunk === "string" ? Buffer.from(chunk, "latin1") : chunk, current);
    current = result.state;
    actions.push(...result.actions);
  }
  return { state: current, actions };
}

function openHome(): InputState {
  return feed(createInputState(), LEADER).state;
}

function executed(actions: InputAction[]): string[] {
  return actions.filter((action) => action.kind === "execute").map((action) => action.commandLine);
}

interface FakePty {
  pid: number;
  writes: string[];
  fireExit(code: number): void;
  onData(cb: (data: string) => void): { dispose(): void };
  onExit(cb: (arg: { exitCode: number }) => void): { dispose(): void };
  kill(): void;
  write(data: string): void;
  resize(): void;
}

function makeFakePty(pid: number): FakePty {
  const exitCbs: Array<(arg: { exitCode: number }) => void> = [];
  const fake: FakePty = {
    pid,
    writes: [],
    fireExit(code: number) {
      for (const cb of exitCbs) cb({ exitCode: code });
    },
    onData: (cb) => {
      setTimeout(() => cb("ready\r\n"), 15);
      return { dispose() {} };
    },
    onExit: (cb) => {
      exitCbs.push(cb);
      return { dispose() {} };
    },
    kill: () => {
      setImmediate(() => fake.fireExit(0));
    },
    write: (data: string) => {
      fake.writes.push(data);
    },
    resize: () => {},
  };
  return fake;
}

function scriptedCapture(sdk: Lhc): CaptureSession {
  const stats = { ...emptyCaptureStats(), threadId: "th_cmd" };
  return {
    stats,
    getCommandContext: () => ({
      stats,
      sdk,
      threadRef: { threadId: "th_cmd", registryPath: "/tmp/reg.sqlite" },
      captureDegraded: false,
      captureGeneration: 1,
      capturePhase: "ready" as const,
    }),
    getRolloutInfo: () => ({ path: "/tmp/old-session.jsonl", sessionId: "old-session" }),
    isTurnOpen: () => false,
    isCaptureHealthy: () => true,
    isCaptureReady: () => true,
    getCaptureHealth: () => ({
      generation: 1,
      phase: "ready" as const,
      reasons: [],
      reasonCounts: {},
      durableLineOffset: 0,
    }),
    getCaptureGeneration: () => 1,
    getLiveAsyncWork: () => [],
    stop: vi.fn(async () => {}),
  } as unknown as CaptureSession;
}

const dirs: string[] = [];

async function waitFor(condition: () => boolean, label: string, capMs = 8_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > capMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("the panel is a slash CLI", () => {
  it("runs canonical slash commands and nothing else", () => {
    const cases: Array<[string, string]> = [
      ["/status", "/lhc-status"],
      ["/stats", "/lhc-stats"],
      ["/smart-compact", "/lhc-compact"],
      ["/smart-prune", "/lhc-prune"],
      ["/smart-prune 2500", "/lhc-prune 2500"],
      ["/export", "/lhc-export"],
      ["/bounds 100 200", "/lhc-bounds 100 200"],
      ["  /status  ", "/lhc-status"],
    ];
    for (const [typed, commandLine] of cases) {
      const parsed = parsePanelCommand(typed);
      expect(parsed.kind, typed).toBe("execute");
      if (parsed.kind === "execute") expect(parsed.commandLine, typed).toBe(commandLine);
    }
    for (const [typed, route] of [
      ["/help", "help"],
      ["/introduction", "introduction"],
      ["/details", "details"],
      ["/allocation", "allocation"],
    ] as const) {
      const parsed = parsePanelCommand(typed);
      expect(parsed.kind, typed).toBe("route");
      if (parsed.kind === "route") expect(parsed.route, typed).toBe(route);
    }

    // Every command row the panel displays is itself a canonical command.
    for (const action of HOME_ACTIONS) {
      expect(action.label.startsWith("/"), action.label).toBe(true);
      expect(parsePanelCommand(action.label).kind, action.label).not.toBe("unknown");
    }

    // Slashless names are recognized only well enough to teach the rule.
    for (const bare of ["status", "smart-compact", "help", "allocation", "bounds 1 2"]) {
      const parsed = parsePanelCommand(bare);
      expect(parsed.kind, bare).toBe("needs_slash");
    }
    // Prose labels, case variants, and removed spellings do not execute.
    for (const rejected of [
      "Smart Compact",
      "Smart Prune",
      "Band allocation",
      "/Smart-Compact",
      "/STATUS",
      "/Help",
      "compact",
      "prune 500",
      "secret",
      "//status",
    ]) {
      const parsed = parsePanelCommand(rejected);
      expect(parsed.kind, rejected).toBe("unknown");
    }
  });

  it("answers a bare command name with the grammar rule, and never runs it", () => {
    const bare = feed(openHome(), "smart-compact\r");
    expect(executed(bare.actions)).toEqual([]);
    expect(bare.state.mode).toBe("modal");
    expect(bare.state.panelRows).toEqual(["commands start with / · try /help"]);
    const drawn = panelText(renderPanelForTest(bare.state));
    expect(drawn).toContain("commands start with / · try /help");
    // No hidden alias is echoed back as if it had worked.
    expect(drawn).not.toContain("rebuilding");
  });

  it("answers an unknown command with two short rows, not the vocabulary", () => {
    // A slash token no command starts with: nothing to complete, so Enter
    // reaches the parser and the parser answers.
    const opened = feed(openHome(), "/compact\r");
    expect(opened.state.panelRows).toEqual(["unknown command: /compact", "commands start with / · try /help"]);
    const drawn = panelText(renderPanelForTest(opened.state));
    expect(drawn).toContain("unknown command: /compact");
    expect(drawn).toContain("commands start with / · try /help");
    expect(drawn).not.toContain("Set the size after compact");
  });
});

describe("TC-3.1a Run Smart Compact", () => {
  const savedHome = process.env.CC_LHC_HOME;
  beforeEach(() => {
    mocks.captureFactory = null;
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-panel-cmd-"));
    dirs.push(home);
    process.env.CC_LHC_HOME = home;
    // TTY-shaped rigs: onboarding already shown, so the panel opens only on demand.
    markShown(firstLoadMarkerPath(home), ONBOARDING_VERSION);
  });
  afterEach(() => {
    mocks.captureFactory = null;
    if (savedHome === undefined) delete process.env.CC_LHC_HOME;
    else process.env.CC_LHC_HOME = savedHome;
    for (const dir of dirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  });

  it("smart-compact dispatches the existing manual Smart Compact exactly once", async () => {
    const parsed = feed(openHome(), "/smart-compact\r");
    expect(executed(parsed.actions)).toEqual(["/lhc-compact"]);
    expect(parsed.actions.filter((action) => action.kind === "execute")).toHaveLength(1);
    expect(parsed.state.mode).toBe("executing");
    expect(parsed.state.line).toBe("/smart-compact");

    const compact = vi.fn(async () => ({
      ok: true,
      value: {
        viewId: "v1",
        tailTokens: 5,
        totalTokens: 9,
        bands: {
          smooth: { entries: 1, tokens: 4 },
          detailed: { entries: 0, tokens: 0 },
          brief: { entries: 0, tokens: 0 },
        },
      },
    }));
    const previewCompact = vi.fn(async () => ({ ok: true, value: { kind: "ok" } }));
    const prune = vi.fn();
    const sdk = {
      drainSettled: async () => {},
      threadView: {
        compact,
        previewCompact,
        prune,
        status: vi.fn(),
        getSessionThreadView: vi.fn(async () => ({
          ok: true,
          value: { threadId: "th_cmd", entries: [] },
        })),
      },
      intakeStream: { messageEvents: async () => ({ ok: true, value: { events: [] } }) },
    } as unknown as Lhc;
    mocks.captureFactory = () => scriptedCapture(sdk);
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
    Object.defineProperty(stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(stdout, "isTTY", { value: true, configurable: true });
    Object.defineProperty(stdout, "columns", { value: 100, configurable: true });
    Object.defineProperty(stdout, "rows", { value: 30, configurable: true });
    (stdin as unknown as { setRawMode: (on: boolean) => void }).setRawMode = () => {};
    const pty = makeFakePty(4100);
    const runPromise = run([], {
      claudeBin: "fake",
      spawnPty: (() => pty) as never,
      stdin,
      stdout,
      noInference: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    (stdin as unknown as PassThrough).write(LEADER);
    await new Promise((resolve) => setTimeout(resolve, 40));
    (stdin as unknown as PassThrough).write(Buffer.from("/smart-compact\r"));
    await waitFor(
      () => previewCompact.mock.calls.length === 1 && compact.mock.calls.length === 1,
      "manual Smart Compact complete",
    );
    expect(previewCompact).toHaveBeenCalledTimes(1);
    expect(compact).toHaveBeenCalledTimes(1);
    expect(prune).not.toHaveBeenCalled();
    pty.fireExit(0);
    await runPromise;
  }, 15_000);
});

describe("TC-3.1b Run Smart Prune", () => {
  const savedHome = process.env.CC_LHC_HOME;
  beforeEach(() => {
    mocks.captureFactory = null;
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-panel-prune-"));
    dirs.push(home);
    process.env.CC_LHC_HOME = home;
    // TTY-shaped rigs: onboarding already shown, so the panel opens only on demand.
    markShown(firstLoadMarkerPath(home), ONBOARDING_VERSION);
  });
  afterEach(() => {
    mocks.captureFactory = null;
    if (savedHome === undefined) delete process.env.CC_LHC_HOME;
    else process.env.CC_LHC_HOME = savedHome;
    for (const dir of dirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  });

  it.each([
    { typed: "/smart-prune", target: undefined as number | undefined },
    { typed: "/smart-prune 2500", target: 2500 },
  ])("wrapper $typed reaches existing prune mutation exactly once", async ({ typed, target }) => {
    const parsed = feed(openHome(), `${typed}\r`);
    expect(executed(parsed.actions)).toEqual([target === undefined ? "/lhc-prune" : `/lhc-prune ${target}`]);
    const compact = vi.fn();
    const previewCompact = vi.fn();
    const prune = vi.fn(async (_ref: unknown, opts: { targetTokens?: number } = {}) => ({
      ok: true,
      value: {
        previousBoundary: 3,
        newBoundary: 3,
        zoneTokensBefore: 5,
        zoneTokensAfter: 5,
        toolResultsPruned: 0,
        noOp: true,
      },
    }));
    const sdk = {
      drainSettled: async () => {},
      threadView: {
        compact,
        previewCompact,
        prune,
        status: vi.fn(),
        getSessionThreadView: vi.fn(async () => ({
          ok: true,
          value: { threadId: "th_cmd", entries: [] },
        })),
      },
      intakeStream: { messageEvents: async () => ({ ok: true, value: { events: [] } }) },
    } as unknown as Lhc;
    mocks.captureFactory = () => scriptedCapture(sdk);
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
    Object.defineProperty(stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(stdout, "isTTY", { value: true, configurable: true });
    Object.defineProperty(stdout, "columns", { value: 100, configurable: true });
    Object.defineProperty(stdout, "rows", { value: 30, configurable: true });
    (stdin as unknown as { setRawMode: (on: boolean) => void }).setRawMode = () => {};
    const pty = makeFakePty(4101);
    const runPromise = run([], {
      claudeBin: "fake",
      spawnPty: (() => pty) as never,
      stdin,
      stdout,
      noInference: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    (stdin as unknown as PassThrough).write(LEADER);
    await new Promise((resolve) => setTimeout(resolve, 40));
    (stdin as unknown as PassThrough).write(Buffer.from(`${typed}\r`));
    await waitFor(() => prune.mock.calls.length === 1, "prune mutation");
    expect(prune).toHaveBeenCalledTimes(1);
    const passed = prune.mock.calls[0]?.[1] as { targetTokens?: number };
    if (target === undefined) expect(passed ?? {}).toEqual({});
    else expect(passed).toEqual({ targetTokens: target });
    expect(compact).not.toHaveBeenCalled();
    expect(previewCompact).not.toHaveBeenCalled();
    pty.fireExit(0);
    await runPromise;
  }, 15_000);
});

describe("TC-3.1c Removed spellings stay removed", () => {
  const savedHome = process.env.CC_LHC_HOME;
  beforeEach(() => {
    mocks.captureFactory = null;
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-panel-unknown-"));
    dirs.push(home);
    process.env.CC_LHC_HOME = home;
    // TTY-shaped rigs: onboarding already shown, so the panel opens only on demand.
    markShown(firstLoadMarkerPath(home), ONBOARDING_VERSION);
  });
  afterEach(() => {
    mocks.captureFactory = null;
    if (savedHome === undefined) delete process.env.CC_LHC_HOME;
    else process.env.CC_LHC_HOME = savedHome;
    for (const dir of dirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  });

  it("compact and prune return unknown and invoke zero mutation calls", async () => {
    const compact = vi.fn();
    const previewCompact = vi.fn();
    const prune = vi.fn();
    const sdk = {
      drainSettled: async () => {},
      threadView: { compact, previewCompact, prune, status: vi.fn() },
      intakeStream: { messageEvents: async () => ({ ok: true, value: { events: [] } }) },
    } as unknown as Lhc;
    mocks.captureFactory = () => scriptedCapture(sdk);
    const guard = new CommandInFlightGuard();
    const acquire = vi.spyOn(guard, "tryAcquire");
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
    Object.defineProperty(stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(stdout, "isTTY", { value: true, configurable: true });
    Object.defineProperty(stdout, "columns", { value: 100, configurable: true });
    Object.defineProperty(stdout, "rows", { value: 30, configurable: true });
    (stdin as unknown as { setRawMode: (on: boolean) => void }).setRawMode = () => {};
    let out = "";
    (stdout as unknown as PassThrough).on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    const pty = makeFakePty(4102);
    const runPromise = run([], {
      claudeBin: "fake",
      spawnPty: (() => pty) as never,
      stdin,
      stdout,
      noInference: true,
      commandGuard: guard,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    (stdin as unknown as PassThrough).write(LEADER);
    await new Promise((resolve) => setTimeout(resolve, 40));
    (stdin as unknown as PassThrough).write(Buffer.from("compact\r"));
    await waitFor(() => out.includes("unknown command: compact"), "compact unknown");
    (stdin as unknown as PassThrough).write(Buffer.from("prune\r"));
    await waitFor(() => out.includes("unknown command: prune"), "prune unknown");
    (stdin as unknown as PassThrough).write(Buffer.from("prune 500\r"));
    await waitFor(() => out.includes("unknown command: prune 500"), "prune 500 unknown");
    expect(acquire).not.toHaveBeenCalled();
    expect(compact).not.toHaveBeenCalled();
    expect(previewCompact).not.toHaveBeenCalled();
    expect(prune).not.toHaveBeenCalled();
    pty.fireExit(0);
    await runPromise;
  }, 15_000);
});

describe("work in flight on Home", () => {
  const savedHome = process.env.CC_LHC_HOME;
  beforeEach(() => {
    mocks.captureFactory = null;
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-panel-inflight-"));
    dirs.push(home);
    process.env.CC_LHC_HOME = home;
    // TTY-shaped rigs: onboarding already shown, so the panel opens only on demand.
    markShown(firstLoadMarkerPath(home), ONBOARDING_VERSION);
  });
  afterEach(() => {
    mocks.captureFactory = null;
    if (savedHome === undefined) delete process.env.CC_LHC_HOME;
    else process.env.CC_LHC_HOME = savedHome;
    for (const dir of dirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  });

  it("shows the automatic operation as its command, never the internal guard label", async () => {
    const sdk = {
      drainSettled: async () => {},
      threadView: { compact: vi.fn(), previewCompact: vi.fn(), prune: vi.fn(), status: vi.fn() },
      intakeStream: { messageEvents: async () => ({ ok: true, value: { events: [] } }) },
    } as unknown as Lhc;
    mocks.captureFactory = () => scriptedCapture(sdk);
    // The automatic path holds the guard under its internal label while it
    // runs; this is exactly the state Home renders during an auto compaction.
    const guard = new CommandInFlightGuard();
    expect(guard.tryAcquire("auto-compact", Date.now())).toBe(true);
    expect(guard.current()?.label).toBe("auto-compact");

    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
    Object.defineProperty(stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(stdout, "isTTY", { value: true, configurable: true });
    Object.defineProperty(stdout, "columns", { value: 100, configurable: true });
    Object.defineProperty(stdout, "rows", { value: 29, configurable: true });
    (stdin as unknown as { setRawMode: (on: boolean) => void }).setRawMode = () => {};
    let out = "";
    (stdout as unknown as PassThrough).on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    const pty = makeFakePty(4105);
    const runPromise = run([], {
      claudeBin: "fake",
      spawnPty: (() => pty) as never,
      stdin,
      stdout,
      noInference: true,
      commandGuard: guard,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    (stdin as unknown as PassThrough).write(LEADER);
    await waitFor(() => panelText(out).includes("active operation:"), "in-flight notice on Home");
    expect(panelText(out)).toContain("active operation: /smart-compact");
    // The window row legitimately names "Claude native auto-compact"; the guard's bare label never appears.
    expect(panelText(out), "the guard's internal label reached Home").not.toMatch(/(?<!native )auto-compact/);

    // Details reports the same operation the same way.
    (stdin as unknown as PassThrough).write(Buffer.from("/details\r"));
    await waitFor(() => panelText(out).includes("Operation"), "details operation row");
    expect(panelText(out)).toContain("Operation /smart-compact");
    expect(panelText(out)).not.toMatch(/(?<!native )auto-compact/);

    (stdin as unknown as PassThrough).write(Buffer.from([DEFAULT_LEADER_BYTE]));
    pty.fireExit(0);
    await runPromise;
  }, 15_000);
});

describe("TC-3.2a Reject invalid target", () => {
  const savedHome = process.env.CC_LHC_HOME;
  beforeEach(() => {
    mocks.captureFactory = null;
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-panel-invalid-"));
    dirs.push(home);
    process.env.CC_LHC_HOME = home;
    // TTY-shaped rigs: onboarding already shown, so the panel opens only on demand.
    markShown(firstLoadMarkerPath(home), ONBOARDING_VERSION);
  });
  afterEach(() => {
    mocks.captureFactory = null;
    if (savedHome === undefined) delete process.env.CC_LHC_HOME;
    else process.env.CC_LHC_HOME = savedHome;
    for (const dir of dirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  });

  it("zero/negative/fractional/overflow/nonnumeric/extra arguments fail before command guard and mutation", async () => {
    const compact = vi.fn();
    const previewCompact = vi.fn();
    const prune = vi.fn();
    const sdk = {
      drainSettled: async () => {},
      threadView: { compact, previewCompact, prune, status: vi.fn() },
      intakeStream: { messageEvents: async () => ({ ok: true, value: { events: [] } }) },
    } as unknown as Lhc;
    mocks.captureFactory = () => scriptedCapture(sdk);
    const guard = new CommandInFlightGuard();
    const acquire = vi.spyOn(guard, "tryAcquire");
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
    Object.defineProperty(stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(stdout, "isTTY", { value: true, configurable: true });
    Object.defineProperty(stdout, "columns", { value: 120, configurable: true });
    Object.defineProperty(stdout, "rows", { value: 40, configurable: true });
    (stdin as unknown as { setRawMode: (on: boolean) => void }).setRawMode = () => {};
    let out = "";
    (stdout as unknown as PassThrough).on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    const pty = makeFakePty(4103);
    const runPromise = run([], {
      claudeBin: "fake",
      spawnPty: (() => pty) as never,
      stdin,
      stdout,
      noInference: true,
      commandGuard: guard,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    (stdin as unknown as PassThrough).write(LEADER);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const cases = [
      "/smart-prune 0",
      "/smart-prune -1",
      "/smart-prune 1.5",
      "/smart-prune 9007199254740993",
      "/smart-prune lots",
      "/smart-prune 12 34",
    ];
    for (const line of cases) {
      const before = out.length;
      (stdin as unknown as PassThrough).write(Buffer.from(`${line}\r`));
      await waitFor(() => out.slice(before).includes("invalid /smart-prune target"), line);
      expect(out.slice(before)).toContain("invalid /smart-prune target");
    }
    expect(acquire).not.toHaveBeenCalled();
    expect(compact).not.toHaveBeenCalled();
    expect(previewCompact).not.toHaveBeenCalled();
    expect(prune).not.toHaveBeenCalled();
    pty.fireExit(0);
    await runPromise;
  }, 15_000);
});

describe("manual mutation last attempt", () => {
  const savedHome = process.env.CC_LHC_HOME;
  beforeEach(() => {
    mocks.captureFactory = null;
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-panel-last-attempt-"));
    dirs.push(home);
    process.env.CC_LHC_HOME = home;
    // TTY-shaped rigs: onboarding already shown, so the panel opens only on demand.
    markShown(firstLoadMarkerPath(home), ONBOARDING_VERSION);
  });
  afterEach(() => {
    mocks.captureFactory = null;
    if (savedHome === undefined) delete process.env.CC_LHC_HOME;
    else process.env.CC_LHC_HOME = savedHome;
    for (const dir of dirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  });

  it("/smart-compact without handoff records last attempt with the visible slash command", async () => {
    const compact = vi.fn();
    const previewCompact = vi.fn();
    const prune = vi.fn();
    const sdk = {
      drainSettled: async () => {},
      threadView: { compact, previewCompact, prune, status: vi.fn() },
      intakeStream: { messageEvents: async () => ({ ok: true, value: { events: [] } }) },
    } as unknown as Lhc;
    mocks.captureFactory = () => {
      const session = scriptedCapture(sdk);
      session.isTurnOpen = () => true;
      return session;
    };
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
    Object.defineProperty(stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(stdout, "isTTY", { value: true, configurable: true });
    Object.defineProperty(stdout, "columns", { value: 120, configurable: true });
    Object.defineProperty(stdout, "rows", { value: 40, configurable: true });
    (stdin as unknown as { setRawMode: (on: boolean) => void }).setRawMode = () => {};
    let out = "";
    (stdout as unknown as PassThrough).on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    const pty = makeFakePty(4104);
    const runPromise = run([], {
      claudeBin: "fake",
      spawnPty: (() => pty) as never,
      stdin,
      stdout,
      noInference: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    (stdin as unknown as PassThrough).write(LEADER);
    await new Promise((resolve) => setTimeout(resolve, 40));
    (stdin as unknown as PassThrough).write(Buffer.from("/smart-compact\r"));
    // A failed attempt is non-default state: it stays on Home, as a notice.
    await waitFor(
      () => panelText(out).includes("last attempt: manual /smart-compact did not hand off:"),
      "home last attempt",
    );
    expect(panelText(out)).toMatch(/! last attempt: manual \/smart-compact did not hand off: turn in progress/);
    expect(compact).not.toHaveBeenCalled();
    expect(previewCompact).not.toHaveBeenCalled();
    pty.fireExit(0);
    await runPromise;
  }, 15_000);
});
