/**
 * LIM-118: TC-1.2a-b, TC-1.3a, TC-1.5a-b, TC-2.3a-c, AR-10.
 */
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { PRODUCT_PRESET_IDS } from "../../src/governor/band-allocation.js";
import {
  clampPanelViewport,
  createInputState,
  DEFAULT_LEADER_BYTE,
  type InputAction,
  type InputState,
  processInputChunk,
  resolveBareEsc,
} from "../../src/wrapper/modal.js";
import {
  buildPanelViewSnapshot,
  HOME_ACTIONS,
  homeCursorLength,
  PANEL_TITLE,
} from "../../src/wrapper/panel-commands.js";
import {
  ACTION_CARET,
  ENTER_ALT_SCREEN,
  LEAVE_ALT_SCREEN,
  PANEL_HINT_READONLY,
  PANEL_HINT_SURVIVAL,
  PANEL_PROMPT,
  renderPanel,
} from "../../src/wrapper/panel.js";
import { run } from "../../src/wrapper/run.js";
import { drawnRows, panelText } from "../helpers/panel-text.js";

const LEADER = Buffer.from([DEFAULT_LEADER_BYTE]);

function feed(state: InputState, ...chunks: Array<string | Buffer>): {
  state: InputState;
  actions: InputAction[];
} {
  let current = state;
  const actions: InputAction[] = [];
  for (const chunk of chunks) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk, "latin1") : chunk;
    const result = processInputChunk(buffer, current);
    current = result.state;
    actions.push(...result.actions);
  }
  return { state: current, actions };
}

function openHome(): InputState {
  const opened = feed(createInputState(), LEADER).state;
  return {
    ...opened,
    panelView: buildPanelViewSnapshot({
      providerContextTokens: 31_000,
      targetTokens: 50_000,
      triggerTokens: 90_000,
      autoCompact: true,
      captureHealth: "ready",
      profile: "default",
    }),
  };
}

function executed(actions: InputAction[]): string[] {
  return actions.filter((action) => action.kind === "execute").map((action) => action.commandLine);
}

describe("TC-1.2a New user discovers actions", () => {
  it("Home identifies common actions and provides direct Help and Introduction paths", () => {
    const out = panelText(renderPanel(openHome(), 120, 40));
    expect(out).toContain(PANEL_TITLE);
    expect(out).toContain("Actions");
    expect(out).toContain("Smart Compact");
    expect(out).toContain("Smart Prune");
    expect(out).toContain("Band allocation");
    expect(out).toContain("Help");
    expect(out).toContain("Introduction");
    expect(out).toContain(PANEL_PROMPT);
    const help = feed(openHome(), "help\r");
    expect(help.state.route).toBe("help");
    expect(executed(help.actions)).toEqual([]);
    const intro = feed(openHome(), "introduction\r");
    expect(intro.state.route).toBe("introduction");
    expect(executed(intro.actions)).toEqual([]);
  });

  it("every action label the panel prints is a command the parser accepts", () => {
    for (const action of HOME_ACTIONS) {
      for (const typed of [action.label, action.label.toLowerCase(), action.label.toUpperCase()]) {
        const result = feed(openHome(), `${typed}\r`);
        const opened = result.state.route !== "home" || result.state.mode === "executing";
        expect(opened, `panel rejected its own label ${JSON.stringify(typed)}`).toBe(true);
        expect(panelText(renderPanel(result.state, 120, 40))).not.toContain("unknown command");
      }
    }
  });
});

