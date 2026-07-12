#!/usr/bin/env node
// Installs a launcher shim pointing at this repo's built dist.
// Usage: node .setup/scripts/install-shim.mjs [--target cc-lhc|pi-lhc] [--bin-dir <dir>]
// Default --target is cc-lhc. POSIX: executable bash shim. Windows: .cmd file.
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TARGETS = {
  "cc-lhc": { name: "cc-lhc", packageDir: "cc-lhc" },
  "pi-lhc": { name: "pi-lhc", packageDir: "pi-lhc" },
};

function parseTarget(argv) {
  const idx = argv.indexOf("--target");
  if (idx === -1) return "cc-lhc";
  const val = argv[idx + 1];
  if (val === undefined || !(val in TARGETS)) {
    console.error(`unknown --target value: ${val ?? "(missing)"} (expected cc-lhc or pi-lhc)`);
    process.exit(1);
  }
  return val;
}

const targetKey = parseTarget(process.argv);
const target = TARGETS[targetKey];
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const distBin = join(repoRoot, "packages", target.packageDir, "dist", "bin.js");

const argIdx = process.argv.indexOf("--bin-dir");
if (argIdx !== -1 && process.argv[argIdx + 1] === undefined) {
  console.error("missing value for --bin-dir");
  process.exit(1);
}
const binDir = argIdx !== -1 ? resolve(process.argv[argIdx + 1]) : join(homedir(), ".local", "bin");

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

if (!existsSync(distBin)) {
  console.error(`missing built launcher: ${distBin}`);
  console.error(`run: pnpm --filter ${target.packageDir} run build (from ${repoRoot})`);
  process.exit(1);
}

mkdirSync(binDir, { recursive: true });

if (process.platform === "win32") {
  const dest = join(binDir, `${target.name}.cmd`);
  writeFileSync(dest, `@echo off\r\nnode "${distBin}" %*\r\n`);
  console.log(`wrote ${dest}`);
} else {
  const dest = join(binDir, target.name);
  writeFileSync(
    dest,
    `#!/usr/bin/env bash\nset -euo pipefail\nDIST_BIN=${shellQuote(distBin)}\nREPO_ROOT=${shellQuote(repoRoot)}\nif [[ ! -f "$DIST_BIN" ]]; then\n  echo "${target.name}: missing built launcher at $DIST_BIN" >&2\n  echo "run: cd $REPO_ROOT && pnpm --filter ${target.packageDir} run build" >&2\n  exit 1\nfi\nexec node "$DIST_BIN" "$@"\n`,
  );
  chmodSync(dest, 0o755);
  console.log(`wrote ${dest}`);
}

const pathEntries = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
if (!pathEntries.includes(binDir)) {
  console.log(`NOTE: ${binDir} is not on PATH — add it in your shell profile.`);
}
