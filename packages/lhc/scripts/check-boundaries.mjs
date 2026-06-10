#!/usr/bin/env node
// Zero-dependency import-boundary check.
// Rules:
//   1. No file may import another domain's internal/ modules.
//   2. tech-utils/ and shared/ may not import from domains/.
// The test fixtures directory (test/fixtures/) is exempt by design — it is
// the one sanctioned below-SDK writer.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = path.join(pkgRoot, "src");
const testRoot = path.join(pkgRoot, "test");
const fixturesRoot = path.join(testRoot, "fixtures");

function collectTsFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    if (full === fixturesRoot) continue; // fixtures exempt
    if (statSync(full).isDirectory()) {
      collectTsFiles(full, out);
    } else if (full.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

function importSpecifiers(source) {
  const specs = [];
  const patterns = [
    /(?:^|\s)import\s+[^"']*?from\s+["']([^"']+)["']/gms,
    /(?:^|\s)export\s+[^"']*?from\s+["']([^"']+)["']/gms,
    /(?:^|\s)import\s+["']([^"']+)["']/gm,
    /import\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(source)) !== null) specs.push(m[1]);
  }
  return specs;
}

function domainOf(filePath) {
  const rel = path.relative(srcRoot, filePath);
  const parts = rel.split(path.sep);
  if (parts[0] === "domains" && parts.length > 1) return parts[1];
  return null;
}

const files = [...collectTsFiles(srcRoot), ...collectTsFiles(testRoot)];
const violations = [];

for (const file of files) {
  const source = readFileSync(file, "utf8");
  const fileDomain = domainOf(file);
  const inTechUtilsOrShared =
    file.startsWith(path.join(srcRoot, "tech-utils") + path.sep) ||
    file.startsWith(path.join(srcRoot, "shared") + path.sep);

  for (const spec of importSpecifiers(source)) {
    if (!spec.startsWith(".")) continue; // only relative imports cross our tree
    const resolved = path.resolve(path.dirname(file), spec);
    const relToSrc = path.relative(srcRoot, resolved);
    if (relToSrc.startsWith("..")) continue; // outside src/
    const parts = relToSrc.split(path.sep);

    if (parts[0] === "domains" && parts.includes("internal")) {
      const targetDomain = parts[1];
      if (fileDomain !== targetDomain) {
        violations.push(
          `${path.relative(pkgRoot, file)} imports ${spec} — reaches into domain "${targetDomain}" internal/`,
        );
      }
    }
    if (inTechUtilsOrShared && parts[0] === "domains") {
      violations.push(
        `${path.relative(pkgRoot, file)} imports ${spec} — tech-utils/shared may not import domains/`,
      );
    }
  }
}

if (violations.length > 0) {
  console.error("boundary check FAILED:");
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log(`boundaries: OK (${files.length} files checked, fixtures exempt)`);
