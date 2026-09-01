// Alt-screen command panel. The modal stopped sharing Claude Code's canvas:
// in-place rows wedged below CC's input box and newline scrolling pushed its
// layout around. On modal entry the wrapper switches to the terminal's
// ALTERNATE SCREEN (?1049h) and draws a centered panel on the blank canvas;
// any dismissal leaves it (?1049l), which restores CC's screen exactly —
// CC never emits alt-screen switches itself and its output is held while the
// modal is open, so the two buffers cannot fight. Held output flushes AFTER
// the restore, so ordering on the main screen is intact.
//
// Presentation follows Claude Code's own dialog grammar: ONE rounded card
// with its title in the border, a dim label gutter, normal-weight values, a
// single caret for selection, and one dim hint line outside the card. Colour
// is semantic and never load-bearing — selection survives as caret + bold
// without colour, and as caret alone without any attributes, so a no-colour
// terminal still shows the same hierarchy (border, alignment, caret).

import type { InputState } from "./modal.js";
import {
  commandSuggestions,
  focusedHomeStatusId,
  HOME_ACTIONS,
  type HomeStatusCanonicalId,
  type HomeStatusRow,
  homeSelectedActionIndex,
  homeStatusRows,
  homeSummaryLine,
  isReadonlyRoute,
  MODAL_UNKNOWN_PREFIX,
  PANEL_TITLE,
  PANEL_TITLE_SHORT,
  type PanelRow,
  readonlyRouteTitle,
  readonlyRows,
} from "./panel-commands.js";
import { allocationSelectorChoices } from "./preset-presentation.js";

/** Prompt caret. The command line is ours, so it wears Claude Code's caret. */
export const PANEL_PROMPT = "❯ ";
/** Dim placeholder shown in the empty command line. */
export const PANEL_PROMPT_PLACEHOLDER = "type /help for commands";
/** Placeholder for cards too narrow for the full one. */
export const PANEL_PROMPT_PLACEHOLDER_SHORT = "type /help";
/** Section label above the Home command rows. */
export const HOME_COMMANDS_HEADING = "Commands";
/** Section label above the slash-command suggestion menu. */
export const SUGGESTIONS_HEADING = "Suggestions";
/** Suggestion rows drawn at each size tier. */
export const SUGGESTION_ROWS_FULL = 5;
export const SUGGESTION_ROWS_COMPACT = 3;
/** Marker on the in-flight progress row (a notice, not an alarm). */
export const PROGRESS_PREFIX = "⋯ ";
/** Caret on the selected action row. */
export const ACTION_CARET = "❯ ";
/** Marker on the focused status row (never confusable with an action). */
export const FOCUS_CARET = "› ";
const CARET_BLANK = "  ";
/** Prefix on notice/alarm rows, so the state is legible without colour. */
export const NOTICE_PREFIX = "! ";

export const PANEL_HINT = "esc close · enter run · ↑↓ select";
/** Shown while the suggestion menu owns the arrows and Tab completes. */
export const PANEL_HINT_SUGGESTIONS = "esc close · tab complete · ↑↓ select";
/** Shown while a command runs — Esc/ctrl-C/leader all detach in executing mode. */
export const PANEL_HINT_EXECUTING = "esc detach · command keeps running";
export const PANEL_HINT_READONLY = "esc close · enter home · ↑↓ scroll";
export const PANEL_HINT_ALLOCATION = "esc close · enter apply · ↑↓ select";
/** Notifier overlay: two answers only; the typed command stays in Claude's input line. */
export const NOTIFIER_HINT = "Enter continue · Esc/n return (your typed line stays put)";
/** Survival-mode hints: the exit key always survives, whatever else is cut. */
export const PANEL_HINT_SURVIVAL = "esc close · ↵ run";
export const PANEL_HINT_SURVIVAL_READONLY = "esc close · ↵ home";
export const PANEL_HINT_SURVIVAL_EXECUTING = "esc detach";
export const PANEL_HINT_SURVIVAL_ALLOCATION = "esc close · ↵ apply";

const CLIPPED_MARKER = "… more — enlarge terminal";
const MORE_BELOW_MARKER = "↓ more";

/**
 * Progress line while a command executes. Every command gets one — a panel
 * that keeps showing the prompt with a frozen line is indistinguishable from
 * a hang, which is exactly how the modal used to read during a slow `status`.
 */
