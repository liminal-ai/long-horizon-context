#!/usr/bin/env node
// Records sha256 hashes of Red-phase test files into test/red-manifest.json.
// Usage: node scripts/record-red-manifest.mjs test/foo.test.ts [more files...]
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(pkgRoot, "test", "red-manifest.json");

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node scripts/record-red-manifest.mjs <test file> [...]");
  process.exit(1);
}

const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : { files: {} };
manifest.files ??= {};

for (const file of files) {
  const rel = path.isAbsolute(file) ? path.relative(pkgRoot, file) : file;
  const full = path.join(pkgRoot, rel);
  manifest.files[rel] = createHash("sha256").update(readFileSync(full)).digest("hex");
  console.log(`recorded ${rel}`);
}

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
