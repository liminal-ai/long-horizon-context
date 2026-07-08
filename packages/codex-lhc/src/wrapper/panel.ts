// Alt-screen command panel. The modal stopped sharing Codex's canvas:
// in-place rows wedged below the TUI input box and newline scrolling pushed its
// layout around. On modal entry the wrapper switches to the terminal's
// ALTERNATE SCREEN (?1049h) and draws a centered panel on the blank canvas;
// any dismissal leaves it (?1049l), which restores Codex's screen exactly —
// Codex never emits alt-screen switches itself and its output is held while the
// modal is open, so the two buffers cannot fight. Held output flushes AFTER
// the restore, so ordering on the main screen is intact.

import type { InputState } from "./modal.js";

export const PANEL_PROMPT = "long-horizon commands> ";
export const PANEL_HINT = "Enter run · Esc close · ctrl-C detach";
/** Shown while a command runs — Esc is dropped in executing mode. */
export const PANEL_HINT_EXECUTING = "ctrl-C detach";

/** Static progress line for swap commands during rebuild; null for non-swap commands. */
export function swapCommandProgressLabel(commandLine: string): string | null {
  const name = commandLine.trim().split(/\s+/)[0] ?? "";
  if (name === "compact" || name === "prune") return `${name} — rebuilding…`;
  return null;
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

/**
 * Full positioned redraw of the panel, centered for the given terminal size:
 * receipt/notice rows, the prompt line with the current input (or the running
 * command while executing), and a dim key-hint line. Idempotent — run.ts
 * calls it after every input chunk and on resize while the modal is open.
 * The real cursor sits at the end of the input while editing and is hidden
 * while a command runs.
 */
export function renderPanel(state: InputState, cols: number, rows: number): string {
  const safeCols = Math.max(20, cols);
  const safeRows = Math.max(5, rows);
  const maxWidth = safeCols - 2;
  const truncate = (text: string): string => (text.length > maxWidth ? `${text.slice(0, maxWidth - 1)}…` : text);

  const lines: PanelLine[] = [];
  for (const row of state.panelRows) lines.push({ text: truncate(row) });
  if (state.panelRows.length > 0) lines.push({ text: "" });

  const swapProgress =
    state.mode === "executing" ? swapCommandProgressLabel(state.line) : null;
  if (swapProgress !== null) {
    lines.push({ text: truncate(swapProgress) });
    lines.push({ text: "" });
    lines.push({ text: truncate(PANEL_HINT_EXECUTING), dim: true });
  } else {
    lines.push({ text: truncate(PANEL_PROMPT + state.line), prompt: true });
    lines.push({ text: "" });
    lines.push({
      text: truncate(state.mode === "executing" ? PANEL_HINT_EXECUTING : PANEL_HINT),
      dim: true,
    });
  }

  const blockWidth = Math.max(...lines.map((line) => line.text.length));
  const left = Math.max(1, Math.floor((safeCols - blockWidth) / 2) + 1);
  const top = Math.max(1, Math.floor((safeRows - lines.length) / 2) + 1);

  let out = HIDE_CURSOR + CLEAR_SCREEN;
  let cursorRow = top;
  let cursorCol = left;
  lines.forEach((line, index) => {
    if (line.text !== "") {
      out += moveTo(top + index, left) + (line.dim === true ? DIM + line.text + UNDIM : line.text);
    }
    if (line.prompt === true) {
      cursorRow = top + index;
      cursorCol = left + line.text.length;
    }
  });
  out += moveTo(cursorRow, cursorCol);
  if (state.mode === "modal") out += SHOW_CURSOR;
  return out;
}