export function commandProgressLabel(commandLine: string, elapsedSeconds?: number): string {
  const name = commandLine.trim().split(/\s+/)[0] ?? "";
  const rebuilding = name === "/smart-compact" || name === "/smart-prune";
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

function moveTo(row: number, col: number): string {
  return `\x1b[${row};${col}H`;
}

// ---------------------------------------------------------------------------
// Style
// ---------------------------------------------------------------------------

/**
 * What the terminal can carry. Truthful degradation is the contract: with
 * `color` off the caret and bold still mark selection; with `attributes` off
 * the caret, the border, and the gutter alignment still do.
 */
export interface PanelStyle {
  color: boolean;
  attributes: boolean;
}

export function panelStyleFromEnv(env: NodeJS.ProcessEnv = process.env): PanelStyle {
  const dumb = env.TERM === "dumb";
  const noColor = (env.NO_COLOR ?? "") !== "";
  return { color: !dumb && !noColor, attributes: !dumb };
}

type Ink = "normal" | "dim" | "bold" | "accent" | "notice" | "alarm";

interface Span {
  text: string;
  ink: Ink;
}

interface Line {
  spans: Span[];
}

function span(text: string, ink: Ink = "normal"): Span {
  return { text, ink };
}

function ln(...spans: Span[]): Line {
  return { spans: spans.filter((entry) => entry.text !== "") };
}

const BLANK_LINE: Line = { spans: [] };

function lineWidth(line: Line): number {
  let width = 0;
  for (const entry of line.spans) width += entry.text.length;
  return width;
}

/** Hard-clip a composed line to a width, keeping span inks. */
function fitLine(line: Line, width: number): Line {
  if (lineWidth(line) <= width) return line;
  const spans: Span[] = [];
  let used = 0;
  for (const entry of line.spans) {
    const room = width - used;
    if (room <= 0) break;
    if (entry.text.length <= room) {
      spans.push(entry);
      used += entry.text.length;
      continue;
    }
    spans.push(span(truncate(entry.text, room), entry.ink));
    used = width;
  }
  return { spans };
}

function paint(entry: Span, style: PanelStyle): string {
  if (entry.text === "") return "";
  switch (entry.ink) {
    case "dim":
      return style.attributes ? `\x1b[2m${entry.text}\x1b[22m` : entry.text;
    case "bold":
      return style.attributes ? `\x1b[1m${entry.text}\x1b[22m` : entry.text;
    case "accent":
      if (style.color) return `\x1b[1;34m${entry.text}\x1b[22;39m`;
      return style.attributes ? `\x1b[1m${entry.text}\x1b[22m` : entry.text;
    case "notice":
      return style.color ? `\x1b[33m${entry.text}\x1b[39m` : entry.text;
    case "alarm":
      return style.color ? `\x1b[31m${entry.text}\x1b[39m` : entry.text;
    default:
      return entry.text;
  }
}

// ---------------------------------------------------------------------------
// Text fitting
// ---------------------------------------------------------------------------

function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  return width === 1 ? "…" : `${text.slice(0, width - 1)}…`;
}

