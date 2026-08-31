#!/usr/bin/env node
/**
 * Disposable synthetic worker for the Story 0 process-capability harness.
 *
 * Appends a heartbeat to a coordinator-owned output file and stays alive until
 * SIGTERM (POSIX stop proof) or process termination. Ignores SIGHUP so a
 * detached worker is not reaped merely because the PTY session leader exited.
 * Self-exits after a bounded lifetime so a crashed coordinator cannot leak it.
 */
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
    // Already closed.
  }
  process.exit(code);
};

if (process.platform !== "win32") {
  process.on("SIGHUP", () => {
    // Stay alive across session-leader death; the coordinator stop path is
    // identity-checked SIGTERM, not hangup.
  });
}

process.on("SIGTERM", () => shutdown(0));
setTimeout(() => shutdown(0), Number.isFinite(lifetimeMs) ? lifetimeMs : 60_000).unref?.();
