#!/usr/bin/env node

/**
 * Stamp dist/build-identity.json for `cc-lhc --lhc-version` (D13).
 *
 *   node scripts/stamp-build-identity.mjs [--out DIR] [--source-sha SHA]
 *
 * The SHA is the caller's explicit, accepted source identity. Without it the
 * stamp truthfully records identity unavailable (an ordinary development
 * build). This script never inspects the repository.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sourceShaFromArgv, writeBuildIdentity } from "./lib/build-identity.mjs";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);

function argValue(flag) {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

try {
  const known = new Set(["--out", "--source-sha"]);
  for (let i = 0; i < argv.length; i += 1) {
    if (known.has(argv[i])) {
      i += 1;
      continue;
    }
    throw new Error(`unknown argument ${JSON.stringify(argv[i])}`);
  }
  const outDir = resolve(argValue("--out") ?? join(packageRoot, "dist"));
  const sourceSha = sourceShaFromArgv(argv) ?? null;
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  writeBuildIdentity(outDir, { name: manifest.name, version: manifest.version, sourceSha });
} catch (error) {
  console.error(`stamp-build-identity: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
