/**
 * LIM-118: TC-2.1a-b, TC-2.2a-c. Help/parser bijection and Introduction copy.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { afterEach, describe, expect, it } from "vitest";

import { createInputState, DEFAULT_LEADER_BYTE, type InputState, processInputChunk } from "../../src/wrapper/modal.js";
import { ENTER_ALT_SCREEN, PANEL_PROMPT, renderPanel } from "../../src/wrapper/panel.js";
import {
  buildPanelViewSnapshot,
  detailsLines,
  HELP_GROUPS,
  helpLines,
  helpRows,
  introductionLines,
  PANEL_COMMANDS,
  panelRowText,
  parsePanelCommand,
  SESSION_SCOPE_MARKER,
} from "../../src/wrapper/panel-commands.js";
import { run } from "../../src/wrapper/run.js";
import { cardBodyRows, panelText } from "../helpers/panel-text.js";

const LEADER = Buffer.from([DEFAULT_LEADER_BYTE]);

function feed(state: InputState, text: string): InputState {
  return processInputChunk(Buffer.from(text, "latin1"), state).state;
}

function openHome(): InputState {
  return {
    ...feed(createInputState(), LEADER.toString("latin1")),
    panelView: buildPanelViewSnapshot({
      providerContextTokens: 12_000,
      targetTokens: 50_000,
      triggerTokens: 90_000,
      autoCompact: true,
      captureHealth: "ready",
      profile: "balanced",
    }),
  };
}

/**
 * Rows that are a command's own table row: the usage in the label column,
 * followed by the gutter or nothing. Prose that merely mentions a command
 * ("/allocation changes survive handoffs") is not one of these.
 */
function isCommandRow(row: string, usage: string): boolean {
  const text = row.trimStart();
  if (!text.startsWith(usage)) return false;
  const rest = text.slice(usage.length);
  return rest.trim() === "" || rest.startsWith("  ");
}

/** Each Help screen the card draws while scrolling to the end of the copy. */
function helpScreens(cols: number, rows: number): string[][] {
  let state = feed(openHome(), "/help\r");
  const screens: string[][] = [cardBodyRows(renderPanel(state, cols, rows), cols, rows)];
  for (let step = 0; step < 80; step += 1) {
    state = feed(state, "\x1b[B");
    screens.push(cardBodyRows(renderPanel(state, cols, rows), cols, rows));
  }
  return screens;
}

/** Every Help row drawn across those screens. */
function helpScreenRows(cols: number, rows: number): string[] {
  return helpScreens(cols, rows).flat();
}

/** Everything Help says while scrolling, unwrapped for copy assertions. */
function helpScreenText(cols: number, rows: number): string {
  let state = feed(openHome(), "/help\r");
  const seen: string[] = [panelText(renderPanel(state, cols, rows))];
  for (let step = 0; step < 80; step += 1) {
    state = feed(state, "\x1b[B");
    seen.push(panelText(renderPanel(state, cols, rows)));
  }
  return seen.join("\n");
}

