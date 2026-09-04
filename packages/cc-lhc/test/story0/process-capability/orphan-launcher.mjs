#!/usr/bin/env node
/**
 * Short-lived intermediate parent: spawn the worker, record its pid, exit.
 *
 * After this process exits the worker is no longer a child of the PTY old-child,
 * which is the Windows taskkill-/T exclusion candidate (I-9).
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const workerPath = process.argv[2];
const outputPath = process.argv[3];
const pidPath = process.argv[4];
const lifetimeMs = process.argv[5] ?? "60000";

if (
  typeof workerPath !== "string" ||
  typeof outputPath !== "string" ||
  typeof pidPath !== "string"
) {
  process.stderr.write("orphan-launcher: missing worker, output, or pid path\n");
  process.exit(2);
}

const child = spawn(process.execPath, [workerPath, outputPath, lifetimeMs], {
  detached: true,
  stdio: "ignore",
  windowsHide: true,
});
if (child.pid === undefined) {
  process.stderr.write("orphan-launcher: spawn produced no pid\n");
  process.exit(1);
}
writeFileSync(pidPath, `${String(child.pid)}\n`);
child.unref();
process.exit(0);
