/**
 * Slash-command autocomplete: registry-backed suggestions, completion that is
 * never execution, and one completion key however the terminal encodes Tab.
 */
import { describe, expect, it } from "vitest";

import {
  createInputState,
  DEFAULT_LEADER_BYTE,
  type InputAction,
  type InputState,
  processInputChunk,
  selectedSuggestion,
  suggestionsOpen,
} from "../../src/wrapper/modal.js";
import {
  ACTION_CARET,
  FOCUS_CARET,
  PANEL_HINT_SUGGESTIONS,
  PANEL_PROMPT,
  renderPanel,
  SUGGESTION_ROWS_COMPACT,
  SUGGESTION_ROWS_FULL,
  SUGGESTIONS_HEADING,
} from "../../src/wrapper/panel.js";
import {
  buildPanelViewSnapshot,
  commandSuggestions,
  completeCommandLine,
  exactCommandName,
  HOME_ACTIONS,
  homeCursorLength,
  PANEL_COMMANDS,
} from "../../src/wrapper/panel-commands.js";
import { cardBodyRows, containsSgr, drawnRows, panelText } from "../helpers/panel-text.js";

/** The drawn menu block: the rows between the Suggestions heading and the blank after it. */
function menuRows(output: string, cols: number, rows: number): string[] {
  const body = cardBodyRows(output, cols, rows);
  const heading = body.findIndex((row) => row.trim() === SUGGESTIONS_HEADING);
  if (heading < 0) return [];
  const block: string[] = [];
  for (const row of body.slice(heading + 1)) {
    if (row.trim() === "") break;
    block.push(row);
  }
  return block;
}

const LEADER = Buffer.from([DEFAULT_LEADER_BYTE]);
const VIEW = buildPanelViewSnapshot({
  providerContextTokens: 84_000,
  targetTokens: 100_000,
  triggerTokens: 200_000,
  autoCompact: true,
  captureHealth: "ready",
  profile: "balanced",
});

/** Raw Tab, kitty CSI-u Tab, and Windows Terminal win32 Tab. */
const TAB_RAW = "\t";
const TAB_KITTY = "\x1b[9;1u";
const TAB_WIN32 = "\x1b[9;15;9;1;0;1_";

function feed(
  state: InputState,
  ...chunks: Array<string | Buffer>
): { state: InputState; actions: InputAction[]; pty: string } {
  let current = state;
  const actions: InputAction[] = [];
  let pty = "";
  for (const chunk of chunks) {
    const result = processInputChunk(typeof chunk === "string" ? Buffer.from(chunk, "latin1") : chunk, current);
    current = result.state;
    actions.push(...result.actions);
    pty += result.toPty.toString("latin1");
  }
  return { state: current, actions, pty };
}

function openHome(): InputState {
  return { ...feed(createInputState(), LEADER).state, panelView: VIEW };
}

function executed(actions: readonly InputAction[]): string[] {
  return actions.flatMap((action) => (action.kind === "execute" ? [action.commandLine] : []));
}