describe("Help teaches outcomes", () => {
  it("lists all 11 canonical commands exactly once, under their outcome groups", () => {
    const rows = helpRows(openHome().panelView);
    const headings = rows.flatMap((row) => (row.kind === "heading" ? [row.value ?? ""] : []));
    expect(headings).toEqual(HELP_GROUPS.map((group) => group.title));

    const pairs = rows.flatMap((row) => (row.kind === "pair" ? [row] : []));
    const usages = pairs.map((row) => row.label ?? "").filter((label) => label.startsWith("/"));
    expect(usages).toHaveLength(PANEL_COMMANDS.length);
    expect(new Set(usages).size).toBe(PANEL_COMMANDS.length);
    for (const command of PANEL_COMMANDS) {
      expect(usages, `Help omitted ${command.name}`).toContain(command.usage);
    }

    // Group membership comes from the registry, not from a second list.
    const flat = rows.map((row) => panelRowText(row));
    for (const group of HELP_GROUPS) {
      const groupStart = flat.indexOf(group.title);
      expect(groupStart, group.title).toBeGreaterThanOrEqual(0);
      const groupEnd =
        HELP_GROUPS.indexOf(group) === HELP_GROUPS.length - 1
          ? flat.length
          : flat.indexOf(HELP_GROUPS[HELP_GROUPS.indexOf(group) + 1]!.title);
      const inGroup = flat.slice(groupStart, groupEnd).join("\n");
      for (const command of PANEL_COMMANDS.filter((entry) => entry.group === group.id)) {
        expect(inGroup, `${command.name} is not under ${group.title}`).toContain(command.usage);
      }
    }
  });

  it("opens and closes with the user-facing notes, and avoids internal jargon", () => {
    const text = helpLines(openHome().panelView).join("\n");
    expect(text).toContain("Most users can keep working and let CC-LHC manage context automatically.");
    expect(text).toContain("Use these commands when you want to check or change it.");
    expect(text).toContain(
      "/smart-compact and /smart-prune change Claude's working context. They do not delete stored LHC history.",
    );
    expect(text).toContain(
      "/auto, /bounds, and /allocation changes survive handoffs and reset when this wrapper exits.",
    );
    for (const jargon of ["thread-view tail", "derivation counts", "working-context fidelity", "durable record"]) {
      expect(text.toLowerCase(), `Help still says "${jargon}"`).not.toContain(jargon.toLowerCase());
    }
  });

  it("keeps every command visibly attached to its description at every width", () => {
    for (const [cols, rows] of [
      [100, 29],
      [80, 24],
      [64, 20],
      [44, 20],
      [36, 16],
    ] as const) {
      const screens = helpScreens(cols, rows);
      for (const command of PANEL_COMMANDS) {
        const firstWord = command.helpSummary.split(" ")[0]!;
        let checked = 0;
        for (const screen of screens) {
          const index = screen.findIndex((row) => isCommandRow(row, command.usage));
          if (index < 0) continue;
          expect(screen[index]!.length, `${cols}x${rows}: ${command.usage} overflowed`).toBeLessThanOrEqual(cols);
          // The last row of a screen, and the row above a clip marker,
          // continue at the next scroll position.
          if (index === screen.length - 1) continue;
          if ((screen[index + 1] ?? "").includes("… more")) continue;
          // The description starts on the command's row, or on the row directly
          // beneath it — never separated from the command it belongs to.
          const own = screen[index] ?? "";
          const next = screen[index + 1] ?? "";
          expect(
            own.includes(firstWord) || next.includes(firstWord),
            `${cols}x${rows}: ${command.usage} lost its description`,
          ).toBe(true);
          checked += 1;
        }
        expect(checked, `${cols}x${rows}: ${command.usage} never rendered with its description`).toBeGreaterThan(0);
      }
    }
  });

  it("reaches every section by scrolling, and clips nothing permanently", () => {
    for (const [cols, rows] of [
      [100, 29],
      [44, 20],
    ] as const) {
      const shown = helpScreenText(cols, rows);
      for (const group of HELP_GROUPS) expect(shown, `${cols}x${rows}: ${group.title}`).toContain(group.title);
      expect(shown, `${cols}x${rows}`).toContain("Most users can keep working");
      expect(shown, `${cols}x${rows}`).toContain("They do not delete stored LHC history.");
      expect(shown, `${cols}x${rows}`).toContain("survive handoffs and reset when this wrapper exits");
      for (const command of PANEL_COMMANDS) {
        expect(shown, `${cols}x${rows}: ${command.usage} unreachable`).toContain(command.usage);
      }
    }
  });

  it("keeps each session-only marker attached to its own description at every width", () => {
    const sessionCommands = PANEL_COMMANDS.filter((command) => command.scope === "session");
    expect(sessionCommands.length).toBeGreaterThan(0);

    for (const [width, height] of [
      [100, 29],
      [80, 24],
      [64, 20],
      [44, 20],
      [36, 16],
    ] as const) {
      for (const row of helpScreenRows(width, height)) {
        const text = row.trim();
        if (!text.includes(SESSION_SCOPE_MARKER)) continue;
        // The explanatory note owns the marker as its subject; skip it.
        if (text.startsWith(SESSION_SCOPE_MARKER)) continue;
        expect(text, `${width}x${height}: marker floated alone`).not.toBe(SESSION_SCOPE_MARKER);
        expect(text, `${width}x${height}: marker detached from its words`).toMatch(
          new RegExp(`\\S ${SESSION_SCOPE_MARKER}$`),
        );
      }
    }

    // The explanation itself survives, whatever the width.
    expect(helpLines(openHome().panelView).join("\n")).toContain(
      `${SESSION_SCOPE_MARKER} /auto, /bounds, and /allocation changes survive handoffs`,
    );
  });
});