describe("TC-1.2b Command entry remains on Home", () => {
  it("Home command entry executes one valid command and preserves Claude screen", async () => {
    const typed = feed(openHome(), "status\r");
    expect(executed(typed.actions)).toEqual(["/lhc-status"]);
    expect(typed.state.mode).toBe("executing");
    expect(typed.actions.filter((action) => action.kind === "execute")).toHaveLength(1);

    const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
    Object.defineProperty(stdout, "columns", { value: 80, configurable: true });
    Object.defineProperty(stdout, "rows", { value: 24, configurable: true });
    Object.defineProperty(stdout, "isTTY", { value: false, configurable: true });
    let out = "";
    (stdout as unknown as PassThrough).on("data", (chunk: Buffer) => {
      out += chunk.toString("latin1");
    });
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    Object.defineProperty(stdin, "isTTY", { value: false, configurable: true });
    const pty = {
      pid: 42,
      write: () => {},
      resize: () => {},
      kill: () => {
        setImmediate(() => {
          for (const cb of exitCbs) cb({ exitCode: 0 });
        });
      },
      onData: (cb: (data: string) => void) => {
        setTimeout(() => cb("claude-screen\r\n"), 10);
        return { dispose() {} };
      },
      onExit: (cb: (arg: { exitCode: number }) => void) => {
        exitCbs.push(cb);
        return { dispose() {} };
      },
    };
    const exitCbs: Array<(arg: { exitCode: number }) => void> = [];
    const runPromise = run([], {
      claudeBin: "fake",
      spawnPty: (() => pty) as never,
      stdin,
      stdout,
      noInference: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    (stdin as unknown as PassThrough).write(LEADER);
    await waitFor(() => out.includes(ENTER_ALT_SCREEN), "panel open");
    const before = out.length;
    (stdin as unknown as PassThrough).write(Buffer.from("status\r"));
    await waitFor(() => out.slice(before).includes("status") || out.slice(before).includes("running"), "command progress");
    (stdin as unknown as PassThrough).write(Buffer.from([0x1b]));
    await new Promise((resolve) => setTimeout(resolve, 80));
    pty.kill();
    await runPromise;
    expect(out).toContain(LEAVE_ALT_SCREEN);
    const leaveAt = out.indexOf(LEAVE_ALT_SCREEN);
    const enterAt = out.indexOf(ENTER_ALT_SCREEN);
    expect(enterAt).toBeGreaterThanOrEqual(0);
    expect(leaveAt).toBeGreaterThan(enterAt);
  }, 15_000);
});

describe("TC-1.3a Exit Home", () => {
  it("Esc and Ctrl-C close Home and restore the terminal", async () => {
    const pending = feed(openHome(), "\x1b");
    const resolved = resolveBareEsc(pending.state);
    expect(resolved?.actions).toEqual([{ kind: "exit_modal" }]);
    expect(resolved?.state.mode).toBe("passthrough");
    const ctrlC = feed(openHome(), "\x03");
    expect(ctrlC.actions).toEqual([{ kind: "exit_modal" }]);
    expect(ctrlC.state.mode).toBe("passthrough");
  });
});

describe("TC-1.5a Small Home remains operable", () => {
  it("minimum supported terminal keeps state, actions, input, and exit reachable", () => {
    const panelView = buildPanelViewSnapshot({
      providerContextTokens: 31_000,
      targetTokens: 50_000,
      triggerTokens: 90_000,
      autoCompact: true,
      captureHealth: "ready",
      profile: "balanced",
    });
    expect([panelView.low, panelView.medium, panelView.high, panelView.full]).toEqual([25, 25, 25, 25]);
    const home: InputState = { ...openHome(), panelView };
    const statusNeedles = [
      "ctx 31k",
      "target 50k",
      "trigger 90k",
      "auto on",
      "capture ready",
      "alloc Balanced",
      `Low ${panelView.low}%`,
      `Medium ${panelView.medium}%`,
      `High ${panelView.high}%`,
      `Full ${panelView.full}%`,
    ];
    const seenStatus = new Set<number>();
    const seenActions = new Set<string>();
    let state = home;
    for (let step = 0; step < homeCursorLength(); step += 1) {
      const out = renderPanel(state, 20, 5);
      const text = panelText(out);
      expect(text).toContain(PANEL_PROMPT);
      expect(text).toContain("esc");
      const drawn = drawnRows(out, 20, 5);
      expect(drawn.length).toBeLessThanOrEqual(5);
      for (const line of drawn) expect(line.length).toBeLessThanOrEqual(20);
      const cursorRows = [...out.matchAll(/\x1b\[(\d+);\d+H/g)].map((m) => Number.parseInt(m[1]!, 10));
      expect(cursorRows.length).toBeGreaterThan(0);
      for (const row of cursorRows) {
        expect(row).toBeGreaterThanOrEqual(1);
        expect(row).toBeLessThanOrEqual(5);
      }
      statusNeedles.forEach((needle, index) => {
        if (text.includes(needle)) seenStatus.add(index);
      });
      for (const action of HOME_ACTIONS) {
        if (text.includes(`${ACTION_CARET}${action.label}`)) seenActions.add(action.id);
      }
      if (step === 0) expect(state.viewport.selectedIndex).toBe(-1);
      state = feed(state, "\x1b[B").state;
    }
    expect([...seenStatus].sort((a, b) => a - b)).toEqual(statusNeedles.map((_, index) => index));
    expect([...seenActions].sort()).toEqual([...HOME_ACTIONS.map((action) => action.id)].sort());
    const typed = feed(home, "status");
    expect(typed.state.line).toBe("status");
    expect(typed.state.mode).toBe("modal");
    const submitted = feed(typed.state, "\r");
    expect(executed(submitted.actions)).toEqual(["/lhc-status"]);
    const pending = feed(home, "\x1b");
    const esc = resolveBareEsc(pending.state);
    expect(esc?.actions).toEqual([{ kind: "exit_modal" }]);
    expect(esc?.state.mode).toBe("passthrough");
    const ctrlC = feed(home, "\x03");
    expect(ctrlC.actions).toEqual([{ kind: "exit_modal" }]);
    expect(ctrlC.state.mode).toBe("passthrough");
  });
});

describe("TC-1.5b Resize allocation selector", () => {
  it("allocation selector clamps and redraws selection, choices, and exit after narrow/short/large resize", () => {
    let state = openHome();
    for (let step = 0; step < homeCursorLength() && state.viewport.selectedIndex !== 2; step += 1) {
      state = feed(state, "\x1b[B").state;
    }
    state = feed(state, "\r").state;
    expect(state.route).toBe("allocation");
    state = feed(state, "\x1b[B").state;
    expect(state.viewport.selectedIndex).toBe(1);
    expect(PRODUCT_PRESET_IDS[1]).toBe("balanced");
    for (const [cols, rows] of [
      [20, 5],
      [40, 8],
      [120, 40],
    ] as const) {
      const clamped = clampPanelViewport(state, cols, rows);
      expect(clamped.route).toBe("allocation");
      expect(clamped.viewport.selectedIndex).toBe(1);
      const out = panelText(renderPanel(clamped, cols, rows));
      expect(out).toContain("Default");
      expect(out).toContain("Balanced");
      expect(out).toContain("Historical");
      expect(out).toContain(`${ACTION_CARET}Balanced`);
      expect(out.toLowerCase()).not.toContain("edit");
      expect(out.toLowerCase()).not.toContain("create");
      const applied = feed(clamped, "\r");
      expect(applied.state.route).toBe("home");
      expect(applied.actions.filter((action) => action.kind === "select_allocation")).toEqual([
        { kind: "select_allocation", id: "balanced" },
      ]);
      const pending = feed(clamped, "\x1b");
      const esc = resolveBareEsc(pending.state);
      expect(esc?.state.mode).toBe("passthrough");
      expect(esc?.actions).toEqual([{ kind: "exit_modal" }]);
      expect((esc?.actions ?? []).some((action) => action.kind === "select_allocation")).toBe(false);
      const ctrlC = feed(clamped, "\x03");
      expect(ctrlC.state.mode).toBe("passthrough");
      expect(ctrlC.actions).toEqual([{ kind: "exit_modal" }]);
      expect(ctrlC.actions.some((action) => action.kind === "select_allocation")).toBe(false);
    }
  });
});

describe("TC-2.3a Enter returns Home", () => {
  it("Enter from Help or Introduction returns Home without a command execution", () => {
    const help = feed(openHome(), "help\r");
    expect(help.state.route).toBe("help");
    const back = feed(help.state, "\r");
    expect(back.state.route).toBe("home");
    expect(back.state.mode).toBe("modal");
    expect(executed(back.actions)).toEqual([]);
    const intro = feed(openHome(), "introduction\r");
    const home = feed(intro.state, "\r");
    expect(home.state.route).toBe("home");
    expect(executed(home.actions)).toEqual([]);
  });
});

describe("TC-2.3b Escape returns to Claude Code", () => {
  it("Esc/Ctrl-C closes Help/Introduction directly to Claude Code", () => {
    const help = feed(openHome(), "help\r");
    expect(help.state.route).toBe("help");
    const pending = feed(help.state, "\x1b");
    const esc = resolveBareEsc(pending.state);
    expect(esc?.actions).toEqual([{ kind: "exit_modal" }]);
    expect(esc?.state.mode).toBe("passthrough");
    expect(executed([...help.actions, ...pending.actions, ...(esc?.actions ?? [])])).toEqual([]);
    const intro = feed(openHome(), "introduction\r");
    expect(intro.state.route).toBe("introduction");
    const ctrlC = feed(intro.state, "\x03");
    expect(ctrlC.actions).toEqual([{ kind: "exit_modal" }]);
    expect(ctrlC.state.mode).toBe("passthrough");
    expect(executed([...intro.actions, ...ctrlC.actions])).toEqual([]);
  });
});

describe("TC-2.3c Long text remains usable", () => {
  it("long read-only content scrolls while footer stays visible", () => {
    const help = feed(openHome(), "help\r").state;
    const scrolled = feed(help, "\x1b[B", "\x1b[B").state;
    expect(scrolled.route).toBe("help");
    expect(scrolled.viewport.scrollOffset).toBeGreaterThan(help.viewport.scrollOffset);
    const out = panelText(renderPanel(scrolled, 40, 8));
    expect(out).toContain(PANEL_HINT_READONLY);
    expect(out).toContain("esc close");
    expect(out).toContain("enter home");
    expect(out).toContain("↑↓ scroll");
    expect(out).not.toContain(PANEL_PROMPT);
    expect(executed(feed(help, "\x1b[B").actions)).toEqual([]);
  });
});

describe("AR-10 route/scroll/resize never execute", () => {
  it("route, scroll, and resize transitions cannot execute commands or corrupt alternate-screen teardown", () => {
    const home = openHome();
    const arrows = feed(home, "\x1b[A", "\x1b[B", "\x1b[B");
    expect(executed(arrows.actions)).toEqual([]);
    expect(arrows.state.mode).toBe("modal");
    const help = feed(home, "help\r");
    const scroll = feed(help.state, "\x1b[B", "\x1b[A");
    expect(executed([...help.actions, ...scroll.actions])).toEqual([]);
    const resized = clampPanelViewport(scroll.state, 20, 5);
    expect(resized.route).toBe("help");
    expect(resized.mode).toBe("modal");
    const out = panelText(renderPanel(resized, 20, 5));
    expect(out).toContain("esc close");
    expect(PANEL_HINT_SURVIVAL.length).toBeLessThanOrEqual(18);
    const close = feed(resized, "\x03");
    expect(close.actions).toEqual([{ kind: "exit_modal" }]);
    expect(close.state.mode).toBe("passthrough");
    expect(HOME_ACTIONS.map((action) => action.label)).toEqual([
      "Smart Compact",
      "Smart Prune",
      "Band allocation",
      "Help",
      "Introduction",
    ]);
  });
});

async function waitFor(condition: () => boolean, label: string, capMs = 8_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > capMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
