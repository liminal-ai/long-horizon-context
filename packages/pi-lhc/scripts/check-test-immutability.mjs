#!/usr/bin/env node
// Green-phase guard: Red-committed test files must be byte-identical to the
// hashes recorded in test/red-manifest.json. Green may add new test files but
// may not modify Red's. Record hashes with scripts/record-red-manifest.mjs.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(pkgRoot, "test", "red-manifest.json");

if (!existsSync(manifestPath)) {
  console.log("test-immutability: no Red-phase manifest; nothing to check");
  process.exit(0);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const entries = Object.entries(manifest.files ?? {});
if (entries.length === 0) {
  console.log("test-immutability: Red-phase manifest empty; nothing to check");
  process.exit(0);
}

const failures = [];
for (const [relPath, expectedHash] of entries) {
  const full = path.join(pkgRoot, relPath);
  if (!existsSync(full)) {
    failures.push(`${relPath}: Red-phase test file is missing`);
    continue;
  }
  const actual = createHash("sha256").update(readFileSync(full)).digest("hex");
  if (actual !== expectedHash) {
    failures.push(`${relPath}: modified since Red phase (hash mismatch)`);
  }
}

if (failures.length > 0) {
  console.error("test-immutability FAILED:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`test-immutability: OK (${entries.length} Red-phase files unchanged)`);