describe("TC-2.1a Help matches parser behavior", () => {
  it("Help and parser vocabularies are bijective and slashless spellings are absent", () => {
    const helpState = feed(openHome(), "/help\r");
    const helpText = helpLines(helpState.panelView).join("\n");
    const drawn = helpScreenRows(120, 40).join("\n");

    for (const command of PANEL_COMMANDS) {
      expect(helpText, `Help omitted ${command.usage}`).toContain(command.usage);
      expect(drawn, `the drawn Help omitted ${command.usage}`).toContain(command.usage);
      const example =
        command.name === "/auto" ? "/auto on" : command.name === "/bounds" ? "/bounds 1000 2000" : command.name;
      const parsed = parsePanelCommand(example);
      expect(parsed.kind === "execute" || parsed.kind === "route", command.usage).toBe(true);
    }

    // Nothing Help prints as a command is missing its slash, and no bare or
    // title-case spelling is offered anywhere on the screen.
    for (const row of helpRows(helpState.panelView)) {
      if (row.kind !== "pair") continue;
      const label = row.label ?? "";
      if (label === "Active") continue;
      expect(label.startsWith("/"), label).toBe(true);
    }
    expect(drawn).not.toContain("Smart Compact");
    expect(drawn).not.toContain("Smart Prune");

    for (const rejected of ["?", "compact", "prune", "secret", "foo", "smart-compact", "Smart Compact"]) {
      expect(parsePanelCommand(rejected).kind, rejected).not.toBe("execute");
      expect(parsePanelCommand(rejected).kind, rejected).not.toBe("route");
    }
    expect(drawn).not.toContain(PANEL_PROMPT);
  });
});

describe("TC-2.1b Help distinguishes setting scope", () => {
  it("each setting command states session or persisted scope accurately", () => {
    const rows = helpLines(openHome().panelView);
    const lines = rows.join("\n");
    expect(lines).toContain("/auto on|off");
    expect(lines).toContain("/bounds <target> <trigger>");
    expect(lines).toContain("survive handoffs and reset when this wrapper exits");
    // Session-scoped commands carry the marker; one-shot commands do not.
    const marked = (usage: string): boolean =>
      rows.some((line) => line.startsWith(usage) && line.includes(SESSION_SCOPE_MARKER));
    expect(marked("/auto on|off")).toBe(true);
    expect(marked("/bounds <target> <trigger>")).toBe(true);
    // Applying an allocation choice is a session policy edit, so /allocation
    // carries the same marker as the other two.
    expect(marked("/allocation")).toBe(true);
    expect(lines).toContain("/allocation");
    expect(lines).toContain("Applying a choice takes effect for this wrapper run.");
    expect(marked("/status")).toBe(false);
    expect(marked("/stats")).toBe(false);
    expect(marked("/smart-compact")).toBe(false);
    expect(lines).toContain(`${SESSION_SCOPE_MARKER} /auto, /bounds, and /allocation changes`);
    const drawn = panelText(renderPanel(feed(openHome(), "/help\r"), 120, 40));
    expect(drawn).toContain(SESSION_SCOPE_MARKER);
  });
});

describe("the typed details screen", () => {
  it("/details opens only in slash form and shows the diagnostics Home no longer carries", () => {
    const view = buildPanelViewSnapshot({
      providerContextTokens: 12_000,
      targetTokens: 50_000,
      triggerTokens: 90_000,
      autoCompact: true,
      captureHealth: "ready",
      profile: "balanced",
      details: [
        { label: "Retrieval", value: "ready" },
        { label: "Last action", value: "none this wrapper session" },
        { label: "Scope", value: "edits (auto/bounds) are session-scoped: live now, survive handoffs" },
        { label: "Precedence", value: "builtin < user /home/u/.config/cc-lhc/config.json < session" },
      ],
    });
    for (const typed of ["/details", "  /details  "]) {
      const state = feed({ ...openHome(), panelView: view }, `${typed}\r`);
      expect(state.route).toBe("details");
      const drawn = panelText(renderPanel(state, 120, 40));
      expect(drawn).toContain("Details");
      expect(drawn).toContain("Retrieval ready");
      expect(drawn).toContain("session-scoped");
      expect(drawn).toContain("builtin < user");
      expect(drawn).not.toContain(PANEL_PROMPT);
    }
    expect(detailsLines(view).join("\n")).toContain("Precedence");
    // The slashless and title-case spellings do not open it.
    for (const rejected of ["details", "Details", "DETAILS"]) {
      const state = feed({ ...openHome(), panelView: view }, `${rejected}\r`);
      expect(state.route, rejected).toBe("home");
    }
    // Enter returns Home, Esc closes — same contract as Help/Introduction.
    const opened = feed({ ...openHome(), panelView: view }, "/details\r");
    expect(feed(opened, "\r").route).toBe("home");
    expect(feed(opened, "\x03").mode).toBe("passthrough");
  });
});

