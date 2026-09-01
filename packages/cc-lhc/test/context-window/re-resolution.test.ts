/**
 * LIM-144 Pass A production path: `run()` launches a real child argv with one
 * merged `--settings` status-line observer, reads the documented payload back,
 * and re-resolves the policy before the next governor decision (TC-1.1a/b,
 * TC-1.4a/b/c, TC-1.5b, D8 fallback). Same harness shape as auto-handoff.
 */
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { Lhc } from "lhc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GovernorObserveRecord } from "../../src/governor/index.js";
import type { CaptureSession, CaptureSessionDeps } from "../../src/intake/session.js";
import type { LifecycleSignal } from "../../src/observation/types.js";
import * as writeRebuilt from "../../src/rollout/write-rebuilt.js";
import { emptyCaptureStats } from "../../src/stats.js";
import type { HandoffResult } from "../../src/wrapper/handoff.js";
import { run } from "../../src/wrapper/run.js";

const mocks = vi.hoisted(() => ({
  captureFactory: null as ((opts: CaptureSessionDeps) => CaptureSession) | null,
}));

vi.mock("../../src/intake/session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/intake/session.js")>();
  return {
    ...actual,
    startCaptureSession: (opts: CaptureSessionDeps = {}) =>
      mocks.captureFactory !== null ? mocks.captureFactory(opts) : actual.startCaptureSession(opts),
  };
});

vi.mock("../../src/commands/rebuild-receipt.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/commands/rebuild-receipt.js")>();
  return { ...actual, registerRebuiltSessionLineage: async () => ({ ok: true as const }) };
});

const REBUILT_ID = "12345678-1234-1234-1234-123456789abc";

interface FakePty {
  pid: number;
  args: string[];
  env: Record<string, string>;
  fireExit(code: number, signal?: number): void;
  onData(cb: (data: string) => void): { dispose(): void };
  onExit(cb: (arg: { exitCode: number; signal?: number }) => void): { dispose(): void };
  kill(signal?: string): void;
  write(data: string): void;
  resize(): void;
}

function makeFakePty(pid: number, args: string[], env: Record<string, string>): FakePty {
  const exitCbs: Array<(arg: { exitCode: number; signal?: number }) => void> = [];
  const dataCbs: Array<(data: string) => void> = [];
  const fake: FakePty = {
    pid,
    args,
    env,
    fireExit(code, signal) {
      for (const cb of exitCbs) cb({ exitCode: code, ...(signal === undefined ? {} : { signal }) });
    },
    onData(cb) {
      dataCbs.push(cb);
      setTimeout(() => {
        for (const dataCb of dataCbs) dataCb("render\r\n");
      }, 30);
      return { dispose() {} };
    },
    onExit(cb) {
      exitCbs.push(cb);
      return { dispose() {} };
    },
    kill(signal) {
      setImmediate(() => fake.fireExit(0, signal === "SIGKILL" ? 9 : 15));
    },
    write() {},
    resize() {},
  };
  return fake;
}

function sdkForCapture() {
  return {
    drainSettled: async () => {},
    threadView: {
      status: vi.fn(async () => ({
        ok: true,
        value: {
          tailTokens: 10,
          threshold: 100,
          visibility: { zoneTokens: 0, maxTokens: 1000 },
          derivation: { pending: 0, failed: 0 },
        },
      })),
      previewCompact: vi.fn(async () => ({ ok: true, value: { kind: "ok" } })),
      compact: vi.fn(async () => ({
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
      })),
      prune: vi.fn(),
      getSessionThreadView: vi.fn(async () => ({
        ok: true,
        value: { threadId: "th_cw", entries: [{ role: "user", content: "hi", sourceMessages: [] }] },
      })),
    },
    intakeStream: { messageEvents: async () => ({ ok: true, value: { events: [] } }) },
  };
}