describe("suggestions come from the command registry", () => {
  it("opens on / with every canonical command, and filters by prefix", () => {
    const all = commandSuggestions("/");
    expect(all.map((entry) => entry.name)).toEqual(PANEL_COMMANDS.map((command) => command.name));
    for (const entry of all) {
      const command = PANEL_COMMANDS.find((candidate) => candidate.name === entry.name)!;
      expect(entry.usage).toBe(command.usage);
      expect(entry.description).toBe(command.short);
    }

    expect(commandSuggestions("/s").map((entry) => entry.name)).toEqual([
      "/status",
      "/smart-compact",
      "/smart-prune",
      "/stats",
    ]);
    expect(commandSuggestions("/sm").map((entry) => entry.name)).toEqual(["/smart-compact", "/smart-prune"]);
    expect(commandSuggestions("/smart-c").map((entry) => entry.name)).toEqual(["/smart-compact"]);
    // An exact command keeps exactly its own usage row.
    expect(commandSuggestions("/auto").map((entry) => entry.usage)).toEqual(["/auto on|off"]);
    expect(commandSuggestions("/smart-prune 2500").map((entry) => entry.usage)).toEqual(["/smart-prune [tokens]"]);
    // Unknown prefixes, non-slash input, and empty lines suggest nothing.
    for (const line of ["/zzz", "smart", "status", "", "   ", "hello /status"]) {
      expect(commandSuggestions(line), line).toEqual([]);
    }
    // Case-sensitive, like the parser.
    expect(commandSuggestions("/S")).toEqual([]);
  });

  it("is the only suggestion list: renaming a registry entry moves every surface", () => {
    // Home rows, Help rows, parser lookup, and suggestions all read the same
    // objects — there is no second array to fall out of step.
    for (const action of HOME_ACTIONS) {
      const command = PANEL_COMMANDS.find((entry) => entry.name === action.label);
      expect(command, `${action.label} is not a registry command`).toBeDefined();
      expect(action.description).toBe(command!.short);
      expect(commandSuggestions(action.label).map((entry) => entry.name)).toContain(action.label);
    }
    const suggestionNames = commandSuggestions("/").map((entry) => entry.name);
    expect(suggestionNames).toHaveLength(PANEL_COMMANDS.length);
    expect(new Set(suggestionNames).size).toBe(PANEL_COMMANDS.length);
    for (const command of PANEL_COMMANDS) {
      expect(exactCommandName(command.name)).toBe(command.name);
      expect(suggestionNames).toContain(command.name);
    }
  });

  it("completes only the command token and keeps typed arguments", () => {
    expect(completeCommandLine("/sm", "/smart-prune")).toBe("/smart-prune");
    expect(completeCommandLine("/sm 2500", "/smart-prune")).toBe("/smart-prune 2500");
    expect(completeCommandLine("  /au on", "/auto")).toBe("/auto on");
    expect(completeCommandLine("", "/help")).toBe("/help");
  });
});

describe("the suggestion menu owns the arrows while it is open", () => {
  it("selects with Up/Down without moving the Home cursor", () => {
    const home = feed(openHome(), "\x1b[B", "\x1b[B").state; // park the Home cursor
    const parked = home.viewport.scrollOffset;
    expect(parked).toBe(2);

    const typed = feed(home, "/s").state;
    expect(suggestionsOpen(typed)).toBe(true);
    expect(selectedSuggestion(typed)?.name).toBe("/status");

    const down = feed(typed, "\x1b[B").state;
    expect(selectedSuggestion(down)?.name).toBe("/smart-compact");
    expect(down.viewport.scrollOffset, "the Home cursor moved").toBe(parked);

    const twice = feed(down, "\x1b[B", "\x1b[B").state;
    expect(selectedSuggestion(twice)?.name).toBe("/stats");
    // Clamped at the ends, never wrapping past the list.
    expect(selectedSuggestion(feed(twice, "\x1b[B", "\x1b[B").state)?.name).toBe("/stats");
    expect(selectedSuggestion(feed(twice, "\x1b[A", "\x1b[A", "\x1b[A", "\x1b[A").state)?.name).toBe("/status");

    // Clearing the line hands the arrows back with the cursor where it was.
    const cleared = feed(twice, "\x15").state;
    expect(suggestionsOpen(cleared)).toBe(false);
    expect(cleared.viewport.scrollOffset).toBe(parked);
    const moved = feed(cleared, "\x1b[B").state;
    expect(moved.viewport.scrollOffset).toBe(parked + 1);
  });

  it("recomputes on backspace and clear", () => {
    const typed = feed(openHome(), "/smart-c").state;
    expect(commandSuggestions(typed.line).map((entry) => entry.name)).toEqual(["/smart-compact"]);
    const back = feed(typed, "\x7f\x7f").state;
    expect(back.line).toBe("/smart");
    expect(commandSuggestions(back.line).map((entry) => entry.name)).toEqual(["/smart-compact", "/smart-prune"]);
    // Selection returns to the first row rather than pointing at a stale entry.
    const selectedThenEdited = feed(feed(typed, "\x1b[B").state, "\x7f").state;
    expect(selectedThenEdited.suggestionIndex).toBe(0);
    const emptied = feed(back, "\x15").state;
    expect(commandSuggestions(emptied.line)).toEqual([]);
    expect(suggestionsOpen(emptied)).toBe(false);
  });
});