describe("TC-2.2a Introduction presents the mental model", () => {
  it("answers what CC-LHC does, what is automatic, how context is kept, and what to do", () => {
    const home = openHome();
    const intro = feed(home, "/introduction\r");
    const out = panelText(renderPanel(intro, 120, 40));

    // 1. What does it do for me?
    expect(out).toContain("CC-LHC saves your Claude Code session in durable LHC history.");
    expect(out).toContain("Claude works from a smaller context built from that history");
    // 2. What happens automatically?
    expect(out).toContain("What happens automatically");
    expect(out).toContain("CC-LHC runs /smart-compact");
    expect(out).toContain("It continues in a replacement Claude Code session. Stored LHC history remains available.");
    expect(out).toContain("The replacement session gets a continuity note for tracked unfinished work.");
    // The old session's tracked work may be terminated, orphaned, or unknown.
    expect(out).not.toMatch(/unfinished work[^.]*\b(remain|remains)\b[^.]*available/i);
    // 3. How is context kept?
    expect(out).toContain("How context is kept");
    expect(out).toContain("Older work moves through Full, High, Medium, and Low fidelity bands.");
    expect(out).toContain("/allocation controls how much context space each band receives.");
    // 4. What should I do?
    expect(out).toContain("Start here");
    expect(out).toContain("1. Keep the defaults and work normally.");
    expect(out).toContain("2. Use /status to check context size, target, and trigger.");
    expect(out).toContain("3. Use /smart-compact before a large task");
    expect(out).toContain("4. Use /smart-prune after tool-heavy work");
    expect(out).toContain("Neither command deletes stored LHC history.");

    // Onboarding copy stays in plain language and slash spellings.
    for (const jargon of ["thread-view tail", "derivation counts", "working-context fidelity"]) {
      expect(out.toLowerCase()).not.toContain(jargon.toLowerCase());
    }
    expect(out).not.toContain("Smart Compact");
    expect(out).not.toContain("Smart Prune");
    expect(out).not.toContain(PANEL_PROMPT);
  });

  it("reflects the live automatic state instead of asserting a default", () => {
    const off = buildPanelViewSnapshot({
      providerContextTokens: 12_000,
      targetTokens: 50_000,
      triggerTokens: 90_000,
      autoCompact: false,
      captureHealth: "ready",
      profile: "historical",
    });
    const lines = introductionLines(off).join("\n");
    expect(lines).toContain("Automatic compaction is off.");
    expect(lines).toContain("/auto on");
    expect(lines).toContain("50k");
    expect(lines).toContain("90k");
    expect(lines).toContain("Historical");
    expect(lines).not.toContain("Keep working normally. At");

    // With no snapshot at all the screen states neither branch: it explains
    // the conditional and sends the reader to /status for the live answer.
    const unknown = introductionLines(null).join("\n");
    expect(unknown).toContain("When automatic compaction is on, CC-LHC runs /smart-compact");
    expect(unknown).toContain("Use /status to see the current target, trigger, and whether automatic compaction is on.");
    // Neither the enabled nor the disabled branch may be taken without a snapshot.
    expect(unknown, "null snapshot took the enabled branch").not.toContain("Keep working normally. At");
    expect(unknown, "null snapshot took the disabled branch").not.toContain("Automatic compaction is off.");
    expect(unknown).not.toMatch(/\bAt the active trigger\b/);
    expect(unknown).not.toContain("180k");
    expect(unknown).not.toContain("360k");
  });
});

describe("TC-2.2b Introduction uses current values", () => {
  it("Introduction renders active target/trigger rather than hardcoded defaults", () => {
    const view = buildPanelViewSnapshot({
      providerContextTokens: 1_000,
      targetTokens: 42_000,
      triggerTokens: 77_000,
      autoCompact: false,
      captureHealth: "ready",
      profile: "historical",
    });
    const lines = introductionLines(view).join("\n");
    expect(lines).toContain("42k");
    expect(lines).toContain("77k");
    expect(lines).toContain("Historical");
    expect(lines).not.toContain("180k");
    expect(lines).not.toContain("360k");
  });
});

