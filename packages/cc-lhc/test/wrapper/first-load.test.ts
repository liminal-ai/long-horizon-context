/**
 * AC-3.7b–e: the one-time and actionable first-load Control Panel on the real
 * managed launch path. Disposable homes, fake PTYs with a TTY-shaped terminal,
 * real run().
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { Lhc } from "lhc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CaptureSession, CaptureSessionDeps } from "../../src/intake/session.js";
import { emptyCaptureStats } from "../../src/stats.js";
import {
  ACTIONABLE_KINDS,
  actionableGuidanceRows,
  firstLoadGuidanceRows,
  firstLoadMarkerPath,
  formatLeaderKey,
  isActionableKind,
  markShown,
  ONBOARDING_VERSION,
  planStartupPanel,
  readShownVersion,
} from "../../src/wrapper/first-load.js";
import { DEFAULT_LEADER_BYTE } from "../../src/wrapper/modal.js";
import { PANEL_TITLE } from "../../src/wrapper/panel-commands.js";
import { run } from "../../src/wrapper/run.js";
import { panelText } from "../helpers/panel-text.js";

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

const ESC = "\x1b";
const ALT_SCREEN_ENTER = `${ESC}[?1049h`;
const ALT_SCREEN_LEAVE = `${ESC}[?1049l`;
const FACTS = {
  targetTokens: 70_000,
  triggerTokens: 140_000,
  contextClass: "200k" as const,
  nativeAutoCompact: "disabled" as const,
  leaderByte: DEFAULT_LEADER_BYTE,
};

describe("first-load marker and allowlist (pure)", () => {
  it("reads only a well-formed shown version; a missing, torn, or foreign file is not shown", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-first-load-"));
    const path = firstLoadMarkerPath(dir);
    expect(readShownVersion(path)).toBeNull();
    markShown(path, 3);
    expect(readShownVersion(path)).toBe(3);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ shownVersion: 3 });
    writeFileSync(path, '{"shownVersion": 1');
    expect(readShownVersion(path)).toBeNull();
    writeFileSync(path, '{"shownVersion": "1"}');
    expect(readShownVersion(path)).toBeNull();
    writeFileSync(path, "[]");
    expect(readShownVersion(path)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it("names the reopen key the way the operator types it", () => {
    expect(formatLeaderKey(DEFAULT_LEADER_BYTE)).toBe("ctrl-]");
    expect(formatLeaderKey(0x01)).toBe("ctrl-a");
    expect(formatLeaderKey(0x1f)).toBe("ctrl-_");
  });

  it("TC-3.7e: the allowlist is closed to the five durable conditions; routine kinds never qualify", () => {
    expect([...ACTIONABLE_KINDS].sort()).toEqual(
      [
        "native_auto_compact_conflict",
        "unsafe_capture_or_database_state",
        "repeated_replacement_failure",
        "possible_undelivered_input",
        "unmanageable_async_identity",
      ].sort(),
    );
    for (const routine of [
      "routine_status",
      "operation_succeeded",
      "token_count",
      "active_work",
      "context_class_changed",
      "warning",
      "",
    ]) {
      expect(isActionableKind(routine), routine).toBe(false);
    }
    const shown = planStartupPanel({
      shownVersion: ONBOARDING_VERSION,
      version: ONBOARDING_VERSION,
      facts: FACTS,
      conditions: [],
    });
    expect(shown).toEqual({ open: false, firstLoad: false, rows: [] });
  });

  it("guidance is concise and prioritized: undelivered input first, native conflict last, each kind once", () => {
    const rows = actionableGuidanceRows([
      { kind: "native_auto_compact_conflict", lines: ["n1"] },
      { kind: "repeated_replacement_failure", lines: ["r1", "r2"] },
      { kind: "possible_undelivered_input", lines: ["u1"] },
      { kind: "possible_undelivered_input", lines: ["u2"] },
    ]);
    expect(rows).toEqual([
      "! input may not have reached Claude — resend what you typed",
      "u1",
      "u2",
      "! Smart Compact replacements keep failing — the automatic child swap is stopped",
      "r1",
      "r2",
      "! Claude native auto-compact may run before Smart Compact on this launch",
      "n1",
    ]);
  });

  it("TC-3.7b/c: onboarding opens once per version; a newer version reopens; actionable conditions open regardless", () => {
    const first = planStartupPanel({ shownVersion: null, version: 1, facts: FACTS, conditions: [] });
    expect(first.open).toBe(true);
    expect(first.firstLoad).toBe(true);
    expect(first.rows).toEqual(firstLoadGuidanceRows(FACTS));
    expect(first.rows.join("\n")).toContain("target 70k after /smart-compact · trigger 140k · window 200k");
    expect(first.rows.join("\n")).toContain("Claude native auto-compact off");
    expect(first.rows.join("\n")).toContain("reopen this panel any time with ctrl-] · press Esc to continue to Claude");
    expect(planStartupPanel({ shownVersion: 1, version: 1, facts: FACTS, conditions: [] }).open).toBe(false);
    expect(planStartupPanel({ shownVersion: 1, version: 2, facts: FACTS, conditions: [] }).firstLoad).toBe(true);
    const actionable = planStartupPanel({
      shownVersion: 1,
      version: 1,
      facts: FACTS,
      conditions: [{ kind: "native_auto_compact_conflict", lines: ["advisory"] }],
    });
    expect(actionable).toEqual({
      open: true,
      firstLoad: false,
      rows: ["! Claude native auto-compact may run before Smart Compact on this launch", "advisory"],
    });
    // The values come from the facts handed in, not from constants.
    const oneM = firstLoadGuidanceRows({ ...FACTS, targetTokens: 180_000, triggerTokens: 360_000, contextClass: "1M" });
    expect(oneM.join("\n")).toContain("target 180k after /smart-compact · trigger 360k · window 1M");
  });
});

// ---------------------------------------------------------------------------
// Production path
// ---------------------------------------------------------------------------

interface FakePty {
  args: string[];
  written: string[];
  emit(data: string): void;
  fireExit(code: number): void;
  onData(cb: (data: string) => void): { dispose(): void };
  onExit(cb: (arg: { exitCode: number; signal?: number }) => void): { dispose(): void };
  kill(signal?: string): void;
  write(data: string): void;
  resize(): void;
}

function makeFakePty(args: string[]): FakePty {
  const exitCbs: Array<(arg: { exitCode: number; signal?: number }) => void> = [];
  const dataCbs: Array<(data: string) => void> = [];
  const written: string[] = [];
  return {
    args,
    written,
    emit(data) {
      for (const cb of dataCbs) cb(data);
    },
    fireExit(code) {
      for (const cb of exitCbs) cb({ exitCode: code });
    },
    onData: (cb) => {
      dataCbs.push(cb);
      return { dispose: () => {} };
    },
    onExit: (cb) => {
      exitCbs.push(cb);
      return { dispose: () => {} };
    },
    kill: () => {},
    write: (data) => {
      written.push(data);
    },
    resize: () => {},
  };
}

function scriptedCaptureSession(): CaptureSession {
  const stats = { ...emptyCaptureStats(), threadId: "th_first" };
  const sdk = { drainSettled: async () => {} };
  return {
    stats,
    getCommandContext: () => ({
      captureDisabled: false,
      stats,
      sdk: sdk as unknown as Lhc,
      threadRef: { threadId: "th_first", registryPath: "/tmp/reg.sqlite" },
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

/** A terminal-shaped stream pair: the panel may open by itself only where a key can close it. */
function ttyStream(): NodeJS.ReadStream & NodeJS.WriteStream {
  const stream = new PassThrough() as unknown as NodeJS.ReadStream & NodeJS.WriteStream;
  Object.defineProperty(stream, "isTTY", { value: true, configurable: true });
  Object.defineProperty(stream, "columns", { value: 100, configurable: true });
  Object.defineProperty(stream, "rows", { value: 30, configurable: true });
  (stream as unknown as { setRawMode: (on: boolean) => void }).setRawMode = () => {};
  return stream;
}

