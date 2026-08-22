/**
 * LIM-118: TC-2.1a-b, TC-2.2a-c. Help/parser bijection and Introduction copy.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { afterEach, describe, expect, it } from "vitest";

import {
  createInputState,
  DEFAULT_LEADER_BYTE,
  type InputState,
  processInputChunk,
} from "../../src/wrapper/modal.js";
import {
  buildPanelViewSnapshot,
  detailsLines,
  helpLines,
  introductionLines,
  PANEL_COMMANDS,
  parsePanelCommand,
  SESSION_SCOPE_MARKER,
} from "../../src/wrapper/panel-commands.js";
import { ENTER_ALT_SCREEN, PANEL_PROMPT, renderPanel } from "../../src/wrapper/panel.js";
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

/** The normal capture size Fable screenshots: a 64-column card inside 100x29. */
const NORMAL: readonly [number, number] = [100, 29];

function helpRowsAt(cols: number, rows: number): string[] {
  return cardBodyRows(renderPanel(feed(openHome(), "help\r"), cols, rows), cols, rows);
}

/** The single drawn row a command owns, or every row it spilled onto. */
function rowsForUsage(rows: readonly string[], usage: string): string[] {
  return rows.filter((row) => row.trimStart().startsWith(usage));
}

describe("Help scans as a command table", () => {
  it("gives every command one row at normal size, with the descriptions in one column", () => {
    const [cols, rows] = NORMAL;
    const drawn = helpRowsAt(cols, rows);
    const descriptionColumns = new Set<number>();
    for (const command of PANEL_COMMANDS) {
      const owned = rowsForUsage(drawn, command.usage);
      // One row: the usage and its description scan together, not as a
      // stacked label or a wrapped paragraph.
      expect(owned, `${command.usage} did not occupy exactly one row`).toHaveLength(1);
      const row = owned[0]!;
      expect(row, command.usage).toContain(command.helpSummary);
      expect(row.length, `${command.usage} overflowed the card`).toBeLessThanOrEqual(cols);
      descriptionColumns.add(row.indexOf(command.helpSummary));
    }
    // A table, not ragged text: every description starts at the same column.
    expect(descriptionColumns.size, `description column varied: ${[...descriptionColumns].join(", ")}`).toBe(1);
    // The whole vocabulary is on screen at this size — nothing is clipped away.
    expect(drawn.some((row) => row.includes("… more"))).toBe(false);
  });

  it("keeps Help short without losing the parser vocabulary or the full descriptions", () => {
    for (const command of PANEL_COMMANDS) {
      // Short enough to sit beside its usage in the card's description column.
      expect(command.helpSummary.length, `${command.name} help wording is too long`).toBeLessThanOrEqual(30);
      expect(command.helpSummary).not.toBe("");
      // The canonical description is untouched and still richer.
      expect(command.summary.length).toBeGreaterThanOrEqual(command.helpSummary.length);
      // Every command still parses, and Help still lists it.
      const probe =
        command.name === "auto" ? "auto on" : command.name === "bounds" ? "bounds 1000 2000" : command.name;
      expect(parsePanelCommand(probe).kind, command.name).not.toBe("unknown");
      expect(helpLines(openHome().panelView).join("\n")).toContain(command.usage);
    }
    expect(PANEL_COMMANDS).toHaveLength(11);
  });

  it("keeps each session-only marker attached to its own description at every width", () => {
    const sessionCommands = PANEL_COMMANDS.filter((command) => command.scope === "session");
    expect(sessionCommands.length).toBeGreaterThan(0);

    const [cols, rows] = NORMAL;
    for (const command of sessionCommands) {
      const row = rowsForUsage(helpRowsAt(cols, rows), command.usage)[0] ?? "";
      // Attached to the description, one space away — never parked at the
      // card's right edge.
      expect(row, command.usage).toContain(`${command.helpSummary} ${SESSION_SCOPE_MARKER}`);
      expect(row.trimEnd().endsWith(SESSION_SCOPE_MARKER), command.usage).toBe(true);
    }

    for (const [width, height] of [
      [100, 29],
      [80, 24],
      [64, 20],
      [44, 20],
      [36, 16],
    ] as const) {
      for (const row of helpRowsAt(width, height)) {
        const text = row.trim();
        if (!text.includes(SESSION_SCOPE_MARKER)) continue;
        // The explanatory note owns the marker as its subject; skip it.
        if (text.startsWith(`${SESSION_SCOPE_MARKER} session only`)) continue;
        expect(text, `${width}x${height}: marker floated alone`).not.toBe(SESSION_SCOPE_MARKER);
        expect(text, `${width}x${height}: marker detached from its words`).toMatch(
          new RegExp(`\\S ${SESSION_SCOPE_MARKER}$`),
        );
      }
    }

    // The explanation itself survives, whatever the width.
    expect(helpLines(openHome().panelView).join("\n")).toContain(
      `${SESSION_SCOPE_MARKER} session only — live now, survives handoffs, lost at wrapper exit`,
    );
  });

  it("still scrolls and stays reachable when the card cannot hold the table", () => {
    const short = helpRowsAt(64, 12);
    expect(short.some((row) => row.includes("… more"))).toBe(true);
    const scrolled = cardBodyRows(
      renderPanel(feed(feed(openHome(), "help\r"), "\x1b[B".repeat(12)), 64, 12),
      64,
      12,
    );
    expect(scrolled.join("\n")).toContain("introduction");
    expect(scrolled.join("\n")).not.toEqual(short.join("\n"));
  });
});