describe("completion is never execution", () => {
  it("Tab completes the selected command and runs nothing", () => {
    for (const tab of [TAB_RAW, TAB_KITTY, TAB_WIN32]) {
      const typed = feed(openHome(), "/sm");
      const completed = feed(typed.state, tab);
      expect(completed.state.line, tab).toBe("/smart-compact");
      expect(executed(completed.actions), tab).toEqual([]);
      expect(completed.state.mode, tab).toBe("modal");
      // Terminal protocol bytes never reach Claude, and never become text.
      expect(completed.pty, tab).toBe("");
      expect(completed.state.line, tab).not.toContain("\x1b");
      expect(completed.state.line, tab).not.toContain("[9");

      // The second Tab is idempotent: the token is already canonical.
      const again = feed(completed.state, tab);
      expect(again.state.line, tab).toBe("/smart-compact");
      expect(executed(again.actions), tab).toEqual([]);
    }
  });

  it("Tab completes the row the arrows selected, and keeps arguments", () => {
    const chosen = feed(openHome(), "/sm", "\x1b[B", TAB_RAW);
    expect(chosen.state.line).toBe("/smart-prune");
    expect(executed(chosen.actions)).toEqual([]);

    const withArgs = feed(openHome(), "/sm 2500", "\x1b[B", TAB_RAW);
    expect(withArgs.state.line).toBe("/smart-prune 2500");
    expect(executed(withArgs.actions)).toEqual([]);
  });

  it("Enter completes a partial command, and only executes an exact one", () => {
    const partial = feed(openHome(), "/sm\r");
    expect(partial.state.line).toBe("/smart-compact");
    expect(executed(partial.actions)).toEqual([]);
    expect(partial.state.mode).toBe("modal");

    // A second Enter now runs the command the user can read on the line.
    const run = feed(partial.state, "\r");
    expect(executed(run.actions)).toEqual(["/lhc-compact"]);
    expect(run.state.mode).toBe("executing");

    // Routes behave the same way.
    const route = feed(openHome(), "/intro\r");
    expect(route.state.line).toBe("/introduction");
    expect(route.state.route).toBe("home");
    expect(feed(route.state, "\r").state.route).toBe("introduction");

    // Exact command plus valid arguments executes on the first Enter.
    const exact = feed(openHome(), "/smart-prune 2500\r");
    expect(executed(exact.actions)).toEqual(["/lhc-prune 2500"]);

    // Exact command plus invalid arguments stays parser-owned.
    const invalid = feed(openHome(), "/smart-prune lots\r");
    expect(executed(invalid.actions)).toEqual([]);
    expect(invalid.state.panelRows[0]).toContain("invalid /smart-prune target");

    // A prefix that matches nothing is not completed into something else.
    const nothing = feed(openHome(), "/zz\r");
    expect(nothing.state.panelRows[0]).toBe("unknown command: /zz");
  });

  it("shows argument usage without completing argument values", () => {
    for (const [line, usage] of [
      ["/smart-prune", "/smart-prune [tokens]"],
      ["/auto", "/auto on|off"],
      ["/bounds", "/bounds <target> <trigger>"],
    ] as const) {
      const state = feed(openHome(), line).state;
      const rows = commandSuggestions(state.line);
      expect(
        rows.map((entry) => entry.usage),
        line,
      ).toEqual([usage]);
      // Tab does not invent an argument value.
      const tabbed = feed(state, TAB_RAW).state;
      expect(tabbed.line, line).toBe(line);
    }
    // Argument values are never suggested.
    expect(commandSuggestions("/auto o").map((entry) => entry.usage)).toEqual(["/auto on|off"]);
    expect(feed(openHome(), "/auto o", TAB_RAW).state.line).toBe("/auto o");
  });

  it("leaves Esc meaning exit, with no second dismissal state", () => {
    const open = feed(openHome(), "/sm");
    expect(suggestionsOpen(open.state)).toBe(true);
    // Esc closes the Control Panel from here, exactly as it does with the menu
    // closed — the menu never swallows the first Esc.
    const escaped = feed(open.state, "\x03");
    expect(escaped.actions).toEqual([{ kind: "exit_modal" }]);
    expect(escaped.state.mode).toBe("passthrough");
  });

  it("never opens on non-slash input", () => {
    for (const line of ["status", "hello", "Smart Compact"]) {
      const state = feed(openHome(), line).state;
      expect(suggestionsOpen(state), line).toBe(false);
      const tabbed = feed(state, TAB_RAW).state;
      expect(tabbed.line, line).toBe(line);
      expect(panelText(renderPanel(state, 100, 29)), line).not.toContain(SUGGESTIONS_HEADING);
    }
  });
});

