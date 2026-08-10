#!/usr/bin/env node
// Installs a launcher shim pointing at this repo's built dist.
// Usage: node .setup/scripts/install-shim.mjs [--target cc-lhc|pi-lhc] [--bin-dir <dir>]
// Default --target is cc-lhc. POSIX: executable bash shim at <bin-dir>/<name>.
// Windows: <bin-dir>/<name>.cmd (stable batch text, works from cmd.exe and
// PowerShell) plus <bin-dir>/<name>.launcher.js holding the repo paths as
// JSON-encoded data — an arbitrary clone path is never parsed as cmd source.
// Default bin dir is ~/.local/bin on every platform; the script prints
// platform-correct PATH guidance when that directory is not on PATH.
// --repo-root <dir> overrides repo detection (test seam; normal installs omit it).
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  binDirOnPath,
  pathGuidance,
  posixShimContent,
  windowsCmdShimContent,
  windowsLauncherJsContent,
} from "./lib/shim.mjs";

const TARGETS = {
  "cc-lhc": { name: "cc-lhc", packageDir: "cc-lhc" },
  "pi-lhc": { name: "pi-lhc", packageDir: "pi-lhc" },
};

function argValue(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx === -1) return undefined;
  const val = argv[idx + 1];
  if (val === undefined) {
    console.error(`missing value for ${flag}`);
    process.exit(1);
  }
  return val;
}

const targetKey = argValue(process.argv, "--target") ?? "cc-lhc";
if (!(targetKey in TARGETS)) {
  console.error(`unknown --target value: ${targetKey} (expected cc-lhc or pi-lhc)`);
  process.exit(1);
}
const target = TARGETS[targetKey];

const repoRootArg = argValue(process.argv, "--repo-root");
const repoRoot = repoRootArg
  ? resolve(repoRootArg)
  : resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const distBin = join(repoRoot, "packages", target.packageDir, "dist", "bin.js");

const binDirArg = argValue(process.argv, "--bin-dir");
const binDir = binDirArg ? resolve(binDirArg) : join(homedir(), ".local", "bin");

if (!existsSync(distBin)) {
  console.error(`missing built launcher: ${distBin}`);
  console.error(
    `run: pnpm --config.verify-deps-before-run=false --filter ${target.packageDir} run build (from ${repoRoot})`,
  );
  process.exit(1);
}

mkdirSync(binDir, { recursive: true });

if (process.platform === "win32") {
  const launcher = join(binDir, `${target.name}.launcher.js`);
  writeFileSync(launcher, windowsLauncherJsContent(target.name, target.packageDir, distBin, repoRoot));
  const dest = join(binDir, `${target.name}.cmd`);
  writeFileSync(dest, windowsCmdShimContent(target.name));
  console.log(`wrote ${launcher}`);
  console.log(`wrote ${dest}`);
} else {
  const dest = join(binDir, target.name);
  writeFileSync(dest, posixShimContent(target.name, target.packageDir, distBin, repoRoot));
  chmodSync(dest, 0o755);
  console.log(`wrote ${dest}`);
}

if (!binDirOnPath(binDir, process.env.PATH ?? "", process.platform)) {
  for (const line of pathGuidance(binDir, process.platform)) {
    console.log(line);
  }
}
