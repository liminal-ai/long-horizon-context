#!/usr/bin/env node
/** Lightweight replacement child: renders immediately and stays viable for handoff. */
process.stdout.write("replacement-ok\n");
if (process.platform !== "win32") {
  process.on("SIGTERM", () => process.exit(0));
}
setInterval(() => {}, 10_000);
setTimeout(() => process.exit(0), 60_000).unref?.();