describe("the menu is drawn within bounds at every size", () => {
  it("shows at most five rows at normal size, with the selection visible", () => {
    const state = feed(openHome(), "/").state;
    const menu = menuRows(renderPanel(state, 100, 29), 100, 29);
    expect(menu.length).toBeLessThanOrEqual(SUGGESTION_ROWS_FULL);
    expect(menu.length).toBeGreaterThan(0);
    expect(menu[0]!.trimStart().startsWith(ACTION_CARET)).toBe(true);
    expect(menu[0]).toContain("/status");
    // Prompt and exit hint stay on screen with the menu open.
    const drawn = drawnRows(renderPanel(state, 100, 29), 100, 29);
    expect(drawn.some((row) => row.includes(`${PANEL_PROMPT}/`))).toBe(true);
    expect(drawn[drawn.length - 1]).toBe(PANEL_HINT_SUGGESTIONS);
  });

  it("windows to the selected row when the list is longer than the menu", () => {
    let state = feed(openHome(), "/").state;
    for (let step = 0; step < PANEL_COMMANDS.length; step += 1) state = feed(state, "\x1b[B").state;
    const selected = selectedSuggestion(state)!;
    expect(selected.name).toBe(PANEL_COMMANDS[PANEL_COMMANDS.length - 1]!.name);
    const menu = menuRows(renderPanel(state, 100, 29), 100, 29);
    expect(menu.some((row) => row.includes(selected.usage))).toBe(true);
    expect(menu.filter((row) => row.trimStart().startsWith(ACTION_CARET)).length).toBeGreaterThan(0);
  });

  it("keeps the menu bounded at narrow size and to one row at 20x5", () => {
    const state = feed(openHome(), "/s").state;

    const narrowMenu = menuRows(renderPanel(state, 44, 20), 44, 20);
    const narrowCommands = narrowMenu.filter(
      (row) => row.trimStart().startsWith(ACTION_CARET) || row.trimStart().startsWith("/"),
    );
    expect(narrowCommands.length).toBeLessThanOrEqual(SUGGESTION_ROWS_COMPACT);
    expect(narrowCommands.length).toBeGreaterThan(0);
    for (const row of cardBodyRows(renderPanel(state, 44, 20), 44, 20)) expect(row.length).toBeLessThanOrEqual(44);

    const survival = drawnRows(renderPanel(state, 20, 5), 20, 5);
    expect(survival.length).toBeLessThanOrEqual(5);
    for (const row of survival) expect(row.length).toBeLessThanOrEqual(20);
    const selectedRows = survival.filter((row) => row.startsWith(FOCUS_CARET));
    expect(selectedRows, "one selected suggestion, distinct from the prompt").toHaveLength(1);
    expect(selectedRows[0]).toContain("/status");
    expect(survival.some((row) => row.startsWith(`${PANEL_PROMPT}/s`))).toBe(true);
    expect(survival[survival.length - 1]).toContain("esc");
  });

  it("marks the selected suggestion without colour and without attributes", () => {
    const state = feed(openHome(), "/s", "\x1b[B").state;
    const plain = renderPanel(state, 100, 29, undefined, { color: false, attributes: false });
    expect(containsSgr(plain)).toBe(false);
    const menu = menuRows(plain, 100, 29);
    const marked = menu.filter((row) => row.trimStart().startsWith(ACTION_CARET));
    expect(marked, "exactly one suggestion carries the caret").toHaveLength(1);
    expect(marked[0]).toContain("/smart-compact");
  });

  it("does not draw suggestions while a command is executing", () => {
    const executing = feed(openHome(), "/status\r");
    expect(executing.state.mode).toBe("executing");
    expect(suggestionsOpen(executing.state)).toBe(false);
    expect(panelText(renderPanel(executing.state, 100, 29))).not.toContain(SUGGESTIONS_HEADING);
  });

  it("leaves Home navigation reachable with the menu closed", () => {
    // Sanity: the unified cursor still spans status rows plus command rows.
    expect(homeCursorLength()).toBe(10 + HOME_ACTIONS.length);
  });
});