describe("TC-2.1a Help matches parser behavior", () => {
  it("Help and parser vocabularies are bijective and removed spellings are absent", () => {
    const home = openHome();
    const helpState = feed(home, "help\r");
    // Help scrolls; read the whole vocabulary by walking it to the end.
    let scrolled = helpState;
    let out = panelText(renderPanel(scrolled, 120, 40));
    for (let step = 0; step < 20; step += 1) {
      scrolled = feed(scrolled, "\x1b[B");
      out += `\n${panelText(renderPanel(scrolled, 120, 40))}`;
    }
    const helpText = helpLines(helpState.panelView).join("\n");
    const helpUsages = PANEL_COMMANDS.map((command) => command.usage);
    expect(helpUsages.length).toBeGreaterThan(0);
    for (const usage of helpUsages) {
      expect(helpText, `Help omitted ${usage}`).toContain(usage);
      expect(out, `the drawn Help omitted ${usage}`).toContain(usage);
      const example =
        usage === "auto on|off" ? "auto on" : usage.startsWith("bounds") ? "bounds 1000 2000" : usage.split(" ")[0]!;
      const parsed = parsePanelCommand(example);
      expect(parsed.kind === "execute" || parsed.kind === "route", usage).toBe(true);
    }
    const probes = [
      "status",
      "stats",
      "smart-compact",
      "smart-prune",
      "export",
      "auto on",
      "bounds 1 2",
      "help",
      "introduction",
      "?",
      "compact",
      "prune",
      "secret",
      "foo",
    ];
    for (const probe of probes) {
      const parsed = parsePanelCommand(probe);
      const accepted = parsed.kind === "execute" || parsed.kind === "route";
      const token = probe.split(" ")[0]!;
      if (accepted) {
        expect(helpText, `parser accepted ${probe} but Help omitted it`).toContain(
          token === "auto" ? "auto on|off" : token,
        );
      } else if (token === "?" || token === "compact" || token === "prune" || token === "secret" || token === "foo") {
        expect(helpUsages.some((usage) => usage.split(" ")[0] === token)).toBe(false);
      }
    }
    expect(parsePanelCommand("?").kind).toBe("unknown");
    expect(parsePanelCommand("compact").kind).toBe("unknown");
    expect(parsePanelCommand("prune").kind).toBe("unknown");
    expect(out).not.toMatch(/(^|[^\w-])compact([^\w-]|$)/);
    expect(out).not.toMatch(/(^|[^\w-])prune([^\w-]|$)/);
    expect(out).not.toContain(PANEL_PROMPT);
  });
});