function scriptedCaptureSession(
  sdk: unknown,
  sessionId: string,
  rolloutPath: string,
  generation: number,
): CaptureSession {
  const stats = { ...emptyCaptureStats(), threadId: "th_cw" };
  return {
    stats,
    getCommandContext: () => ({
      stats,
      sdk: sdk as Lhc,
      threadRef: { threadId: "th_cw", registryPath: "/tmp/reg.sqlite" },
      captureDegraded: false,
      captureGeneration: generation,
      capturePhase: "ready" as const,
    }),
    getRolloutInfo: () => ({ path: rolloutPath, sessionId }),
    isTurnOpen: () => false,
    isCaptureHealthy: () => true,
    isCaptureReady: () => true,
    getCaptureHealth: () => ({
      generation,
      phase: "ready" as const,
      reasons: [],
      reasonCounts: {},
      durableLineOffset: 0,
    }),
    getCaptureGeneration: () => generation,
    getLiveAsyncWork: () => [],
    stop: vi.fn(async () => {}),
  } as unknown as CaptureSession;
}

function fakeStream(): NodeJS.ReadStream & NodeJS.WriteStream {
  const stream = new PassThrough() as unknown as NodeJS.ReadStream & NodeJS.WriteStream;
  Object.defineProperty(stream, "isTTY", { value: false, configurable: true });
  Object.defineProperty(stream, "columns", { value: 80, configurable: true });
  Object.defineProperty(stream, "rows", { value: 24, configurable: true });
  return stream;
}

