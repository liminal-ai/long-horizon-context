#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { paneScreen as screen, renderPng as render } from "../../../verify-media/term-png.mjs";

const [mode, session, out, seconds] = process.argv.slice(2);
if (session === undefined || out === undefined || (mode !== "png" && mode !== "record")) {
  console.error("usage: shot.mjs png <session> <out.png> | shot.mjs record <session> <out.mp4> <seconds>");
  process.exit(2);
}
const work = mkdtempSync(join(tmpdir(), "shot-"));
try {
  if (mode === "png") {
    render(screen(session), out);
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
      render(frame, png);
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
