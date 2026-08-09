#!/usr/bin/env node
/** Long-running fake Claude PTY child for wrapper tests (not capture-sensitive argv). */
const mode = process.argv[2] ?? "sleep";
if (mode === "ticks") {
  let i = 0;
  setInterval(() => {
    i += 1;
    process.stdout.write(`tick${i}\n`);
  }, 50);
} else {
  const ms = Number.parseInt(mode, 10);
  setTimeout(() => process.exit(0), Number.isFinite(ms) ? ms : 30_000);
}
