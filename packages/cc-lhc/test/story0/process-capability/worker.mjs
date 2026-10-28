#!/usr/bin/env node
import { closeSync, openSync, writeSync } from "node:fs";

const outputPath = process.argv[2];
if (typeof outputPath !== "string" || outputPath.length === 0) {
  process.stderr.write("worker: missing output path\n");
  process.exit(2);
}

const lifetimeMs = Number.parseInt(process.argv[3] ?? "60000", 10);
const fd = openSync(outputPath, "a");
let beats = 0;

const writeBeat = () => {
  beats += 1;
  writeSync(fd, `${beats}\n`);
};

writeBeat();
const timer = setInterval(writeBeat, 200);

const shutdown = (code) => {
  clearInterval(timer);
  try {
    closeSync(fd);
  } catch {
  }
  process.exit(code);
};

if (process.platform !== "win32") {
  process.on("SIGHUP", () => {
  });
}

process.on("SIGTERM", () => shutdown(0));
setTimeout(() => shutdown(0), Number.isFinite(lifetimeMs) ? lifetimeMs : 60_000).unref?.();
