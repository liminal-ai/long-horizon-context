/**
 * Reading the drawn panel back.
 *
 * The Control Panel is a positioned, styled, wrapped card: assertions cannot
 * grep the raw byte stream for a sentence that the card wrapped across two
 * rows or painted with an SGR run in the middle. These helpers rebuild what
 * the operator would SEE — `panelText` for content assertions (row breaks
 * become spaces, styling disappears, runs of spaces collapse) and `panelGrid`
 * for layout assertions (the card frame, and that nothing escapes the
 * terminal box).
 */

/**
 * ESC is built rather than written into a regex literal: a literal control
 * character in a pattern is exactly what `noControlCharactersInRegex` exists
 * to catch, and the constructed form says what the byte is.
 */
const ESC = String.fromCharCode(0x1b);
const FRAME_START = `${ESC}[?25l${ESC}[2J`;
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[a-zA-Z]`, "g");
const CURSOR_MOVE = new RegExp(`^${ESC}\\[(\\d+);(\\d+)H$`);
/** A colour/attribute run: CSI <params> m. */
const SGR = new RegExp(`${ESC}\\[\\d*(;\\d+)*m`);

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** True when the output carries any styling at all (colour or attribute). */
export function containsSgr(text: string): boolean {
  return SGR.test(text);
}

/** Every full redraw in the stream, oldest first. */
export function panelFrames(output: string): string[] {
  const parts = output.split(FRAME_START);
  return parts.slice(1);
}

/** Card frame glyphs: structure, never content. */
const FRAME_GLYPHS = /[│╭╮╰╯─]/g;

/** Split a frame into plain-text runs and the escape sequences between them. */
function scanFrame(frame: string, onText: (text: string) => void, onEscape: (sequence: string) => void): void {
  const pattern = new RegExp(ANSI.source, "g");
  let last = 0;
  for (const match of frame.matchAll(pattern)) {
    const at = match.index ?? 0;
    onText(frame.slice(last, at));
    onEscape(match[0]);
    last = at + match[0].length;
  }
  onText(frame.slice(last));
}

function frameText(frame: string): string {
  let out = "";
  scanFrame(
    frame,
    (text) => {
      out += text;
    },
    (sequence) => {
      // A cursor move ends one drawn row and starts another: keep them apart.
      if (CURSOR_MOVE.test(sequence)) out += " ";
    },
  );
  // Drop the frame so a sentence the card wrapped across two rows reads back
  // as one sentence.
  return out.replace(FRAME_GLYPHS, " ").replace(/\s+/g, " ").trim();
}

/**
 * All frames as readable text: one line per redraw, wrapping and column
 * padding normalized to single spaces.
 */
export function panelText(output: string): string {
  return panelFrames(output).map(frameText).join("\n");
}

/** The most recent redraw as readable text. */
export function lastPanelText(output: string): string {
  const frames = panelFrames(output);
  return frameText(frames[frames.length - 1] ?? "");
}

/** The last redraw as a `rows`-tall grid of `cols`-wide lines (right-trimmed). */
export function panelGrid(output: string, cols: number, rows: number): string[] {
  const frames = panelFrames(output);
  const frame = frames[frames.length - 1] ?? "";
  const grid: string[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => " "));
  let row = 0;
  let col = 0;
  const put = (text: string): void => {
    for (const character of text) {
      if (row >= 0 && row < rows && col >= 0 && col < cols) grid[row]![col] = character;
      col += 1;
    }
  };
  scanFrame(frame, put, (sequence) => {
    const move = CURSOR_MOVE.exec(sequence);
    if (move !== null) {
      row = Number.parseInt(move[1]!, 10) - 1;
      col = Number.parseInt(move[2]!, 10) - 1;
    }
  });
  return grid.map((line) => line.join("").replace(/\s+$/, ""));
}

/** Rows of the last frame that carry any drawn content, left padding removed. */
export function drawnRows(output: string, cols: number, rows: number): string[] {
  return panelGrid(output, cols, rows)
    .map((line) => line.trimStart())
    .filter((line) => line !== "");
}

/**
 * The card's inner content rows, with the frame removed but the column
 * padding kept — so column-index assertions really compare gutters.
 */
export function cardBodyRows(output: string, cols: number, rows: number): string[] {
  return drawnRows(output, cols, rows)
    .filter((line) => line.startsWith("│") && line.endsWith("│"))
    .map((line) => line.slice(1, -1));
}