describe("TC-2.2c Values refresh after selection", () => {
  const dirs: string[] = [];
  const savedHome = process.env.CC_LHC_HOME;
  afterEach(() => {
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

  it("Help/Introduction refresh from the same resolved configuration used by the runtime", async () => {
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-panel-refresh-"));
    dirs.push(home);
    process.env.CC_LHC_HOME = home;
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    Object.defineProperty(stdout, "columns", { value: 120, configurable: true });
    Object.defineProperty(stdout, "rows", { value: 40, configurable: true });
    Object.defineProperty(stdout, "isTTY", { value: false, configurable: true });
    Object.defineProperty(stdin, "isTTY", { value: false, configurable: true });
    // The panel draws UTF-8 glyphs; decode as UTF-8 so a chunk boundary
    // inside a multi-byte glyph does not corrupt what we read back.
    const decoder = new StringDecoder("utf8");
    let out = "";
    (stdout as unknown as PassThrough).on("data", (chunk: Buffer) => {
      out += decoder.write(chunk);
    });
    const exitCbs: Array<(arg: { exitCode: number }) => void> = [];
    const pty = {
      pid: 11,
      write: () => {},
      resize: () => {},
      kill: () => {
        setImmediate(() => {
          for (const cb of exitCbs) cb({ exitCode: 0 });
        });
      },
      onData: (cb: (data: string) => void) => {
        setTimeout(() => cb("tick\r\n"), 10);
        return { dispose() {} };
      },
      onExit: (cb: (arg: { exitCode: number }) => void) => {
        exitCbs.push(cb);
        return { dispose() {} };
      },
    };
    const runPromise = run([], {
      claudeBin: "fake",
      spawnPty: (() => pty) as never,
      stdin,
      stdout,
      noInference: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    (stdin as unknown as PassThrough).write(Buffer.from([DEFAULT_LEADER_BYTE]));
    const shown = (from = 0): string => panelText(out.slice(from));
    await waitFor(() => out.includes(ENTER_ALT_SCREEN) && shown().includes("Allocation Default"), "home default");
    expect(shown()).toContain("target 180k");
    expect(shown()).toContain("trigger 360k");
    (stdin as unknown as PassThrough).write(
      Buffer.from("\x1b[B\x1b[B\x1b[B\x1b[B\x1b[B\x1b[B\x1b[B\x1b[B\x1b[B\x1b[B\x1b[B\x1b[B\r"),
    );
    await waitFor(() => shown().includes("Band allocation") && shown().includes("Historical"), "allocation selector");
    // The selector opened from the Home command row, not from a prose label.
    (stdin as unknown as PassThrough).write(Buffer.from("\x1b[B\x1b[B\r"));
    await waitFor(() => shown().includes("Allocation Historical"), "preset applied");
    const afterSelect = out.length;
    (stdin as unknown as PassThrough).write(Buffer.from("/help\r"));
    await waitFor(() => shown(afterSelect).includes("Active target 180k"), "help after select");
    expect(shown(afterSelect)).toContain("trigger 360k · Historical");
    const afterHelpEnter = out.length;
    (stdin as unknown as PassThrough).write(Buffer.from("\r"));
    await waitFor(() => shown(afterHelpEnter).includes("Commands"), "home after help");
    const afterHome = out.length;
    (stdin as unknown as PassThrough).write(Buffer.from("/bounds 100000 200000\r"));
    await waitFor(
      () => shown(afterHome).includes("/bounds 100000 200000") && shown(afterHome).includes("applied live"),
      "bounds applied",
    );
    const afterBounds = out.length;
    (stdin as unknown as PassThrough).write(Buffer.from("/help\r"));
    await waitFor(() => shown(afterBounds).includes("target 100k"), "help after bounds");
    expect(shown(afterBounds)).toContain("trigger 200k");
    expect(shown(afterBounds)).toContain("Historical");
    expect(shown(afterBounds)).not.toContain("trigger 360k");
    const afterSecondHelpEnter = out.length;
    (stdin as unknown as PassThrough).write(Buffer.from("\r"));
    await waitFor(() => shown(afterSecondHelpEnter).includes("Commands"), "home after second help");
    const afterHelpHome = out.length;
    (stdin as unknown as PassThrough).write(Buffer.from("/introduction\r"));
    await waitFor(() => shown(afterHelpHome).includes("rebuilds toward 100k"), "introduction after bounds");
    expect(shown(afterHelpHome)).toContain("At 200k, CC-LHC runs /smart-compact");
    expect(shown(afterHelpHome)).toContain("Historical");
    pty.kill();
    await runPromise;
  }, 20_000);
});

async function waitFor(condition: () => boolean, label: string, capMs = 8_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > capMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