function padTo(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/** Word wrap that keeps a source line's own indentation on its continuations. */
function wrapPlain(text: string, width: number): string[] {
  if (width <= 0) return [""];
  const indent = /^\s*/.exec(text)?.[0] ?? "";
  const body = text.slice(indent.length);
  if (`${indent}${body}`.length <= width) return [`${indent}${body}`];
  const continuation = indent.length + 2 <= width ? indent : "";
  const lines: string[] = [];
  let current = indent;
  let currentIsEmpty = true;
  for (const word of body.split(/\s+/).filter((entry) => entry !== "")) {
    const candidate = currentIsEmpty ? `${current}${word}` : `${current} ${word}`;
    if (candidate.length <= width) {
      current = candidate;
      currentIsEmpty = false;
      continue;
    }
    if (!currentIsEmpty) {
      lines.push(current);
      current = continuation;
      currentIsEmpty = true;
    }
    let rest = word;
    while (`${current}${rest}`.length > width) {
      const room = width - current.length;
      if (room <= 1) break;
      lines.push(`${current}${rest.slice(0, room)}`);
      rest = rest.slice(room);
      current = continuation;
      currentIsEmpty = true;
    }
    current = `${current}${rest}`;
    currentIsEmpty = rest === "";
  }
  if (!currentIsEmpty || lines.length === 0) lines.push(current);
  return lines;
}

interface ValueUnit {
  text: string;
  /** Separator placed before this unit when it shares a line with the last one. */
  joiner: string;
  ink: Ink;
  id: HomeStatusRowId | null;
}

type HomeStatusRowId = HomeStatusRow["id"];

interface WrappedUnits {
  spans: Span[];
  ids: HomeStatusRowId[];
}

/**
 * Wrap a value line by SEGMENT first: `target 180k` never splits across a
 * line break, so a status fact always reads whole. Only a single oversized
 * segment falls back to word wrapping.
 */
function wrapUnits(units: readonly ValueUnit[], width: number): WrappedUnits[] {
  const lines: WrappedUnits[] = [];
  let spans: Span[] = [];
  let ids: HomeStatusRowId[] = [];
  let used = 0;
  const flush = (): void => {
    if (spans.length === 0 && ids.length === 0) return;
    lines.push({ spans, ids });
    spans = [];
    ids = [];
    used = 0;
  };
  for (const unit of units) {
    const joiner = used === 0 ? "" : unit.joiner;
    if (used + joiner.length + unit.text.length <= width) {
      if (joiner !== "") spans.push(span(joiner, unit.ink));
      spans.push(span(unit.text, unit.ink));
      used += joiner.length + unit.text.length;
      if (unit.id !== null && !ids.includes(unit.id)) ids.push(unit.id);
      continue;
    }
    flush();
    const wrapped = wrapPlain(unit.text, width);
    wrapped.forEach((text, position) => {
      if (position === wrapped.length - 1) {
        spans = [span(text, unit.ink)];
        used = text.length;
        if (unit.id !== null && wrapped.length === 1) ids.push(unit.id);
        return;
      }
      lines.push({ spans: [span(text, unit.ink)], ids: position === 0 && unit.id !== null ? [unit.id] : [] });
    });
  }
  flush();
  return lines.length === 0 ? [{ spans: [], ids: [] }] : lines;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export type PanelTier = "full" | "compact" | "survival";

/**
 * Size tiers. Full keeps the gutter and the action descriptions; compact
 * keeps the card and drops descriptions; survival drops the card for one
 * summary row, one focused row, the command line, and the exit hint.
 */
export function panelTier(cols: number, rows: number): PanelTier {
  if (cols >= 56 && rows >= 12) return "full";
  if (cols >= 30 && rows >= 8) return "compact";
  return "survival";
}

const CARD_MAX_WIDTH = 64;

interface Geometry {
  tier: PanelTier;
  cardWidth: number;
  pad: number;
  contentWidth: number;
  gutter: number;
  /** Body rows available inside the card (hint and borders already reserved). */
  bodyBudget: number;
}

function geometryFor(cols: number, rows: number, tier: PanelTier): Geometry {
  if (tier === "survival") {
    return { tier, cardWidth: cols, pad: 0, contentWidth: cols - 2, gutter: 0, bodyBudget: Math.max(1, rows - 1) };
  }
  const cardWidth = Math.max(20, Math.min(CARD_MAX_WIDTH, cols - 4));
  const pad = tier === "full" ? 2 : 1;
  const contentWidth = cardWidth - 2 - pad * 2;
  const gutter = tier === "full" ? 12 : 8;
  return { tier, cardWidth, pad, contentWidth, gutter, bodyBudget: Math.max(1, rows - 3) };
}

const SHORT_GROUP_LABEL: Record<string, string> = {
  context: "Context",
  capture: "Capture",
  allocation: "Alloc",
};

// ---------------------------------------------------------------------------
// Card drawing
// ---------------------------------------------------------------------------

function borderLine(width: number, title: string, moreBelow: boolean, top: boolean): Line {
  const [open, close] = top ? ["╭", "╮"] : ["╰", "╯"];
  const label = top ? title : moreBelow ? MORE_BELOW_MARKER : "";
  if (label === "" || width < label.length + 7) {
    return ln(span(`${open}${"─".repeat(Math.max(0, width - 2))}${close}`, "dim"));
  }
  const trailing = Math.max(1, width - 5 - label.length);
  return ln(
    span(`${open}─ `, "dim"),
    span(label, top ? "bold" : "dim"),
    span(` ${"─".repeat(trailing)}${close}`, "dim"),
  );
}

function cardLines(title: string, body: readonly Line[], geometry: Geometry, moreBelow: boolean): Line[] {
  const { cardWidth, pad, contentWidth } = geometry;
  const padding = " ".repeat(pad);
  const drawn: Line[] = [borderLine(cardWidth, title, false, true)];
  for (const line of body) {
    // The frame is the contract: nothing may overflow it, whatever the
    // content or the terminal width.
    const fitted = fitLine(line, contentWidth);
    const filler = " ".repeat(Math.max(0, contentWidth - lineWidth(fitted)));
    drawn.push(ln(span("│", "dim"), span(padding), ...fitted.spans, span(`${filler}${padding}`), span("│", "dim")));
  }
  drawn.push(borderLine(cardWidth, "", moreBelow, false));
  return drawn;
}

// ---------------------------------------------------------------------------
// Body builders
// ---------------------------------------------------------------------------

interface Body {
  lines: Line[];
  /** Index of the row the unified cursor is on (Home only). */
  focusLine: number;
}

function statusBody(rows: readonly HomeStatusRow[], geometry: Geometry, focusId: HomeStatusCanonicalId | null): Body {
  const { tier, contentWidth, gutter } = geometry;
  const valueWidth = Math.max(8, contentWidth - CARET_BLANK.length - gutter);
  const lines: Line[] = [];
  let focusLine = 0;
  let index = 0;
  while (index < rows.length && rows[index]!.group !== "notice") {
    const group = rows[index]!.group;
    const groupRows: HomeStatusRow[] = [];
    while (index < rows.length && rows[index]!.group === group) {
      groupRows.push(rows[index]!);
      index += 1;
    }
    const rawLabel = groupRows.find((row) => row.label !== "")?.label ?? "";
    const label = tier === "full" ? rawLabel : (SHORT_GROUP_LABEL[group] ?? rawLabel);
    const valueLines: ValueUnit[][] = [];
    let current: ValueUnit[] = [];
    for (const row of groupRows) {
      if (row.breakBefore && current.length > 0) {
        valueLines.push(current);
        current = [];
      }
      // Compact keeps the fact and drops the description; the fact itself
      // always survives.
      const segments = tier === "full" ? row.segments : row.compactSegments;
      const focused = focusId !== null && row.id === focusId;
      segments.forEach((text, position) => {
        current.push({
          text,
          joiner: position === 0 ? " · " : row.separator,
          // The cursor can sit on one fact inside a shared line: the line
          // carries the caret, the fact itself carries the emphasis.
          ink: focused ? "accent" : position >= row.dimFrom ? "dim" : "normal",
          id: row.id,
        });
      });
    }
    if (current.length > 0) valueLines.push(current);
    let first = true;
    for (const units of valueLines) {
      for (const wrapped of wrapUnits(units, valueWidth)) {
        const focused = focusId !== null && wrapped.ids.includes(focusId);
        if (focused) focusLine = lines.length;
        lines.push(
          ln(
            span(focused ? FOCUS_CARET : CARET_BLANK, "dim"),
            span(padTo(first ? label : "", gutter), "dim"),
            ...wrapped.spans,
          ),
        );
        first = false;
      }
    }
  }
  const notices = rows.slice(index);
  if (notices.length > 0) {
    lines.push(BLANK_LINE);
    for (const notice of notices) {
      const indented = /^\s/.test(notice.text);
      const prefix = indented ? "  " : NOTICE_PREFIX;
      const ink: Ink = notice.tone === "alarm" ? "alarm" : "notice";
      const wrapped = wrapPlain(notice.text.trim(), Math.max(8, contentWidth - CARET_BLANK.length - prefix.length));
      wrapped.forEach((text, position) => {
        const head = position === 0 ? prefix : " ".repeat(prefix.length);
        lines.push(ln(span(CARET_BLANK), span(head, ink), span(text, ink)));
      });
    }
  }
  return { lines, focusLine };
}

/** One selectable command row: caret, command, and (where it fits) outcome. */
function commandRow(
  label: string,
  description: string,
  selected: boolean,
  labelWidth: number,
  geometry: Geometry,
  describe: boolean,
): Line[] {
  const descriptionWidth = geometry.contentWidth - CARET_BLANK.length - labelWidth;
  const caret = span(selected ? ACTION_CARET : CARET_BLANK, selected ? "accent" : "normal");
  if (geometry.tier === "full" && descriptionWidth >= 12) {
    return [
      ln(
        caret,
        span(padTo(label, labelWidth), selected ? "accent" : "normal"),
        span(truncate(description, descriptionWidth), "dim"),
      ),
    ];
  }
  // Too narrow for a description column: the description wraps beneath its
  // command, indented, so the two stay visibly attached.
  const lines = [ln(caret, span(label, selected ? "accent" : "normal"))];
  const indent = "    ";
  const room = geometry.contentWidth - indent.length;
  if (describe && geometry.tier === "compact" && room >= 12) {
    for (const text of wrapPlain(description, room)) lines.push(ln(span(`${indent}${text}`, "dim")));
  }
  return lines;
}

function actionBody(selectedIndex: number, geometry: Geometry): Body {
  const lines: Line[] = [ln(span(CARET_BLANK), span(HOME_COMMANDS_HEADING, "dim"))];
  let focusLine = 0;
  const labelWidth = Math.max(...HOME_ACTIONS.map((action) => action.label.length)) + 2;
  HOME_ACTIONS.forEach((action, index) => {
    const selected = index === selectedIndex;
    if (selected) focusLine = lines.length;
    // Every command keeps its description at narrow sizes; windowing decides
    // how many rows are on screen, not whether they explain themselves.
    lines.push(...commandRow(action.label, action.description, selected, labelWidth, geometry, true));
  });
  return { lines, focusLine };
}

/**
 * The slash-command menu: registry rows filtered by what has been typed, with
 * the selected row carrying the same caret Home uses. It is bounded by tier so
 * the prompt and the exit hint never leave the screen.
 */
function suggestionBody(state: InputState, geometry: Geometry): Line[] {
  const suggestions = commandSuggestions(state.line);
  if (suggestions.length === 0) return [];
  const budget = geometry.tier === "full" ? SUGGESTION_ROWS_FULL : SUGGESTION_ROWS_COMPACT;
  const selected = Math.max(0, Math.min(suggestions.length - 1, state.suggestionIndex));
  const labelWidth = Math.max(...suggestions.map((entry) => entry.usage.length)) + 2;
  const rows = suggestions.flatMap((entry, index) =>
    // The menu is transient: at narrow sizes only the selected row spends a
    // second line on its description.
    commandRow(entry.usage, entry.description, index === selected, labelWidth, geometry, index === selected),
  );
  const shown = windowAroundFocus(rows, budget, selected);
  return [BLANK_LINE, ln(span(CARET_BLANK), span(SUGGESTIONS_HEADING, "dim")), ...shown];
}

function receiptBody(rows: readonly string[], geometry: Geometry): Line[] {
  const { contentWidth } = geometry;
  const lines: Line[] = [ln(span("─".repeat(Math.max(4, Math.min(contentWidth, 24))), "dim"))];
  for (const row of rows) {
    const ink: Ink = row.startsWith(MODAL_UNKNOWN_PREFIX) || row.startsWith("invalid ") ? "alarm" : "normal";
    for (const text of wrapPlain(row, contentWidth)) lines.push(ln(span(text, ink)));
  }
  return lines;
}

function placeholderFor(room: number): string {
  if (PANEL_PROMPT_PLACEHOLDER.length <= room) return PANEL_PROMPT_PLACEHOLDER;
  if (PANEL_PROMPT_PLACEHOLDER_SHORT.length <= room) return PANEL_PROMPT_PLACEHOLDER_SHORT;
  return truncate(PANEL_PROMPT_PLACEHOLDER_SHORT, room);
}

function promptBody(line: string, geometry: Geometry): { line: Line; cursorOffset: number } {
  const room = Math.max(4, geometry.contentWidth - PANEL_PROMPT.length);
  const shown = line.length > room ? line.slice(line.length - room) : line;
  return {
    line:
      shown === ""
        ? ln(span(PANEL_PROMPT, "accent"), span(placeholderFor(room), "dim"))
        : ln(span(PANEL_PROMPT, "accent"), span(shown)),
    cursorOffset: PANEL_PROMPT.length + shown.length,
  };
}

/** Indent for a value whose label was too long for the gutter. */
const STACKED_INDENT = "  ";

/**
 * Put a row's marker on the same visual line as the words it qualifies. If the
 * description already fills the line, the last word comes down with the marker
 * rather than leaving `◦s` stranded on a row of its own.
 */
function attachMarker(wrapped: readonly string[], marker: string, width: number): string[] {
  if (marker === "") return [...wrapped];
  const lines = [...wrapped];
  const lastIndex = Math.max(0, lines.length - 1);
  const last = lines[lastIndex] ?? "";
  const suffix = ` ${marker}`;
  if (last.length + suffix.length <= width) {
    lines[lastIndex] = `${last}${suffix}`;
    return lines;
  }
  const words = last.split(" ");
  if (words.length > 1) {
    const tail = words.pop() ?? "";
    lines[lastIndex] = words.join(" ");
    lines.push(`${tail}${suffix}`);
    return lines;
  }
  lines[lastIndex] = truncate(`${last}${suffix}`, width);
  return lines;
}

function rowsBody(rows: readonly PanelRow[], geometry: Geometry): Line[] {
  const { contentWidth, gutter } = geometry;
  const labels = rows.flatMap((row) =>
    row.kind === "pair" && row.ownGutter !== true ? [(row.label ?? "").length] : [],
  );
  // The label column is shared so the screen scans as a table, but it never
  // eats more than half the card: an outlier label stacks above its value
  // instead of squeezing every other row into a paragraph.
  const sharedGutter =
    labels.length === 0 ? gutter : Math.min(Math.max(...labels) + 2, Math.max(10, Math.floor(contentWidth * 0.5)));
  const lines: Line[] = [];
  for (const row of rows) {
    if (row.kind === "blank") {
      lines.push(BLANK_LINE);
      continue;
    }
    if (row.kind === "pair") {
      const label = row.label ?? "";
      const marker = row.marker ?? "";
      const valueInk: Ink = row.dimValue === true ? "dim" : "normal";
      const pairGutter = row.ownGutter === true ? Math.min(label.length + 2, sharedGutter) : sharedGutter;
      const stacked = label.length > pairGutter - 2;
      const width = Math.max(8, contentWidth - (stacked ? STACKED_INDENT.length : pairGutter));
      const wrapped = attachMarker(wrapPlain(row.value ?? "", width), marker, width);
      if (stacked) lines.push(ln(span(label, "dim")));
      wrapped.forEach((text, position) => {
        const head = stacked ? STACKED_INDENT : padTo(position === 0 ? label : "", pairGutter);
        lines.push(ln(span(head, "dim"), span(text, valueInk)));
      });
      continue;
    }
    const ink: Ink = row.kind === "text" ? "normal" : "dim";
    for (const text of wrapPlain(row.value ?? "", contentWidth)) lines.push(ln(span(text, ink)));
  }
  return lines;
}

function allocationBody(state: InputState, geometry: Geometry): Line[] {
  const choices = allocationSelectorChoices(state.panelView?.allocationId ?? "default");
  const labelWidth = Math.max(...choices.map((choice) => choice.label.length)) + 2;
  const descriptionWidth = geometry.contentWidth - CARET_BLANK.length - labelWidth;
  return choices.map((choice, index) => {
    const selected = index === state.viewport.selectedIndex;
    const showDescription = geometry.tier === "full" && descriptionWidth >= 12;
    const trailing = choice.selected ? " · current" : "";
    return ln(
      span(selected ? ACTION_CARET : CARET_BLANK, selected ? "accent" : "normal"),
      span(showDescription ? padTo(choice.label, labelWidth) : choice.label, selected ? "accent" : "normal"),
      span(showDescription ? truncate(`${choice.description}${trailing}`, descriptionWidth) : trailing, "dim"),
    );
  });
}

// ---------------------------------------------------------------------------
// Clipping / windowing
// ---------------------------------------------------------------------------

function clipBody(body: readonly Line[], budget: number, scrollOffset: number): { lines: Line[]; moreBelow: boolean } {
  if (budget <= 0) return { lines: [], moreBelow: body.length > 0 };
  if (body.length <= budget) return { lines: [...body], moreBelow: false };
  const maxStart = Math.max(0, body.length - budget);
  const start = Math.max(0, Math.min(maxStart, scrollOffset));
  const window = body.slice(start, start + budget);
  if (start + budget < body.length && window.length > 0) {
    return {
      lines: [...window.slice(0, Math.max(0, window.length - 1)), ln(span(CLIPPED_MARKER, "dim"))],
      moreBelow: true,
    };
  }
  if (start > 0 && window.length > 0) {
    return { lines: [ln(span(CLIPPED_MARKER, "dim")), ...window.slice(1)], moreBelow: false };
  }
  return { lines: window, moreBelow: start + budget < body.length };
}

function windowAroundFocus(rows: readonly Line[], budget: number, focus: number): Line[] {
  if (budget <= 0) return [];
  if (rows.length <= budget) return [...rows];
  const focusIndex = Math.max(0, Math.min(rows.length - 1, focus));
  let start = focusIndex - Math.floor((budget - 1) / 2);
  start = Math.max(0, Math.min(rows.length - budget, start));
  if (focusIndex < start) start = focusIndex;
  if (focusIndex >= start + budget) start = Math.max(0, focusIndex - budget + 1);
  return rows.slice(start, start + budget);
}

/**
 * A section label with none of its rows left is noise. When windowing cuts a
 * block down to its heading, drop the heading too.
 */
function dropDanglingHeading(lines: readonly Line[]): Line[] {
  const last = lines[lines.length - 1];
  if (last === undefined) return [...lines];
  const text = last.spans
    .map((entry) => entry.text)
    .join("")
    .trim();
  if (text === HOME_COMMANDS_HEADING || text === SUGGESTIONS_HEADING) return lines.slice(0, -1);
  return [...lines];
}

/** Keep the tail (prompt/progress) whole; clip its head when the card is short. */
function clipTail(tail: readonly Line[], budget: number): Line[] {
  if (budget <= 0) return [];
  if (tail.length <= budget) return [...tail];
  return tail.slice(tail.length - budget);
}

// ---------------------------------------------------------------------------
// Screen assembly
// ---------------------------------------------------------------------------

interface Screen {
  lines: Line[];
  cursorLine: number | null;
  cursorOffset: number;
  showCursor: boolean;
}

function homeStatusFor(state: InputState): HomeStatusRow[] {
  return state.panelView === null ? [] : homeStatusRows(state.panelView);
}

function homeCard(state: InputState, geometry: Geometry, elapsedSeconds: number | undefined, title: string): Screen {
  const executing = state.mode === "executing";
  const focusId = executing ? null : focusedHomeStatusId(state.viewport.scrollOffset);
  const status = statusBody(homeStatusFor(state), geometry, focusId);
  const actions = actionBody(executing ? -1 : homeSelectedActionIndex(state.viewport.scrollOffset), geometry);
  const main: Line[] = [];
  if (geometry.tier === "full") main.push(BLANK_LINE);
  const statusStart = main.length;
  main.push(...status.lines, BLANK_LINE);
  const actionStart = main.length;
  main.push(...actions.lines);
  const focusLine = focusId === null ? actionStart + actions.focusLine : statusStart + status.focusLine;

  const tail: Line[] = [];
  if (state.panelRows.length > 0) tail.push(BLANK_LINE, ...receiptBody(state.panelRows, geometry));
  if (!executing) tail.push(...suggestionBody(state, geometry));
  let cursorTailIndex: number | null = null;
  let cursorOffset = 0;
  if (executing) {
    tail.push(
      BLANK_LINE,
      ln(span(PROGRESS_PREFIX, "notice"), span(commandProgressLabel(state.line, elapsedSeconds), "notice")),
    );
  } else {
    const prompt = promptBody(state.line, geometry);
    tail.push(BLANK_LINE);
    cursorTailIndex = tail.length;
    cursorOffset = prompt.cursorOffset;
    tail.push(prompt.line);
  }
  const tailLines = clipTail(tail, Math.max(1, geometry.bodyBudget - 2));
  const cursorTailOffset = cursorTailIndex === null ? null : cursorTailIndex - (tail.length - tailLines.length);
  const mainLines = dropDanglingHeading(
    windowAroundFocus(main, Math.max(0, geometry.bodyBudget - tailLines.length), focusLine),
  );
  const body = [...mainLines, ...tailLines];
  const cursorLine = cursorTailOffset === null ? null : mainLines.length + cursorTailOffset;
  return {
    lines: cardLines(title, body, geometry, false),
    // +1 for the card's top border row.
    cursorLine: cursorLine === null ? null : cursorLine + 1,
    cursorOffset: cursorOffset + 1 + geometry.pad,
    showCursor: !executing,
  };
}

function readonlyCard(state: InputState, geometry: Geometry): Screen {
  const route = isReadonlyRoute(state.route) ? state.route : "help";
  const body = rowsBody(readonlyRows(route, state.panelView), geometry);
  const clipped = clipBody(body, geometry.bodyBudget, state.viewport.scrollOffset);
  return {
    lines: cardLines(readonlyRouteTitle(route), clipped.lines, geometry, clipped.moreBelow),
    cursorLine: null,
    cursorOffset: 0,
    showCursor: false,
  };
}

function plainCard(title: string, rows: readonly string[], geometry: Geometry): Screen {
  const body = rows.flatMap((row) => wrapPlain(row, geometry.contentWidth).map((text) => ln(span(text))));
  const clipped = clipBody(body, geometry.bodyBudget, 0);
  return {
    lines: cardLines(title, clipped.lines, geometry, clipped.moreBelow),
    cursorLine: null,
    cursorOffset: 0,
    showCursor: false,
  };
}

/**
 * Survival mode: no card. One summary row, one focused row that follows the
 * unified cursor, the command line, and (added by renderPanel) the exit hint
 * — so every status field and every action stays reachable at 20x5 exactly as
 * before.
 */
function survivalScreen(state: InputState, cols: number, rows: number, elapsedSeconds: number | undefined): Screen {
  const width = Math.max(1, cols - 2);
  const budget = Math.max(1, rows - 1); // the hint row is reserved
  const lines: Line[] = [];
  const push = (line: Line): void => {
    lines.push(line);
  };
  const executing = state.mode === "executing";

  if (state.mode === "notifier") {
    const body = [notifierWarning(state.notifierCommand)].map((row) => ln(span(truncate(row, width))));
    for (const line of clipBody(body, budget, 0).lines) push(line);
    return { lines, cursorLine: null, cursorOffset: 0, showCursor: false };
  }

  if (isReadonlyRoute(state.route)) {
    const geometry: Geometry = {
      tier: "survival",
      cardWidth: cols,
      pad: 0,
      contentWidth: width,
      gutter: 0,
      bodyBudget: Math.max(1, budget - 1),
    };
    push(ln(span(truncate(readonlyRouteTitle(state.route), width), "bold")));
    const clipped = clipBody(
      rowsBody(readonlyRows(state.route, state.panelView), geometry),
      geometry.bodyBudget,
      state.viewport.scrollOffset,
    );
    for (const line of clipped.lines) push(fitLine(line, width));
    return { lines, cursorLine: null, cursorOffset: 0, showCursor: false };
  }

  if (state.route === "allocation") {
    const choices = allocationSelectorChoices(state.panelView?.allocationId ?? "default");
    const body = choices.map((choice, index) => {
      const selected = index === state.viewport.selectedIndex;
      return ln(
        span(selected ? ACTION_CARET : CARET_BLANK, selected ? "accent" : "normal"),
        span(truncate(choice.label, width - CARET_BLANK.length), selected ? "accent" : "normal"),
      );
    });
    for (const line of clipBody(body, budget, 0).lines) push(line);
    return { lines, cursorLine: null, cursorOffset: 0, showCursor: false };
  }

  push(ln(span(homeSummaryLine(state.panelView, width), "dim")));
  const statusRows = homeStatusFor(state);
  const focusId = executing ? null : focusedHomeStatusId(state.viewport.scrollOffset);
  const suggestions = executing ? [] : commandSuggestions(state.line);
  if (suggestions.length > 0) {
    // One row, the selected one: at this size the menu is a single line
    // between the summary and the prompt. It wears the selection caret, not
    // the prompt caret, so the two rows cannot be confused.
    const index = Math.max(0, Math.min(suggestions.length - 1, state.suggestionIndex));
    const suggestion = suggestions[index]!;
    push(ln(span(FOCUS_CARET, "accent"), span(truncate(suggestion.usage, width - FOCUS_CARET.length), "accent")));
  } else if (focusId !== null) {
    const row = statusRows.find((entry) => entry.id === focusId);
    push(ln(span(FOCUS_CARET, "dim"), span(truncate(row?.tiny ?? "", width - FOCUS_CARET.length))));
  } else if (!executing) {
    const action = HOME_ACTIONS[homeSelectedActionIndex(state.viewport.scrollOffset)];
    push(ln(span(ACTION_CARET, "accent"), span(truncate(action?.label ?? "", width - ACTION_CARET.length), "accent")));
  }
  const notice = statusRows.find((entry) => entry.tone !== "normal");
  if (notice !== undefined && budget > lines.length + 1 + (executing ? 1 : 1)) {
    const ink: Ink = notice.tone === "alarm" ? "alarm" : "notice";
    push(ln(span(NOTICE_PREFIX, ink), span(truncate(notice.text.trim(), width - NOTICE_PREFIX.length), ink)));
  }
  if (executing) {
    const progress = commandProgressLabel(state.line, elapsedSeconds);
    push(ln(span(PROGRESS_PREFIX, "notice"), span(truncate(progress, width - PROGRESS_PREFIX.length), "notice")));
    return { lines: lines.slice(0, budget), cursorLine: null, cursorOffset: 0, showCursor: false };
  }
  const room = Math.max(1, width - PANEL_PROMPT.length);
  const shown = state.line.length > room ? state.line.slice(state.line.length - room) : state.line;
  const kept = lines.slice(0, Math.max(1, budget - 1));
  kept.push(ln(span(PANEL_PROMPT, "accent"), span(shown)));
  return {
    lines: kept,
    cursorLine: kept.length - 1,
    cursorOffset: PANEL_PROMPT.length + shown.length,
    showCursor: true,
  };
}

/** The notifier overlay's one line: unchanged wording, restyled surface. */
function notifierWarning(command: string): string {
  return `Claude ${command} can invalidate cc-lhc session capture/binding`;
}

function hintFor(state: InputState, tier: PanelTier): string {
  if (state.mode === "notifier") return NOTIFIER_HINT;
  if (state.mode === "executing") return tier === "survival" ? PANEL_HINT_SURVIVAL_EXECUTING : PANEL_HINT_EXECUTING;
  if (isReadonlyRoute(state.route)) return tier === "survival" ? PANEL_HINT_SURVIVAL_READONLY : PANEL_HINT_READONLY;
  if (state.route === "allocation") return tier === "survival" ? PANEL_HINT_SURVIVAL_ALLOCATION : PANEL_HINT_ALLOCATION;
  if (tier === "survival") return PANEL_HINT_SURVIVAL;
  // While the menu is open the arrows and Tab mean something different; the
  // hint says which keys are live rather than leaving the user to guess.
  return commandSuggestions(state.line).length > 0 ? PANEL_HINT_SUGGESTIONS : PANEL_HINT;
}

function cardTitle(state: InputState, geometry: Geometry): string {
  if (state.mode === "notifier") return "Claude command";
  if (state.route === "allocation") return "Band allocation";
  if (isReadonlyRoute(state.route)) return readonlyRouteTitle(state.route);
  // Same room test the border uses, so a title never silently disappears.
  return geometry.cardWidth >= PANEL_TITLE.length + 7 ? PANEL_TITLE : PANEL_TITLE_SHORT;
}

function buildScreen(state: InputState, cols: number, rows: number, elapsedSeconds: number | undefined): Screen {
  const tier = panelTier(cols, rows);
  if (tier === "survival") return survivalScreen(state, cols, rows, elapsedSeconds);
  const geometry = geometryFor(cols, rows, tier);
  const title = cardTitle(state, geometry);
  if (state.mode === "notifier") {
    return plainCard(title, [notifierWarning(state.notifierCommand)], geometry);
  }
  if (isReadonlyRoute(state.route)) return readonlyCard(state, geometry);
  if (state.route === "allocation") {
    const clipped = clipBody(allocationBody(state, geometry), geometry.bodyBudget, 0);
    return {
      lines: cardLines(title, clipped.lines, geometry, clipped.moreBelow),
      cursorLine: null,
      cursorOffset: 0,
      showCursor: false,
    };
  }
  return homeCard(state, geometry, elapsedSeconds, title);
}

/**
 * Number of laid-out body lines a read-only route produces at this size —
 * scroll clamping has to know the WRAPPED length, not the row count, or the
 * last lines of Help become unreachable.
 */
export function readonlyBodyLineCount(state: InputState, cols: number, rows: number): number {
  const route = isReadonlyRoute(state.route) ? state.route : "help";
  const tier = panelTier(Math.max(20, cols), Math.max(5, rows));
  const geometry = geometryFor(Math.max(20, cols), Math.max(5, rows), tier);
  return rowsBody(readonlyRows(route, state.panelView), geometry).length;
}

/**
 * Full positioned redraw of the panel, centered for the given terminal size.
 * Home keeps the only command box. Help/Introduction/Details/Allocation are
 * read-only. Rows beyond the terminal are clipped; the card title, the
 * command entry (Home), and the exit hint stay inside the height budget so a
 * small terminal stays operable.
 */
export function renderPanel(
  state: InputState,
  cols: number,
  rows: number,
  elapsedSeconds?: number,
  style: PanelStyle = panelStyleFromEnv(),
): string {
  const safeCols = Math.max(20, cols);
  const safeRows = Math.max(5, rows);
  const tier = panelTier(safeCols, safeRows);
  const screen = buildScreen(state, safeCols, safeRows, elapsedSeconds);
  const hint = ln(span(truncate(hintFor(state, tier), safeCols - 2), "dim"));
  const maxLines = Math.max(1, safeRows);
  const lines = [...screen.lines, hint].slice(0, maxLines);

  const blockWidth = Math.max(1, ...lines.map(lineWidth));
  const left = Math.max(1, Math.floor((safeCols - blockWidth) / 2) + 1);
  const top = Math.max(1, Math.floor((safeRows - lines.length) / 2) + 1);

  let out = HIDE_CURSOR + CLEAR_SCREEN;
  let cursorRow = top;
  let cursorCol = left;
  lines.forEach((line, index) => {
    const row = Math.min(safeRows, top + index);
    if (line.spans.length === 0) return;
    out += moveTo(row, left);
    for (const entry of line.spans) out += paint(entry, style);
  });
  if (screen.cursorLine !== null && screen.cursorLine < lines.length) {
    cursorRow = Math.min(safeRows, top + screen.cursorLine);
    cursorCol = left + screen.cursorOffset;
  }
  out += moveTo(cursorRow, Math.min(safeCols, Math.max(1, cursorCol)));
  if (screen.showCursor && state.mode === "modal") out += SHOW_CURSOR;
  return out;
}