async function waitFor(condition: () => boolean, label: string, capMs = 8_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > capMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function settingsIn(args: readonly string[]): { count: number; settings: Record<string, unknown> | null } {
  const count = args.filter((a) => a === "--settings" || a.startsWith("--settings=")).length;
  const at = args.indexOf("--settings");
  return { count, settings: at >= 0 ? (JSON.parse(args[at + 1]!) as Record<string, unknown>) : null };
}

/** The session selector the launch grammar chose: `--resume` or `--session-id`. */
function resumeIdIn(args: readonly string[]): string {
  const at = args.indexOf("--resume") >= 0 ? args.indexOf("--resume") : args.indexOf("--session-id");
  return args[at + 1]!;
}

const payload = (session: string, size: number, model: string): string =>
  `${JSON.stringify({ session_id: session, model: { id: model }, context_window: { context_window_size: size } })}\n`;

function settledAt(total: number, id: string): LifecycleSignal[] {
  return [
    { kind: "turn_opened", reason: "user_prompt" },
    {
      kind: "sampling_observed",
      samplingId: id,
      providerUsage: { input_tokens: total, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    { kind: "turn_settled", reason: "end_turn" },
  ];
}

interface Rig {
  spawned: FakePty[];
  observes: GovernorObserveRecord[];
  results: HandoffResult[];
  capturePath: string;
  lifecycle: (signals: readonly LifecycleSignal[]) => void;
  runPromise: Promise<number>;
  logs: string[];
  cleanup: () => void;
}

async function startRig(
  argv: string[],
  options: { overrides?: Record<string, number>; childPlatform?: NodeJS.Platform } = {},
): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), "cc-lhc-cw-rig-"));
  const capturePath = join(dir, "capture.jsonl");
  const sdk = sdkForCapture();
  const spawned: FakePty[] = [];
  const observes: GovernorObserveRecord[] = [];
  const results: HandoffResult[] = [];
  const logs: string[] = [];
  let lifecycle: ((signals: readonly LifecycleSignal[]) => void) | undefined;
  const rebuiltPath = join(dir, `${REBUILT_ID}.jsonl`);
  const writeSpy = vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockImplementation(async () => {
    const content = '{"line":1}\n{"line":2}\n{"line":3}\n';
    writeFileSync(rebuiltPath, content);
    return {
      sessionId: REBUILT_ID,
      rolloutPath: rebuiltPath,
      lineCount: 3,
      expectedReintakeLines: 3,
      replayedPrefixLines: 2,
      prefixBoundary: { kind: "verified", lineCount: 2, byteLength: 40, sha256: "aa".repeat(32) },
      totalByteLength: Buffer.byteLength(content),
    };
  });
  let generation = 0;
  mocks.captureFactory = (opts) => {
    generation += 1;
    const isRebuilt = opts.knownRolloutPath !== undefined;
    if (!isRebuilt && opts.onLifecycle !== undefined) lifecycle = opts.onLifecycle;
    return scriptedCaptureSession(
      sdk,
      isRebuilt ? REBUILT_ID : "old-session",
      isRebuilt ? opts.knownRolloutPath! : "/tmp/old.jsonl",
      generation,
    );
  };
  const runPromise = run(argv, {
    claudeBin: "fake-claude",
    spawnPty: ((_file: string, args: string[], opts: { env: Record<string, string> }) => {
      const fake = makeFakePty(7000 + spawned.length, args, opts.env);
      spawned.push(fake);
      return fake as never;
    }) as never,
    stdin: fakeStream(),
    stdout: fakeStream() as never,
    stderr: fakeStream() as never,
    noInference: true,
    ...(options.overrides === undefined ? {} : { contextPolicyOverrides: options.overrides }),
    ...(options.childPlatform === undefined ? {} : { childPlatform: options.childPlatform }),
    contextWindowCapturePath: capturePath,
    governorReceiptDbPath: join(dir, "receipts.sqlite"),
    onGovernorObserve: (record) => observes.push(record),
    onHandoffResult: (result) => results.push(result),
    wrapperLog: {
      info: (m: string) => logs.push(m),
      warn: (m: string) => logs.push(m),
      warningCount: () => 0,
      path: join(dir, "wrapper.log"),
    } as never,
    handoffTimeouts: {
      sigtermGraceMs: 300,
      sigkillWaitMs: 200,
      captureReadyTimeoutMs: 2_000,
      childLivenessTimeoutMs: 3_000,
      childStableWindowMs: 50,
    },
  });
  await waitFor(() => lifecycle !== undefined && spawned.length === 1, "first child and lifecycle sink");
  lifecycle!([{ kind: "session_bound", sessionId: "old-session" }]);
  return {
    spawned,
    observes,
    results,
    capturePath,
    lifecycle: (signals) => lifecycle!(signals),
    runPromise,
    logs,
    cleanup: () => {
      writeSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("run(): launch-scoped context-window observer on the real child argv", () => {
  const saved = {
    home: process.env.CC_LHC_HOME,
    xdg: process.env.XDG_CONFIG_HOME,
    claude: process.env.CLAUDE_CONFIG_DIR,
  };
  const dirs: string[] = [];
  beforeEach(() => {
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-cw-home-"));
    const xdg = mkdtempSync(join(tmpdir(), "cc-lhc-cw-xdg-"));
    const claude = mkdtempSync(join(tmpdir(), "cc-lhc-cw-claude-"));
    dirs.push(home, xdg, claude);
    process.env.CC_LHC_HOME = home;
    process.env.XDG_CONFIG_HOME = xdg;
    process.env.CLAUDE_CONFIG_DIR = claude;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    mocks.captureFactory = null;
    for (const [key, value] of [
      ["CC_LHC_HOME", saved.home],
      ["XDG_CONFIG_HOME", saved.xdg],
      ["CLAUDE_CONFIG_DIR", saved.claude],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("forwards exactly one merged --settings that chains the operator's argv status line (D8)", async () => {
    const operator = { statusLine: { type: "command", command: "my-status", padding: 1 }, env: { LIM144: "argv" } };
    const rig = await startRig(["--settings", JSON.stringify(operator), "--model", "haiku"]);
    try {
      const args = rig.spawned[0]!.args;
      const { count, settings } = settingsIn(args);
      expect(count).toBe(1);
      expect(settings?.statusLine).toEqual({
        type: "command",
        command: `tee -a '${rig.capturePath}' | my-status`,
        padding: 1,
      });
      expect(settings?.env).toEqual({ LIM144: "argv" });
      expect(args.some((a) => a === "--resume" || a === "--session-id")).toBe(true);
      expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual(["--model", "haiku"]);
      expect(args.filter((a) => a === "--model")).toHaveLength(1);
      expect(rig.logs.some((l) => l.includes("observer installed") && l.includes("preserved (launch argv)"))).toBe(
        true,
      );
    } finally {
      rig.spawned[0]!.fireExit(0);
      await rig.runPromise;
      rig.cleanup();
    }
  });

  it("never writes the operator's status-line command to the wrapper log", async () => {
    const secret = "sk-lim144-SECRET-9f3a";
    const command = `curl -s -H 'Authorization: Bearer ${secret}' https://status.example.invalid/line`;
    const rig = await startRig(["--settings", JSON.stringify({ statusLine: { type: "command", command } })]);
    try {
      // The child must still receive the exact command — that is preservation.
      const { settings } = settingsIn(rig.spawned[0]!.args);
      expect((settings?.statusLine as { command: string }).command).toBe(`tee -a '${rig.capturePath}' | ${command}`);
      // The wrapper log states only that a status line was preserved and where.
      const log = rig.logs.join("\n");
      expect(log).toContain("operator status line preserved (launch argv)");
      for (const fragment of [secret, "Authorization", "curl", "status.example.invalid"]) {
        expect(log, fragment).not.toContain(fragment);
      }
    } finally {
      rig.spawned[0]!.fireExit(0);
      await rig.runPromise;
      rig.cleanup();
    }
  });

  it("logs a settings-file origin path, never the file's command", async () => {
    const settingsPath = join(process.env.CLAUDE_CONFIG_DIR!, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({ statusLine: { type: "command", command: "token-status --key hunter2-LIM144" } }),
    );
    const rig = await startRig(["--model", "haiku"]);
    try {
      const log = rig.logs.join("\n");
      expect(log).toContain(`operator status line preserved (settings file ${settingsPath})`);
      expect(log).not.toContain("hunter2-LIM144");
      expect(log).not.toContain("token-status");
    } finally {
      rig.spawned[0]!.fireExit(0);
      await rig.runPromise;
      rig.cleanup();
    }
  });

  it("win32: serializes the Git Bash chain on the real child argv and refuses a PowerShell status line truthfully", async () => {
    const operator = { statusLine: { type: "command", command: "my-status.exe --short", padding: 0 } };
    const rig = await startRig(["--settings", JSON.stringify(operator), "--model", "haiku"], {
      childPlatform: "win32",
    });
    try {
      const { count, settings } = settingsIn(rig.spawned[0]!.args);
      expect(count).toBe(1);
      expect((settings?.statusLine as { command: string }).command).toBe(
        `tee -a '${rig.capturePath}' | my-status.exe --short`,
      );
      expect(rig.logs.some((l) => l.includes("preserved (launch argv)"))).toBe(true);
    } finally {
      rig.spawned[0]!.fireExit(0);
      await rig.runPromise;
      rig.cleanup();
    }

    const ps = { statusLine: { type: "command", command: "Get-Status", shell: "powershell" } };
    const psArgv = ["--settings", JSON.stringify(ps), "--model", "haiku"];
    const rig2 = await startRig(psArgv, { childPlatform: "win32" });
    try {
      const args = rig2.spawned[0]!.args;
      expect(args.filter((a) => a === "--settings")).toHaveLength(1);
      expect(args[args.indexOf("--settings") + 1]).toBe(JSON.stringify(ps));
      rig2.lifecycle(settledAt(100_000, "req:ps"));
      await waitFor(() => rig2.observes.length >= 1, "governor observe");
      expect(rig2.observes.at(-1)).toMatchObject({
        contextClass: "200k",
        contextWindowSource: "detection_unavailable",
      });
      expect(rig2.logs.some((l) => l.includes("runs under PowerShell"))).toBe(true);
    } finally {
      rig2.spawned[0]!.fireExit(0);
      await rig2.runPromise;
      rig2.cleanup();
    }
  }, 15_000);

  it("chains the operator's Claude settings-file status line when argv carries none", async () => {
    writeFileSync(
      join(process.env.CLAUDE_CONFIG_DIR!, "settings.json"),
      JSON.stringify({ statusLine: { type: "command", command: "file-status" } }),
    );
    const rig = await startRig(["--model", "haiku"]);
    try {
      const { count, settings } = settingsIn(rig.spawned[0]!.args);
      expect(count).toBe(1);
      expect((settings?.statusLine as { command: string }).command).toBe(`tee -a '${rig.capturePath}' | file-status`);
    } finally {
      rig.spawned[0]!.fireExit(0);
      await rig.runPromise;
      rig.cleanup();
    }
  });

  it("leaves an unmergeable --settings verbatim, reports detection unavailable, and uses 200k (TC-1.1d)", async () => {
    const rig = await startRig(["--settings", "/nonexistent/settings.json"]);
    try {
      const args = rig.spawned[0]!.args;
      expect(args.filter((a) => a === "--settings")).toHaveLength(1);
      expect(args[args.indexOf("--settings") + 1]).toBe("/nonexistent/settings.json");
      rig.lifecycle(settledAt(100_000, "req:1"));
      await waitFor(() => rig.observes.length >= 1, "governor observe");
      const record = rig.observes.at(-1)!;
      expect(record.contextClass).toBe("200k");
      expect(record.contextWindowSource).toBe("detection_unavailable");
      expect(record.upperBoundTokens).toBe(140_000);
      expect(record.lowerBoundTokens).toBe(70_000);
      expect(record.decision).toBe("below_threshold");
      expect(rig.logs.some((l) => l.includes("(settings unmergeable)") && l.includes("settings file unreadable"))).toBe(
        true,
      );
    } finally {
      rig.spawned[0]!.fireExit(0);
      await rig.runPromise;
      rig.cleanup();
    }
  });

  it("re-resolves 1M -> 200k from the observed payload before the next decision, keeps the explicit session value, and installs the observer on the replacement (TC-1.4a/c, TC-1.5b)", async () => {
    const rig = await startRig([], { overrides: { lowerBoundTokens: 50_000 } });
    try {
      const sessionId = resumeIdIn(rig.spawned[0]!.args);
      expect(settingsIn(rig.spawned[0]!.args).count).toBe(1);

      // Nothing observed yet: conservative 200k with the explicit target kept.
      rig.lifecycle(settledAt(10_000, "req:0"));
      await waitFor(() => rig.observes.length >= 1, "first observe");
      expect(rig.observes.at(-1)).toMatchObject({
        contextClass: "200k",
        contextWindowSource: "not_yet_observed",
        upperBoundTokens: 140_000,
        lowerBoundTokens: 50_000,
      });

      // The child renders its status line: a 1M window. 150k is below 360k.
      appendFileSync(rig.capturePath, payload(sessionId, 1_000_000, "claude-opus-5"));
      rig.lifecycle(settledAt(150_000, "req:1"));
      await waitFor(() => rig.observes.length >= 2, "1M observe");
      expect(rig.observes.at(-1)).toMatchObject({
        contextClass: "1M",
        contextWindowSource: "observed",
        upperBoundTokens: 360_000,
        lowerBoundTokens: 50_000,
        decision: "below_threshold",
      });
      expect(rig.results).toHaveLength(0);

      // /model to a 200k route: the same 150k is now over the 140k trigger,
      // and the re-resolution lands before this settled decision.
      appendFileSync(rig.capturePath, payload(sessionId, 200_000, "claude-haiku-4-5-20251001"));
      rig.lifecycle(settledAt(150_000, "req:2"));
      await waitFor(() => rig.results.length === 1, "automatic Smart Compact");
      const decision = rig.observes.find((o) => o.wouldMutate);
      expect(decision).toMatchObject({
        contextClass: "200k",
        contextWindowSource: "observed",
        upperBoundTokens: 140_000,
        lowerBoundTokens: 50_000,
      });
      expect(rig.results[0]!.kind).toBe("success");

      // The replacement child carries its own merged observer payload and its
      // payloads are accepted under the rebuilt session id.
      await waitFor(() => rig.spawned.length === 2, "replacement child");
      const replacement = rig.spawned[1]!.args;
      expect(settingsIn(replacement).count).toBe(1);
      expect((settingsIn(replacement).settings?.statusLine as { command: string }).command).toContain(rig.capturePath);
      expect(resumeIdIn(replacement)).toBe(REBUILT_ID);
      expect(rig.logs.filter((l) => l.includes("observer installed"))).toHaveLength(2);
      expect(rig.logs.some((l) => l.includes("window=1M (observed 1000000 claude-opus-5)"))).toBe(true);
      expect(rig.logs.some((l) => l.includes("window=200k (observed 200000 claude-haiku-4-5-20251001)"))).toBe(true);
      expect(rig.logs.some((l) => l.includes("policy_disabled"))).toBe(false);
    } finally {
      for (const child of rig.spawned) child.fireExit(0);
      await rig.runPromise;
      rig.cleanup();
    }
  }, 15_000);
});
