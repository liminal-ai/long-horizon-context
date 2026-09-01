#!/usr/bin/env node

/**
 * Stamp dist/build-identity.json for `cc-lhc --lhc-version` (D13).
 * Deterministic for an identical source state: fixed key order, no
 * timestamps. Optional argv[2] overrides the output directory so tests can
 * stamp a disposable directory instead of the real dist/.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(process.argv[2] ?? join(packageRoot, "dist"));

const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));

function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: packageRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

const sourceSha = git(["rev-parse", "HEAD"]);
const porcelain = sourceSha === null ? null : git(["status", "--porcelain"]);

const identity = {
  name: manifest.name,
  version: manifest.version,
  sourceSha,
  sourceDirty: porcelain !== null && porcelain.length > 0,
};

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "build-identity.json"), `${JSON.stringify(identity, null, 2)}\n`);
