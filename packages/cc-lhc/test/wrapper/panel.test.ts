import { describe, expect, it } from "vitest";

import { createInputState, type InputState, processInputChunk, showReceipts } from "../../src/wrapper/modal.js";
import {
  ACTION_CARET,
  commandProgressLabel,
  createAltScreenGuard,
  ENTER_ALT_SCREEN,
  FOCUS_CARET,
  LEAVE_ALT_SCREEN,
  PANEL_HINT,
  PANEL_HINT_EXECUTING,
  PANEL_HINT_SUGGESTIONS,
  PANEL_HINT_SURVIVAL,
  PANEL_PROMPT,
  PANEL_PROMPT_PLACEHOLDER,
  panelStyleFromEnv,
  panelTier,
  renderPanel,
} from "../../src/wrapper/panel.js";
import { buildPanelViewSnapshot, PANEL_TITLE, PANEL_TITLE_SHORT } from "../../src/wrapper/panel-commands.js";
import { allocationSelectorChoices } from "../../src/wrapper/preset-presentation.js";
import { cardBodyRows, containsSgr, drawnRows, panelGrid, panelText } from "../helpers/panel-text.js";

const VIEW = buildPanelViewSnapshot({
  providerContextTokens: 38_000,
  targetTokens: 180_000,
  triggerTokens: 360_000,
  autoCompact: true,
  captureHealth: "ready",
  profile: "default",
});

function modalState(overrides: Partial<InputState> = {}): InputState {
  return { ...createInputState(), mode: "modal", panelView: VIEW, ...overrides };
}

function feed(state: InputState, text: string): InputState {
  return processInputChunk(Buffer.from(text, "latin1"), state).state;
}

/**
 * Assertions about the STYLED output must ask for style: the default honours
 * the caller's NO_COLOR/TERM, so a bare render says nothing about SGR. The
 * fallback behaviour has its own owners in "truthful degradation" below.
 */
const STYLED = { color: true, attributes: true } as const;

describe("alt-screen constants", () => {
  it("enter switches to the alternate screen; leave restores it and re-shows the cursor", () => {
    expect(ENTER_ALT_SCREEN).toBe("\x1b[?1049h");
    expect(LEAVE_ALT_SCREEN).toBe("\x1b[?1049l\x1b[?25h");
  });
});

describe("createAltScreenGuard", () => {
  it("enters and leaves exactly once each, whatever the call pattern", () => {
    const writes: string[] = [];
    const guard = createAltScreenGuard((data) => writes.push(data));
    expect(guard.active).toBe(false);
    guard.leave(); // leave before any enter: nothing
    guard.enter();
    guard.enter(); // double-enter: nothing
    expect(guard.active).toBe(true);
    guard.leave();
    guard.leave(); // double-leave (crash hook after a normal dismiss): nothing
    expect(guard.active).toBe(false);
    expect(writes).toEqual([ENTER_ALT_SCREEN, LEAVE_ALT_SCREEN]);
  });

  it("can re-enter after a full cycle", () => {
    const writes: string[] = [];
    const guard = createAltScreenGuard((data) => writes.push(data));
    guard.enter();
    guard.leave();
    guard.enter();
    expect(guard.active).toBe(true);
    expect(writes).toEqual([ENTER_ALT_SCREEN, LEAVE_ALT_SCREEN, ENTER_ALT_SCREEN]);
  });
});

