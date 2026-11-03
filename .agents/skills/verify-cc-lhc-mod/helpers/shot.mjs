#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CELL_W = 8.4;
const CELL_H = 17;
const BASE = ["#1e1e1e", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#d0d0d0"];
const BRIGHT = ["#5c6370", "#ff7b86", "#b5e890", "#ffd68a", "#7cc4ff", "#e099ff", "#7fd8e2", "#ffffff"];
const FG = "#d0d0d0";
const BG = "#1e1e1e";

function color256(n) {
  if (n < 8) return BASE[n];
  if (n < 16) return BRIGHT[n - 8];
  if (n < 232) {
    const v = [0, 95, 135, 175, 215, 255];
    const i = n - 16;
    return `rgb(${v[Math.floor(i / 36)]},${v[Math.floor(i / 6) % 6]},${v[i % 6]})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}

function applySgr(style, params) {
  const codes = params === "" ? [0] : params.split(";").map(Number);
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    if (c === 0) Object.assign(style, { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false });
    else if (c === 1) style.bold = true;
    else if (c === 2) style.dim = true;
    else if (c === 3) style.italic = true;
    else if (c === 4) style.underline = true;
    else if (c === 7) style.inverse = true;
    else if (c === 22) Object.assign(style, { bold: false, dim: false });
    else if (c === 23) style.italic = false;
    else if (c === 24) style.underline = false;
    else if (c === 27) style.inverse = false;
    else if (c >= 30 && c <= 37) style.fg = BASE[c - 30];
    else if (c === 39) style.fg = null;
    else if (c >= 40 && c <= 47) style.bg = BASE[c - 40];
    else if (c === 49) style.bg = null;
    else if (c >= 90 && c <= 97) style.fg = BRIGHT[c - 90];
    else if (c >= 100 && c <= 107) style.bg = BRIGHT[c - 100];
    else if (c === 38 || c === 48) {
      const key = c === 38 ? "fg" : "bg";
      if (codes[i + 1] === 5) {
        style[key] = color256(codes[i + 2]);
        i += 2;
      } else if (codes[i + 1] === 2) {
        style[key] = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
        i += 4;
      }
    }
  }
}

const escapeHtml = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function toHtml(ansi, columns, rows) {
  const style = { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false };
  const lines = ansi.split("\n").slice(0, rows);
  const body = lines
    .map((line) => {
      let out = "";
      for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
        const sgr = /^\x1b\[([0-9;]*)m$/.exec(part);
        if (sgr !== null) {
          applySgr(style, sgr[1]);
          continue;
        }
        const text = part.replaceAll(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
        if (text === "") continue;
        let fg = style.fg ?? FG;
        let bg = style.bg ?? "transparent";
        if (style.inverse) [fg, bg] = [style.bg ?? BG, style.fg ?? FG];
        const css = [
          `color:${fg}`,
          bg === "transparent" ? "" : `background:${bg}`,
          style.bold ? "font-weight:700" : "",
          style.dim ? "opacity:.55" : "",
          style.italic ? "font-style:italic" : "",
          style.underline ? "text-decoration:underline" : "",
        ].filter(Boolean);
        out += `<span style="${css.join(";")}">${escapeHtml(text)}</span>`;
      }
      return `<div class="l">${out || " "}</div>`;
    })
    .join("");
  return `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;background:${BG}}
    .t{padding:12px 14px;font:14px/${CELL_H}px "DejaVu Sans Mono","Liberation Mono",monospace;white-space:pre;width:${Math.ceil(columns * CELL_W)}px}
    .l{height:${CELL_H}px;overflow:hidden}
  </style><div class="t">${body}</div>`;
}

function screen(session) {
  const target = `=${session}:`;
  const [columns, rows] = execFileSync("tmux", ["display", "-p", "-t", target, "#{pane_width} #{pane_height}"], { encoding: "utf8" })
    .trim()
    .split(" ")
    .map(Number);
  const ansi = execFileSync("tmux", ["capture-pane", "-e", "-p", "-t", target], { encoding: "utf8" });
  return { ansi, columns, rows };
}

function render({ ansi, columns, rows }, out, work) {
  const html = join(work, `${Math.random().toString(36).slice(2)}.html`);
  writeFileSync(html, toHtml(ansi, columns, rows));
  const width = Math.ceil(columns * CELL_W) + 28;
  const height = rows * CELL_H + 24;
  execFileSync(
    "google-chrome",
    ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--window-size=${width},${height}`, `--screenshot=${resolve(out)}`, `file://${html}`],
    { stdio: "ignore" },
  );
}

const [mode, session, out, seconds] = process.argv.slice(2);
if (session === undefined || out === undefined || (mode !== "png" && mode !== "record")) {
  console.error("usage: shot.mjs png <session> <out.png> | shot.mjs record <session> <out.mp4> <seconds>");
  process.exit(2);
}
const work = mkdtempSync(join(tmpdir(), "shot-"));
try {
  if (mode === "png") {
    render(screen(session), out, work);
    console.log(`shot: ${out}`);
  } else {
    const frames = [];
    const end = Date.now() + Number(seconds) * 1000;
    while (Date.now() < end) {
      const at = Date.now();
      const shown = screen(session);
      if (frames.at(-1)?.ansi !== shown.ansi) frames.push({ ...shown, at });
      const wait = 200 - (Date.now() - at);
      if (wait > 0) execFileSync("sleep", [String(wait / 1000)]);
    }
    mkdirSync(join(work, "f"), { recursive: true });
    const list = [];
    frames.forEach((frame, i) => {
      const png = join(work, "f", `${String(i).padStart(5, "0")}.png`);
      render(frame, png, work);
      const next = frames[i + 1]?.at ?? end;
      list.push(`file '${png}'`, `duration ${((next - frame.at) / 1000).toFixed(3)}`);
    });
    list.push(list.at(-2));
    writeFileSync(join(work, "list.txt"), `${list.join("\n")}\n`);
    execFileSync(
      "ffmpeg",
      ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(work, "list.txt"), "-vf", "fps=10,scale=trunc(iw/2)*2:trunc(ih/2)*2", "-pix_fmt", "yuv420p", resolve(out)],
      { stdio: "inherit" },
    );
    console.log(`record: ${out} frames ${frames.length} seconds ${seconds}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