describe("TC-2.1b Help distinguishes setting scope", () => {
  it("each setting command states session or persisted scope accurately", () => {
    const rows = helpLines(openHome().panelView);
    const lines = rows.join("\n");
    expect(lines).toContain("auto on|off");
    expect(lines).toContain("bounds <lower> <upper>");
    expect(lines).toContain("survives handoffs, lost at wrapper exit");
    // Session-scoped commands carry the marker; one-shot commands do not.
    const marked = (usage: string): boolean =>
      rows.some((line) => line.startsWith(usage) && line.includes(SESSION_SCOPE_MARKER));
    expect(marked("auto on|off")).toBe(true);
    expect(marked("bounds <lower> <upper>")).toBe(true);
    expect(marked("status")).toBe(false);
    expect(marked("stats")).toBe(false);
    expect(marked("smart-compact")).toBe(false);
    expect(lines).toMatch(new RegExp(`${SESSION_SCOPE_MARKER} session only`));
    const drawn = panelText(renderPanel(feed(openHome(), "help\r"), 120, 40));
    expect(drawn).toContain(SESSION_SCOPE_MARKER);
  });
});

describe("the typed details screen", () => {
  it("details opens from any casing and shows the diagnostics Home no longer carries", () => {
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
    for (const typed of ["details", "Details", "DETAILS"]) {
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
    // Enter returns Home, Esc closes — same contract as Help/Introduction.
    const opened = feed({ ...openHome(), panelView: view }, "details\r");
    expect(feed(opened, "\r").route).toBe("home");
    expect(feed(opened, "\x03").mode).toBe("passthrough");
  });
});

describe("TC-2.2a Introduction presents the mental model", () => {
  it("Introduction explains durable record and Low/Medium/High/Full working-context fidelity", () => {
    const home = openHome();
    const intro = feed(home, "introduction\r");
    const out = panelText(renderPanel(intro, 120, 40));
    expect(out).toContain("Complete captured history remains durable");
    expect(out).toContain("Smart Compact does not delete that record");
    expect(out).toContain("Full");
    expect(out).toContain("High");
    expect(out).toContain("Medium");
    expect(out).toContain("Low");
    expect(out).toContain("rebuilds working context");
    expect(out.toLowerCase()).not.toContain("deletes the transcript");
    expect(out).not.toContain(PANEL_PROMPT);
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
    (stdin as unknown as PassThrough).write(Buffer.from("\x1b[B\x1b[B\r"));
    await waitFor(() => shown().includes("Allocation Historical"), "preset applied");
    const afterSelect = out.length;
    (stdin as unknown as PassThrough).write(Buffer.from("help\r"));
    await waitFor(() => shown(afterSelect).includes("Active target 180k"), "help after select");
    expect(shown(afterSelect)).toContain("trigger 360k · Historical");
    const afterHelpEnter = out.length;
    (stdin as unknown as PassThrough).write(Buffer.from("\r"));
    await waitFor(() => shown(afterHelpEnter).includes("Actions"), "home after help");
    const afterHome = out.length;
    (stdin as unknown as PassThrough).write(Buffer.from("bounds 100000 200000\r"));
    await waitFor(
      () => shown(afterHome).includes("bounds 100000 200000") && shown(afterHome).includes("applied live"),
      "bounds applied",
    );
    const afterBounds = out.length;
    (stdin as unknown as PassThrough).write(Buffer.from("help\r"));
    await waitFor(() => shown(afterBounds).includes("target 100k"), "help after bounds");
    expect(shown(afterBounds)).toContain("trigger 200k");
    expect(shown(afterBounds)).toContain("Historical");
    expect(shown(afterBounds)).not.toContain("trigger 360k");
    const afterSecondHelpEnter = out.length;
    (stdin as unknown as PassThrough).write(Buffer.from("\r"));
    await waitFor(() => shown(afterSecondHelpEnter).includes("Actions"), "home after second help");
    const afterHelpHome = out.length;
    (stdin as unknown as PassThrough).write(Buffer.from("introduction\r"));
    await waitFor(() => shown(afterHelpHome).includes("toward 100k"), "introduction after bounds");
    expect(shown(afterHelpHome)).toContain("triggers at 200k");
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