describe("renderPanel", () => {
  it("draws a cleared Home with title, prompt, and dim hint, cursor after the input", () => {
    const out = renderPanel(modalState({ line: "/status" }), 80, 24);
    expect(out.startsWith("\x1b[?25l\x1b[2J")).toBe(true);
    expect(panelText(out)).toContain(PANEL_TITLE);
    expect(panelText(out)).toContain(`${PANEL_PROMPT}/status`);
    // A command line has the suggestion menu open, so the hint says what the
    // arrows and Tab do right now.
    expect(out).toContain(PANEL_HINT_SUGGESTIONS);
    expect(out.endsWith("\x1b[?25h")).toBe(true);

    const idle = renderPanel(modalState(), 80, 24);
    expect(idle).toContain(PANEL_HINT);
    expect(idle).not.toContain(PANEL_HINT_SUGGESTIONS);
    expect(panelText(idle)).toContain(PANEL_PROMPT_PLACEHOLDER);
  });

  it("hides the cursor and shows a progress line while a command is executing", () => {
    const out = renderPanel(modalState({ mode: "executing", line: "/status" }), 80, 24, undefined, STYLED);
    // every executing command gets a progress line — a frozen prompt line is
    // indistinguishable from a hang
    expect(panelText(out)).toContain("/status — running…");
    expect(panelText(out)).not.toContain(`${PANEL_PROMPT}/status`);
    expect(panelText(out)).not.toContain(PANEL_PROMPT_PLACEHOLDER);
    expect(out).toContain(`\x1b[2m${PANEL_HINT_EXECUTING}\x1b[22m`);
    expect(out).not.toContain(PANEL_HINT);
    expect(out.endsWith("\x1b[?25h")).toBe(false);
  });

  it("labels progress per command and appends elapsed seconds from the ticker", () => {
    expect(commandProgressLabel("/smart-compact")).toBe("/smart-compact — rebuilding…");
    expect(commandProgressLabel("/smart-prune 160000")).toBe("/smart-prune — rebuilding…");
    expect(commandProgressLabel("/status")).toBe("/status — running…");
    expect(commandProgressLabel("/stats", 0)).toBe("/stats — running…");
    expect(commandProgressLabel("/stats", 3)).toBe("/stats — running… (3s)");
    // Bare and title-case spellings are not commands and never label progress.
    expect(commandProgressLabel("smart-compact")).toBe("smart-compact — running…");

    const out = renderPanel(modalState({ mode: "executing", line: "/smart-compact" }), 80, 24, 7);
    expect(panelText(out)).toContain("/smart-compact — rebuilding… (7s)");
    expect(out.endsWith("\x1b[?25h")).toBe(false);
  });

  it("renders receipt rows above the prompt with a dim rule", () => {
    const state = showReceipts(modalState(), ["tail=7 threshold=160000", "thread=th_x"]);
    const out = renderPanel(state, 80, 24);
    const text = panelText(out);
    expect(text).toContain("tail=7 threshold=160000");
    expect(text).toContain("thread=th_x");
    expect(text).toContain(PANEL_PROMPT);
    expect(out).toContain(PANEL_HINT);
  });

  it("splits embedded newlines into rows via showReceipts", () => {
    const state = showReceipts(modalState(), ["one\ntwo"]);
    expect(state.panelRows).toEqual(["one", "two"]);
  });

  it("keeps every drawn row inside the card and inside the terminal", () => {
    for (const [cols, rows] of [
      [120, 40],
      [80, 24],
      [64, 20],
      [56, 12],
      [44, 16],
      [30, 8],
      [20, 5],
    ] as const) {
      const wide = "x".repeat(200);
      const state = showReceipts(modalState({ line: "/smart-prune 12345" }), [wide]);
      for (const line of panelGrid(renderPanel(state, cols, rows), cols, rows)) {
        expect(line.length, `${cols}x${rows}`).toBeLessThanOrEqual(cols);
      }
    }
  });

  it("clamps degenerate terminal sizes instead of emitting negative coordinates", () => {
    const out = renderPanel(modalState({ line: "s" }), 5, 2);
    expect(out).not.toContain("[-");
    expect(out).not.toContain("[0;");
    // 5 cols clamps to 20 → survival mode, and the command line is still drawn
    expect(panelText(out)).toContain(`${PANEL_PROMPT}s`);
  });

  it("recenters for different dims (resize redraw is a fresh full render)", () => {
    const narrow = renderPanel(modalState(), 60, 14);
    const wideScreen = renderPanel(modalState(), 120, 40);
    expect(panelText(narrow)).toContain(PANEL_PROMPT);
    expect(panelText(wideScreen)).toContain(PANEL_PROMPT);
    expect(narrow).not.toEqual(wideScreen);
  });
});

