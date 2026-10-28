import { frameGrid } from "../../src/wrapper/preview.js";

const ESC = String.fromCharCode(0x1b);
const FRAME_START = `${ESC}[?25l${ESC}[2J`;
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[a-zA-Z]`, "g");
const CURSOR_MOVE = new RegExp(`^${ESC}\\[(\\d+);(\\d+)H$`);
const SGR = new RegExp(`${ESC}\\[\\d*(;\\d+)*m`);

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

export function containsSgr(text: string): boolean {
  return SGR.test(text);
}

export function panelFrames(output: string): string[] {
  const parts = output.split(FRAME_START);
  return parts.slice(1);
}

const FRAME_GLYPHS = /[│╭╮╰╯─]/g;

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
      if (CURSOR_MOVE.test(sequence)) out += " ";
    },
  );
  return out.replace(FRAME_GLYPHS, " ").replace(/\s+/g, " ").trim();
}

export function panelText(output: string): string {
  return panelFrames(output).map(frameText).join("\n");
}

export function lastPanelText(output: string): string {
  const frames = panelFrames(output);
  return frameText(frames[frames.length - 1] ?? "");
}

export function panelGrid(output: string, cols: number, rows: number): string[] {
  const frames = panelFrames(output);
  return frameGrid(frames[frames.length - 1] ?? "", cols, rows);
}

export function drawnRows(output: string, cols: number, rows: number): string[] {
  return panelGrid(output, cols, rows)
    .map((line) => line.trimStart())
    .filter((line) => line !== "");
}

export function cardBodyRows(output: string, cols: number, rows: number): string[] {
  return drawnRows(output, cols, rows)
    .filter((line) => line.startsWith("│") && line.endsWith("│"))
    .map((line) => line.slice(1, -1));
}
