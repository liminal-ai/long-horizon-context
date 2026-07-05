#!/usr/bin/env node
// Installs the cc-lhc launcher shim pointing at this repo's built dist.
// Usage: node .setup/scripts/install-shim.mjs [--bin-dir <dir>]
// POSIX: writes an executable bash shim. Windows: writes cc-lhc.cmd.
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const distBin = join(repoRoot, "packages", "cc-lhc", "dist", "bin.js");

const argIdx = process.argv.indexOf("--bin-dir");
const binDir = argIdx !== -1 ? resolve(process.argv[argIdx + 1]) : join(homedir(), ".local", "bin");

if (!existsSync(distBin)) {
  console.error(`missing built launcher: ${distBin}`);
  console.error(`run: pnpm --filter cc-lhc run build (from ${repoRoot})`);
  process.exit(1);
}

mkdirSync(binDir, { recursive: true });

if (process.platform === "win32") {
  const target = join(binDir, "cc-lhc.cmd");
  writeFileSync(target, `@echo off\r\nnode "${distBin}" %*\r\n`);
  console.log(`wrote ${target}`);
} else {
  const target = join(binDir, "cc-lhc");
  writeFileSync(
    target,
    `#!/usr/bin/env bash\nset -euo pipefail\nDIST_BIN="${distBin}"\nif [[ ! -f "$DIST_BIN" ]]; then\n  echo "cc-lhc: missing built launcher at $DIST_BIN" >&2\n  echo "run: cd ${repoRoot} && pnpm --filter cc-lhc run build" >&2\n  exit 1\nfi\nexec node "$DIST_BIN" "$@"\n`,
  );
  chmodSync(target, 0o755);
  console.log(`wrote ${target}`);
}

const pathEntries = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
if (!pathEntries.includes(binDir)) {
  console.log(`NOTE: ${binDir} is not on PATH — add it in your shell profile.`);
}