describe("the card", () => {
  it("puts every screen in one bordered card with its title in the border and the hint outside", () => {
    const rows = drawnRows(renderPanel(modalState(), 100, 30), 100, 30);
    const top = rows[0] ?? "";
    const bottom = rows[rows.length - 2] ?? "";
    const hint = rows[rows.length - 1] ?? "";
    expect(top.trim().startsWith("╭─")).toBe(true);
    expect(top).toContain(PANEL_TITLE);
    expect(top.trim().endsWith("╮")).toBe(true);
    expect(bottom.trim().startsWith("╰")).toBe(true);
    expect(bottom.trim().endsWith("╯")).toBe(true);
    // Nothing but the hint lives outside the frame.
    expect(hint.trim()).toBe(PANEL_HINT);
    for (const line of rows.slice(1, -2)) {
      expect(line.trim().startsWith("│")).toBe(true);
      expect(line.trim().endsWith("│")).toBe(true);
    }
  });

  it("shortens the title rather than dropping it when the card is narrow", () => {
    const rows = drawnRows(renderPanel(modalState(), 44, 20), 44, 20);
    expect(rows[0]).toContain(PANEL_TITLE_SHORT);
    expect(rows[0]).not.toContain(PANEL_TITLE);
  });

  it("gutter-aligns the status block and keeps band shares on one line", () => {
    const rows = cardBodyRows(renderPanel(modalState(), 100, 30), 100, 30);
    const contextRow = rows.find((line) => line.includes("Context"))!;
    const captureRow = rows.find((line) => line.includes("Capture"))!;
    const allocationRow = rows.find((line) => line.includes("Allocation"))!;
    const shares = rows.find((line) => line.includes("Low 20%"))!;
    expect(contextRow.indexOf("Context")).toBe(captureRow.indexOf("Capture"));
    expect(contextRow.indexOf("Context")).toBe(allocationRow.indexOf("Allocation"));
    expect(contextRow.indexOf("38k used")).toBe(captureRow.indexOf("ready"));
    expect(shares).toContain("Low 20% · Medium 20% · High 30% · Full 30%");
    // Home carries no wrapper internals.
    const home = panelText(renderPanel(modalState(), 100, 30));
    expect(home).not.toContain("precedence");
    expect(home).not.toContain("DISABLE_AUTO_COMPACT");
    expect(home).not.toMatch(/: none/);
    expect(home).not.toMatch(/\/[a-z]+\/[a-z]/);
  });

  it("spends one row on the allocation phrase, then the shares", () => {
    // The normal capture size: a 64-column card inside 100x29.
    const rows = cardBodyRows(renderPanel(modalState(), 100, 29), 100, 29);
    const index = rows.findIndex((line) => line.includes("Allocation"));
    expect(index).toBeGreaterThanOrEqual(0);
    const allocationRow = rows[index]!;
    expect(allocationRow).toContain("Default");
    expect(allocationRow).toContain("favors recent detail");
    expect(allocationRow.length).toBeLessThanOrEqual(100);
    // The shares follow immediately: no prose rows in between.
    expect(rows[index + 1]).toContain("Low 20% · Medium 20% · High 30% · Full 30%");
    // Home and selector use their purpose-specific preset descriptions.
    const home = panelText(renderPanel(modalState(), 100, 29));
    expect(home).not.toContain("initial selection");
    expect(home).not.toContain("emphasizes recent history");
    const selector = panelText(renderPanel(modalState({ route: "allocation" }), 100, 29));
    expect(selector).toContain("favors recent history");
    expect(selector).toContain("equal fidelity distribution");
    expect(selector).toContain("broader low-fidelity history");
    expect(allocationSelectorChoices("default").map((choice) => choice.description)).toEqual([
      "favors recent history",
      "equal fidelity distribution",
      "broader low-fidelity history",
    ]);
  });

  it("marks exactly one selected row, and the selection moves with the arrows", () => {
    const first = renderPanel(modalState(), 100, 30, undefined, STYLED);
    const firstRows = cardBodyRows(first, 100, 30);
    const carets = firstRows.filter((line) => {
      const text = line.trimStart();
      return text.startsWith(FOCUS_CARET) || text.startsWith(ACTION_CARET);
    });
    // the focused status row plus the prompt caret — nothing else
    expect(carets).toHaveLength(2);
    expect(carets[0]).toContain("Context");
    expect(first).toContain("\x1b[1;34m38k used\x1b[22;39m");

    const down = renderPanel(feed(modalState(), "\x1b[B"), 100, 30, undefined, STYLED);
    expect(down).toContain("\x1b[1;34mtarget 180k\x1b[22;39m");
    expect(down).not.toContain("\x1b[1;34m38k used\x1b[22;39m");

    let action = modalState();
    for (let step = 0; step < 10; step += 1) action = feed(action, "\x1b[B");
    const actionRows = cardBodyRows(renderPanel(action, 100, 30, undefined, STYLED), 100, 30);
    const selected = actionRows.filter((line) => line.trimStart().startsWith(ACTION_CARET));
    expect(selected.some((line) => line.includes("/smart-compact"))).toBe(true);
    // one action caret and the prompt caret
    expect(selected).toHaveLength(2);
    expect(actionRows.some((line) => line.trimStart().startsWith(FOCUS_CARET))).toBe(false);
  });
});

