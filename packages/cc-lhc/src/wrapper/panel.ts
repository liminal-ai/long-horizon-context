// Alt-screen command panel. The modal stopped sharing Claude Code's canvas:
// in-place rows wedged below CC's input box and newline scrolling pushed its
// layout around. On modal entry the wrapper switches to the terminal's
// ALTERNATE SCREEN (?1049h) and draws a centered panel on the blank canvas;
// any dismissal leaves it (?1049l), which restores CC's screen exactly —
// CC never emits alt-screen switches itself and its output is held while the
// modal is open, so the two buffers cannot fight. Held output flushes AFTER
// the restore, so ordering on the main screen is intact.

import { COMPACT_CONFIRM_HINT } from "./compact-confirm.js";
import type { InputState } from "./modal.js";
import {
  focusedHomeBodyRow,
  helpLines,
  homeActionLines,
  homeStatusRows,
  introductionLines,
  PANEL_TITLE,
} from "./panel-commands.js";
import { allocationSelectorChoices } from "./preset-presentation.js";

export const PANEL_PROMPT = "long-horizon commands> ";
export const PANEL_HINT = "Esc/ctrl-C close · Enter run · arrows select";
/** Shown while a command runs — Esc/ctrl-C/leader all detach in executing mode. */
export const PANEL_HINT_EXECUTING = "Esc/ctrl-C detach · command keeps running";
export const PANEL_HINT_READONLY = "Esc close · Enter Home · arrows scroll";
export const PANEL_HINT_ALLOCATION = "Esc/ctrl-C close · Enter apply · arrows select";
/** Notifier overlay: two answers only; the typed command stays in Claude's input line. */
export const NOTIFIER_HINT = "Enter continue · Esc/n return (your typed line stays put)";

/**
 * Progress line while a command executes. Every command gets one — a panel
 * that keeps showing the prompt with a frozen line is indistinguishable from
 * a hang, which is exactly how the modal used to read during a slow `status`.
 */
export function commandProgressLabel(commandLine: string, elapsedSeconds?: number): string {
  const name = commandLine.trim().split(/\s+/)[0] ?? "";
  const rebuilding =
    name === "smart-compact" || name === "smart-prune" || name === "compact" || name === "prune";
  const verb = rebuilding ? "rebuilding…" : "running…";
  const elapsed = elapsedSeconds !== undefined && elapsedSeconds >= 1 ? ` (${elapsedSeconds}s)` : "";
  return `${name === "" ? "command" : name} — ${verb}${elapsed}`;
}

/** Switch to the alternate screen (saves main screen + cursor). */
export const ENTER_ALT_SCREEN = "\x1b[?1049h";
/** Leave the alternate screen and re-show the cursor (restores main screen). */
export const LEAVE_ALT_SCREEN = "\x1b[?1049l\x1b[?25h";

export interface AltScreenGuard {
  readonly active: boolean;
  enter(): void;
  leave(): void;
}

/**
 * Tracks whether ?1049h is in effect so EVERY exit path — including the
 * process-exit hook after a crash, signal handlers, and stdin loss — can
 * restore the terminal exactly once. enter/leave are idempotent: a blind
 * double-leave would scroll some terminals' main screens, and a missed leave
 * strands the user on a blank alternate screen.
 */
export function createAltScreenGuard(write: (data: string) => void): AltScreenGuard {
  let active = false;
  return {
    get active() {
      return active;
    },
    enter() {
      if (active) return;
      active = true;
      write(ENTER_ALT_SCREEN);
    },
    leave() {
      if (!active) return;
      active = false;
      write(LEAVE_ALT_SCREEN);
    },
  };
}

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_SCREEN = "\x1b[2J";
const DIM = "\x1b[2m";
const UNDIM = "\x1b[22m";

function moveTo(row: number, col: number): string {
  return `\x1b[${row};${col}H`;
}

interface PanelLine {
  text: string;
  dim?: boolean;
  prompt?: boolean;
}

function clipBody(body: string[], budget: number, scrollOffset: number): string[] {
  if (budget <= 0) return [];
  if (body.length <= budget) return body;
  const maxStart = Math.max(0, body.length - budget);
  const start = Math.max(0, Math.min(maxStart, scrollOffset));
  const window = body.slice(start, start + budget);
  if (start + budget < body.length && window.length > 0) {
    return [...window.slice(0, Math.max(0, window.length - 1)), "… more — enlarge terminal"];
  }
  if (start > 0 && window.length > 0) {
    return ["… more — enlarge terminal", ...window.slice(1)];
  }
  return window;
}

function windowAroundFocus(rows: string[], budget: number, focus: number): string[] {
  if (budget <= 0) return [];
  if (rows.length <= budget) return rows;
  const focusIndex = Math.max(0, Math.min(rows.length - 1, focus));
  let start = focusIndex - Math.floor((budget - 1) / 2);
  start = Math.max(0, Math.min(rows.length - budget, start));
  if (focusIndex < start) start = focusIndex;
  if (focusIndex >= start + budget) start = Math.max(0, focusIndex - budget + 1);
  return rows.slice(start, start + budget);
}

