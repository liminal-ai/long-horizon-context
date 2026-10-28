#!/usr/bin/env node
import { existsSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname } from "node:path";
import { SCRATCH_ROOT } from "./lib.mjs";

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error("usage: cleanup.mjs <kept-home> [<kept-home>...]");
  process.exit(2);
}
const root = existsSync(SCRATCH_ROOT) ? realpathSync(SCRATCH_ROOT) : SCRATCH_ROOT;
for (const dir of dirs) {
  if (!existsSync(dir)) {
    console.log(`cleanup: ${dir} already gone`);
    continue;
  }
  const resolved = realpathSync(dir);
  if (dirname(resolved) !== root || !basename(resolved).startsWith("verify-lhc-")) {
    console.error(`cleanup: REFUSED ${dir} (not a verify-lhc-* home directly under ${root})`);
    process.exit(1);
  }
  rmSync(resolved, { recursive: true, force: true });
  console.log(`cleanup: removed ${resolved}`);
}