async function waitFor(condition: () => boolean, label: string, capMs = 8_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > capMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

interface Live {
  pty: FakePty;
  logLines: string[];
  stdin: PassThrough;
  out: () => string;
  finish: () => Promise<number>;
}

async function launchLive(argv: string[], options: { receiptDb?: string } = {}): Promise<Live> {
  const spawned: FakePty[] = [];
  const logLines: string[] = [];
  const chunks: string[] = [];
  const stdin = ttyStream();
  const stdout = ttyStream();
  stdout.on("data", (chunk: Buffer | string) => chunks.push(String(chunk)));
  mocks.captureFactory = () => scriptedCaptureSession();
  const runPromise = run(argv, {
    claudeBin: "fake-claude",
    spawnPty: ((_file: string, args: string[]) => {
      const fake = makeFakePty(args);
      spawned.push(fake);
      return fake as never;
    }) as never,
    stdin,
    stdout: stdout as never,
    stderr: ttyStream() as never,
    noInference: true,
    ...(options.receiptDb === undefined ? {} : { governorReceiptDbPath: options.receiptDb }),
    wrapperLog: {
      info: (m: string) => logLines.push(m),
      warn: (m: string) => logLines.push(m),
      warningCount: () => 0,
      path: "/tmp/fake.log",
    } as never,
  });
  await waitFor(() => spawned.length > 0, "child spawn");
  // Let the launch settle past the startup panel decision.
  await new Promise((r) => setTimeout(r, 50));
  return {
    pty: spawned[0]!,
    logLines,
    stdin: stdin as unknown as PassThrough,
    out: () => chunks.join(""),
    finish: async () => {
      spawned[0]!.fireExit(0);
      return runPromise;
    },
  };
}

describe("first-load Control Panel on the managed launch path", () => {
  const savedHome = process.env.CC_LHC_HOME;
  const homes: string[] = [];
  let home = "";

  beforeEach(() => {
    mocks.captureFactory = null;
    home = mkdtempSync(join(tmpdir(), "cc-lhc-first-load-home-"));
    homes.push(home);
    process.env.CC_LHC_HOME = home;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mocks.captureFactory = null;
    if (savedHome === undefined) delete process.env.CC_LHC_HOME;
    else process.env.CC_LHC_HOME = savedHome;
    for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("TC-3.7b then TC-3.7c: the first launch opens the panel once and marks the version; the next launch in the same home is silent", async () => {
    const marker = firstLoadMarkerPath(home);
    expect(readShownVersion(marker)).toBeNull();

    // --- launch 1: onboarding ---
    const first = await launchLive([]);
    try {
      await waitFor(() => panelText(first.out()).includes(PANEL_TITLE), "onboarding panel");
      const shown = panelText(first.out());
      expect(shown).toContain("Welcome to CC-LHC");
      expect(shown).toContain("target 70k after /smart-compact · trigger 140k · window 200k");
      expect(shown).toContain("Claude native auto-compact off");
      expect(shown).toContain("reopen this panel any time with ctrl-] · press Esc to continue to Claude");
      // The same facts on Home's own rows: no second source of truth.
      expect(shown).toContain("target 70k");
      expect(shown).toContain("trigger 140k");
      expect(first.out().startsWith(ALT_SCREEN_ENTER)).toBe(true);
      expect(readShownVersion(marker)).toBe(ONBOARDING_VERSION);
      expect(first.logLines.join("\n")).toContain(`Control Panel opened at launch (onboarding v${ONBOARDING_VERSION})`);

      // Claude's own paint is held behind the panel, then lands after Escape.
      first.pty.emit("CLAUDE-PAINT-1");
      expect(first.out()).not.toContain("CLAUDE-PAINT-1");
      const beforeEsc = first.out().length;
      first.stdin.write(Buffer.from(ESC));
      await waitFor(() => first.out().includes("CLAUDE-PAINT-1"), "held paint flushed on Escape");
      const afterEsc = first.out().slice(beforeEsc);
      expect(afterEsc.indexOf(ALT_SCREEN_LEAVE)).toBeLessThan(afterEsc.indexOf("CLAUDE-PAINT-1"));
      // Input now reaches Claude, and the panel is not re-opened by itself.
      first.stdin.write(Buffer.from("hello"));
      await waitFor(() => first.pty.written.join("").includes("hello"), "input routed to Claude");
      const settled = first.out();
      await new Promise((r) => setTimeout(r, 100));
      expect(first.out()).toBe(settled);
      expect(readShownVersion(marker)).toBe(ONBOARDING_VERSION);
    } finally {
      expect(await first.finish()).toBe(0);
    }

    // --- launch 2: same home, same version → silent ---
    const markerBytes = readFileSync(marker, "utf8");
    const second = await launchLive([]);
    try {
      second.pty.emit("CLAUDE-PAINT-2");
      await waitFor(() => second.out().includes("CLAUDE-PAINT-2"), "child paint on the live screen");
      // Byte-for-byte: the terminal received exactly Claude's bytes.
      expect(second.out()).toBe("CLAUDE-PAINT-2");
      expect(second.logLines.join("\n")).not.toContain("Control Panel opened at launch");
      expect(readFileSync(marker, "utf8")).toBe(markerBytes);
      // The documented reopen key still opens the same panel on demand.
      second.stdin.write(Buffer.from([DEFAULT_LEADER_BYTE]));
      await waitFor(() => panelText(second.out()).includes(PANEL_TITLE), "panel on demand");
      expect(panelText(second.out())).not.toContain("Welcome to CC-LHC");
      const beforeClose = second.out().length;
      second.stdin.write(Buffer.from(ESC));
      await waitFor(() => second.out().slice(beforeClose).includes(ALT_SCREEN_LEAVE), "panel closed");
    } finally {
      expect(await second.finish()).toBe(0);
    }

    // --- launch 3: an older shown version reopens onboarding; a torn marker is not shown ---
    for (const stale of ['{"shownVersion":0}\n', '{"shownVersion":', ""]) {
      writeFileSync(marker, stale);
      const third = await launchLive([]);
      try {
        await waitFor(
          () => panelText(third.out()).includes("Welcome to CC-LHC"),
          `onboarding after ${JSON.stringify(stale)}`,
        );
        expect(readShownVersion(marker)).toBe(ONBOARDING_VERSION);
        third.stdin.write(Buffer.from(ESC));
        await waitFor(() => third.out().includes(ALT_SCREEN_LEAVE), "closed");
      } finally {
        expect(await third.finish()).toBe(0);
      }
    }
  }, 30_000);

  it("TC-3.7d: an actionable launch opens the panel with prioritized guidance, not onboarding, and Escape returns immediately", async () => {
    const marker = firstLoadMarkerPath(home);
    markShown(marker, ONBOARDING_VERSION);
    const markerBytes = readFileSync(marker, "utf8");
    const live = await launchLive(["--autocompact", "500000"]);
    try {
      await waitFor(() => panelText(live.out()).includes(PANEL_TITLE), "actionable panel");
      const shown = panelText(live.out());
      expect(shown).toContain("! Claude native auto-compact may run before Smart Compact on this launch");
      expect(shown).toContain("explicit --autocompact on this launch");
      expect(shown).not.toContain("Welcome to CC-LHC");
      expect(live.logLines.join("\n")).toContain("Control Panel opened at launch (actionable condition)");
      expect(readFileSync(marker, "utf8")).toBe(markerBytes);
      live.pty.emit("CLAUDE-PAINT");
      live.stdin.write(Buffer.from(ESC));
      await waitFor(() => live.out().includes("CLAUDE-PAINT"), "Escape returned to Claude");
      live.stdin.write(Buffer.from("k"));
      await waitFor(() => live.pty.written.join("").includes("k"), "input routed to Claude");
    } finally {
      expect(await live.finish()).toBe(0);
    }
  }, 15_000);

  it("TC-3.7d/e: an unsafe database opens the panel with its guidance first; the same home's onboarding stays marked", async () => {
    markShown(firstLoadMarkerPath(home), ONBOARDING_VERSION);
    const garbage = join(home, "garbage.sqlite");
    writeFileSync(garbage, "not a database at all\n");
    const live = await launchLive([], { receiptDb: garbage });
    try {
      await waitFor(() => panelText(live.out()).includes(PANEL_TITLE), "unsafe-state panel");
      const shown = panelText(live.out());
      expect(shown).toContain("! cc-lhc state is unsafe — capture or the database could not be trusted");
      expect(shown).toContain("continuity database unavailable");
      expect(shown).not.toContain("Welcome to CC-LHC");
      live.stdin.write(Buffer.from(ESC));
      await waitFor(() => live.out().includes(ALT_SCREEN_LEAVE), "closed");
    } finally {
      expect(await live.finish()).toBe(0);
    }
  }, 15_000);

  it("without a TTY nothing opens by itself: the guidance waits in the panel and the marker is not written", async () => {
    // The other rigs in this suite run without a TTY; this pins why they stay silent.
    const marker = firstLoadMarkerPath(home);
    const spawned: FakePty[] = [];
    const chunks: string[] = [];
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
    Object.defineProperty(stdout, "columns", { value: 100, configurable: true });
    Object.defineProperty(stdout, "rows", { value: 30, configurable: true });
    (stdout as unknown as PassThrough).on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
    mocks.captureFactory = () => scriptedCaptureSession();
    const runPromise = run(["--autocompact", "500000"], {
      claudeBin: "fake-claude",
      spawnPty: ((_file: string, args: string[]) => {
        const fake = makeFakePty(args);
        spawned.push(fake);
        return fake as never;
      }) as never,
      stdin,
      stdout,
      stderr: new PassThrough() as unknown as NodeJS.WriteStream,
      noInference: true,
      wrapperLog: { info: () => {}, warn: () => {}, warningCount: () => 0, path: "/tmp/fake.log" } as never,
    });
    await waitFor(() => spawned.length > 0, "child spawn");
    await new Promise((r) => setTimeout(r, 100));
    expect(chunks.join("")).toBe("");
    expect(readShownVersion(marker)).toBeNull();
    (stdin as unknown as PassThrough).write(Buffer.from([DEFAULT_LEADER_BYTE]));
    await waitFor(() => panelText(chunks.join("")).includes(PANEL_TITLE), "panel on demand");
    expect(panelText(chunks.join(""))).toContain(
      "! Claude native auto-compact may run before Smart Compact on this launch",
    );
    (stdin as unknown as PassThrough).write(Buffer.from([DEFAULT_LEADER_BYTE]));
    spawned[0]!.fireExit(0);
    expect(await runPromise).toBe(0);
  }, 15_000);
});