function homeBody(state: InputState, budget: number): string[] {
  const statusRows = state.panelView === null ? [] : homeStatusRows(state.panelView);
  const status = statusRows.map((row) => row.text);
  const actions = homeActionLines(state.viewport.selectedIndex);
  const main = [PANEL_TITLE, ...status, "", ...actions];
  const focus = focusedHomeBodyRow(state.viewport.scrollOffset, statusRows);
  const receipts = state.panelRows;
  if (receipts.length === 0) return windowAroundFocus(main, budget, focus);
  const receiptBlock = ["", ...receipts];
  const receiptBudget = Math.min(receiptBlock.length, Math.max(1, budget - 2));
  const clippedReceipts = clipBody(receiptBlock, receiptBudget, Math.max(0, receiptBlock.length - receiptBudget));
  const mainBudget = Math.max(0, budget - clippedReceipts.length);
  return [...windowAroundFocus(main, mainBudget, focus), ...clippedReceipts];
}

function readonlyBody(state: InputState): string[] {
  const title = state.route === "help" ? "Help" : "Introduction";
  const body = state.route === "help" ? helpLines(state.panelView) : introductionLines(state.panelView);
  return [title, ...body];
}

/**
 * Full positioned redraw of the panel, centered for the given terminal size.
 * Home keeps the only command box. Help/Introduction/Allocation are read-only.
 * Rows beyond the terminal are clipped; title, command entry (Home), and the
 * exit hint remain in the height budget so a small terminal stays operable.
 */
export function renderPanel(state: InputState, cols: number, rows: number, elapsedSeconds?: number): string {
  const safeCols = Math.max(20, cols);
  const safeRows = Math.max(5, rows);
  const maxWidth = safeCols - 2;
  const truncate = (text: string): string => (text.length > maxWidth ? `${text.slice(0, maxWidth - 1)}…` : text);

  const lines: PanelLine[] = [];
  const push = (text: string, opts: { dim?: boolean; prompt?: boolean } = {}): void => {
    lines.push({ text: truncate(text), ...opts });
  };

  if (state.mode === "compact_confirm") {
    const rowBudget = Math.max(0, safeRows - 2);
    let panelRows = state.panelRows;
    if (panelRows.length > rowBudget) {
      const shown = Math.max(0, rowBudget - 1);
      panelRows = [...panelRows.slice(0, shown), "… more — enlarge terminal"];
    }
    for (const row of panelRows) push(row);
    if (panelRows.length > 0) push("");
    push(COMPACT_CONFIRM_HINT, { dim: true });
  } else if (state.mode === "notifier") {
    push(`Claude ${state.notifierCommand} can invalidate cc-lhc session capture/binding`);
    push("");
    push(NOTIFIER_HINT, { dim: true });
  } else if (state.mode === "executing") {
    const body = homeBody(state, Math.max(0, safeRows - 2));
    for (const row of body) push(row);
    push(commandProgressLabel(state.line, elapsedSeconds));
    push(PANEL_HINT_EXECUTING, { dim: true });
  } else if (state.route === "help" || state.route === "introduction") {
    const body = clipBody(readonlyBody(state), Math.max(1, safeRows - 1), state.viewport.scrollOffset);
    for (const row of body) push(row);
    push(PANEL_HINT_READONLY, { dim: true });
  } else if (state.route === "allocation") {
    const choices = allocationSelectorChoices(state.panelView?.allocationId ?? "default");
    const labels = choices.map(
      (choice, index) => `${index === state.viewport.selectedIndex ? ">" : " "} ${choice.label}`,
    );
    const details = choices.flatMap((choice) => [`    ${choice.description}`]);
    const body = clipBody([...labels, "Band allocation", ...details], Math.max(1, safeRows - 1), 0);
    for (const row of body) push(row);
    push(PANEL_HINT_ALLOCATION, { dim: true });
  } else {
    const body = homeBody(state, Math.max(0, safeRows - 2));
    for (const row of body) push(row);
    push(PANEL_PROMPT + state.line, { prompt: true });
    push(PANEL_HINT, { dim: true });
  }

  const blockWidth = Math.max(1, ...lines.map((line) => line.text.length));
  const left = Math.max(1, Math.floor((safeCols - blockWidth) / 2) + 1);
  const top = Math.max(1, Math.floor((safeRows - lines.length) / 2) + 1);

  let out = HIDE_CURSOR + CLEAR_SCREEN;
  let cursorRow = top;
  let cursorCol = left;
  lines.forEach((line, index) => {
    const row = Math.min(safeRows, top + index);
    if (line.text !== "") {
      out += moveTo(row, left) + (line.dim === true ? DIM + line.text + UNDIM : line.text);
    }
    if (line.prompt === true) {
      cursorRow = row;
      cursorCol = left + line.text.length;
    }
  });
  out += moveTo(cursorRow, Math.min(safeCols, cursorCol));
  if (state.mode === "modal" && state.route === "home") out += SHOW_CURSOR;
  return out;
}
