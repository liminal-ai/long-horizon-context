#!/usr/bin/env node
import { encodeMp4, paneScreen, recordFrames, renderPng } from "../../../verify-media/term-png.mjs";

const [mode, session, out, seconds] = process.argv.slice(2);
if (session === undefined || out === undefined || (mode !== "png" && mode !== "record")) {
  console.error("usage: shot.mjs png <session> <out.png> | shot.mjs record <session> <out.mp4> <seconds>");
  process.exit(2);
}
if (mode === "png") {
  renderPng(paneScreen(session), out);
  console.log(`shot: ${out}`);
} else {
  const recording = recordFrames(session, Number(seconds));
  encodeMp4(recording, out);
  console.log(`record: ${out} frames ${recording.frames.length} seconds ${seconds}`);
}