describe("truthful degradation", () => {
  it("keeps border, gutter alignment, and caret selection with no colour and no attributes", () => {
    const plain = renderPanel(modalState(), 100, 30, undefined, { color: false, attributes: false });
    // No SGR at all: only cursor positioning, hide-cursor, and the clear.
    expect(containsSgr(plain)).toBe(false);
    expect(drawnRows(plain, 100, 30)[0]).toContain("╭─");
    const rows = cardBodyRows(plain, 100, 30);
    expect(rows.some((line) => line.includes(FOCUS_CARET))).toBe(true);
    expect(rows.some((line) => line.includes(`${ACTION_CARET}${PANEL_PROMPT_PLACEHOLDER}`))).toBe(true);
    const contextRow = rows.find((line) => line.includes("Context"))!;
    const captureRow = rows.find((line) => line.includes("Capture"))!;
    expect(contextRow.indexOf("38k used")).toBe(captureRow.indexOf("ready"));
  });

  it("uses colour only on top of a caret or a marker that already carries the meaning", () => {
    const coloured = renderPanel(modalState(), 100, 30, undefined, { color: true, attributes: true });
    const plain = renderPanel(modalState(), 100, 30, undefined, { color: false, attributes: false });
    expect(coloured).toContain("\x1b[1;34m");
    expect(panelGrid(coloured, 100, 30)).toEqual(panelGrid(plain, 100, 30));
  });

  it("reads NO_COLOR and TERM=dumb", () => {
    expect(panelStyleFromEnv({ TERM: "xterm-256color" })).toEqual({ color: true, attributes: true });
    expect(panelStyleFromEnv({ NO_COLOR: "1" })).toEqual({ color: false, attributes: true });
    expect(panelStyleFromEnv({ TERM: "dumb" })).toEqual({ color: false, attributes: false });
  });
});

describe("size tiers", () => {
  it("picks full, compact, and survival by the terminal box", () => {
    expect(panelTier(100, 30)).toBe("full");
    expect(panelTier(56, 12)).toBe("full");
    expect(panelTier(55, 12)).toBe("compact");
    expect(panelTier(40, 16)).toBe("compact");
    expect(panelTier(30, 8)).toBe("compact");
    expect(panelTier(29, 8)).toBe("survival");
    expect(panelTier(20, 5)).toBe("survival");
  });

  it("drops action descriptions but keeps the card at compact size", () => {
    const rows = drawnRows(renderPanel(modalState(), 40, 16), 40, 16);
    expect(rows[0]).toContain(PANEL_TITLE_SHORT);
    expect(rows[0]).toContain("╭─");
    expect(rows.some((line) => line.includes("/smart-compact"))).toBe(true);
    expect(rows.some((line) => line.includes("Alloc"))).toBe(true);
  });

  it("survives 20x5 with a summary, the focused row, the command line, and the exit hint", () => {
    const rows = drawnRows(renderPanel(modalState({ line: "st" }), 20, 5), 20, 5);
    expect(rows.length).toBeLessThanOrEqual(5);
    for (const line of rows) expect(line.length).toBeLessThanOrEqual(20);
    expect(rows[0]).toContain("38k");
    expect(rows.some((line) => line.startsWith(FOCUS_CARET))).toBe(true);
    expect(rows.some((line) => line === `${PANEL_PROMPT}st`)).toBe(true);
    expect(rows[rows.length - 1]).toBe(PANEL_HINT_SURVIVAL);
    expect(PANEL_HINT_SURVIVAL.length).toBeLessThanOrEqual(18);
  });
});
