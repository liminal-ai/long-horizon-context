import { describe, expect, it } from "vitest";

import { createInputState, type InputState, showReceipts } from "../../src/wrapper/modal.js";
import {
  createAltScreenGuard,
  ENTER_ALT_SCREEN,
  LEAVE_ALT_SCREEN,
  PANEL_HINT,
  PANEL_HINT_EXECUTING,
  PANEL_PROMPT,
  renderPanel,
  swapCommandProgressLabel,
} from "../../src/wrapper/panel.js";

function modalState(overrides: Partial<InputState> = {}): InputState {
  return { ...createInputState(), mode: "modal", ...overrides };
}

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
    guard.leave();
    guard.enter();
    guard.enter();
    expect(guard.active).toBe(true);
    guard.leave();
    guard.leave();
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
  it("draws a centered prompt + dim hint on a cleared screen, cursor after the input", () => {
    const out = renderPanel(modalState({ line: "status" }), 80, 24);
    expect(out.startsWith("\x1b[?25l\x1b[2J")).toBe(true);
    expect(out).toContain(`\x1b[11;22H${PANEL_PROMPT}status`);
    expect(out).toContain(`\x1b[13;22H\x1b[2m${PANEL_HINT}\x1b[22m`);
    expect(out.endsWith(`\x1b[11;51H\x1b[?25h`)).toBe(true);
  });

  it("hides the cursor while a command is executing", () => {
    const out = renderPanel(modalState({ mode: "executing", line: "status" }), 80, 24);
    expect(out).toContain(`${PANEL_PROMPT}status`);
    expect(out).toContain(`\x1b[2m${PANEL_HINT_EXECUTING}\x1b[22m`);
    expect(out).not.toContain(PANEL_HINT);
    expect(out.endsWith("\x1b[?25h")).toBe(false);
  });

  it("shows a static swap progress line for compact/prune while executing", () => {
    expect(swapCommandProgressLabel("compact")).toBe("compact — rebuilding…");
    expect(swapCommandProgressLabel("prune 160000")).toBe("prune — rebuilding…");
    expect(swapCommandProgressLabel("status")).toBeNull();

    const out = renderPanel(modalState({ mode: "executing", line: "compact" }), 80, 24);
    expect(out).toContain("compact — rebuilding…");
    expect(out).not.toContain(PANEL_PROMPT);
    expect(out).toContain(`\x1b[2m${PANEL_HINT_EXECUTING}\x1b[22m`);
    expect(out).not.toContain(PANEL_HINT);
    expect(out.endsWith("\x1b[?25h")).toBe(false);
  });

  it("renders receipt rows above the prompt with a blank separator", () => {
    const state = showReceipts(modalState(), ["tail=7 threshold=160000", "thread=th_x"]);
    const out = renderPanel(state, 80, 24);
    expect(out).toContain("\x1b[10;22Htail=7 threshold=160000");
    expect(out).toContain("\x1b[11;22Hthread=th_x");
    expect(out).toContain(`\x1b[13;22H${PANEL_PROMPT}`);
    expect(out).toContain(`\x1b[15;22H\x1b[2m${PANEL_HINT}\x1b[22m`);
  });

  it("splits embedded newlines into rows via showReceipts", () => {
    const state = showReceipts(modalState(), ["one\ntwo"]);
    expect(state.panelRows).toEqual(["one", "two"]);
  });

  it("truncates rows wider than the terminal with an ellipsis", () => {
    const wide = "x".repeat(200);
    const state = showReceipts(modalState(), [wide]);
    const out = renderPanel(state, 40, 24);
    expect(out).toContain(`${"x".repeat(37)}…`);
    expect(out).not.toContain("x".repeat(39));
  });

  it("clamps degenerate terminal sizes instead of emitting negative coordinates", () => {
    const out = renderPanel(modalState({ line: "s" }), 5, 2);
    expect(out).not.toContain("[-");
    expect(out).not.toContain("[0;");
    expect(out).toContain("long-horizon");
  });

  it("recenters for different dims (resize redraw is a fresh full render)", () => {
    const narrow = renderPanel(modalState(), 60, 10);
    const wideScreen = renderPanel(modalState(), 120, 40);
    expect(narrow).toContain(`\x1b[4;12H${PANEL_PROMPT}`);
    expect(wideScreen).toContain(`\x1b[19;42H${PANEL_PROMPT}`);
  });
});
