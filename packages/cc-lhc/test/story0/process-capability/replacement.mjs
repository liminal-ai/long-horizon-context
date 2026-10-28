#!/usr/bin/env node
import { writeFileSync } from "node:fs";

const manifestPath = process.argv[2];
if (typeof manifestPath !== "string" || manifestPath.length === 0) {
  process.stderr.write("replacement: missing manifest path\n");
  process.exit(2);
}
writeFileSync(manifestPath, `${JSON.stringify({ replacementPid: process.pid })}\n`);
process.stdout.write("replacement-ok\n");
if (process.platform !== "win32") {
  process.on("SIGTERM", () => process.exit(0));
}
setInterval(() => {}, 10_000);
setTimeout(() => process.exit(0), 60_000).unref?.();
