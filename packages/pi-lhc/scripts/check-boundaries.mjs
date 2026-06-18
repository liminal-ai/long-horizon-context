#!/usr/bin/env node
// Zero-dependency import-boundary check for the pi-lhc connector.
//
// The connector has four surfaces under src/ — lifecycle, capture, inference,
// verify — plus two leaf areas (pi/ external type declarations, shared/
// cross-cutting helpers) and the composition root index.ts. The rules keep the
// surfaces from leaking into each other so a later story cannot quietly couple,
// say, inference to capture:
//   1. index.ts is the composition root — it may import any surface.
//   2. pi/ and shared/ are leaves — they may NOT import from a surface (they
//      hold only external type declarations and helpers every surface uses).
//   3. A surface may import another surface ONLY along a pinned edge in
//      ALLOWED_SURFACE_IMPORTS — a new cross-surface edge is a conscious
//      decision, never a silent pass. Importing pi/ or shared/ is always fine.
// Only src/ is subject to surface rules; test/ files are consumers that drive
// the code across surfaces by design.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = path.join(pkgRoot, "src");

const SURFACES = new Set(["lifecycle", "capture", "inference", "verify"]);
const LEAF_DIRS = new Set(["pi", "shared"]);

// The pinned surface→surface dependency edges (rule 3). Each is a deliberate
// architectural seam from the Epic 1 tech design (§Module Architecture):
//   - lifecycle → capture : fork.ts replay-seeds a new thread through the
//     converter (Flow 3, Story 4).
//   - verify → capture    : replay.ts drives the converter on a corpus
//     (Flow 6, Story 3).
//   - inference → lifecycle: startup-validation.report() writes its diagnostic
//     into SessionState (Flow 5, Story 6).
// No cycle: inference → lifecycle → capture, and verify → capture.
const ALLOWED_SURFACE_IMPORTS = {
  lifecycle: new Set(["capture"]),
  capture: new Set([]),
  inference: new Set(["lifecycle"]),
  verify: new Set(["capture"]),
};

function collectTsFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) collectTsFiles(full, out);
    else if (full.endsWith(".ts")) out.push(full);
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
    let m = re.exec(source);
    while (m !== null) {
      specs.push(m[1]);
      m = re.exec(source);
    }
  }
  return specs;
}

function topPartOf(filePath) {
  const rel = path.relative(srcRoot, filePath);
  const parts = rel.split(path.sep);
  return { rel, parts, top: parts[0] };
}

const files = collectTsFiles(srcRoot);
const violations = [];

for (const file of files) {
  const { parts, top } = topPartOf(file);
  const isRootEntry = parts.length === 1; // src/index.ts and any other root file
  const fileSurface = SURFACES.has(top) ? top : null;
  const isLeaf = LEAF_DIRS.has(top);
  const source = readFileSync(file, "utf8");

  for (const spec of importSpecifiers(source)) {
    if (!spec.startsWith(".")) continue; // only relative imports cross our tree
    const resolved = path.resolve(path.dirname(file), spec);
    const relToSrc = path.relative(srcRoot, resolved);
    if (relToSrc.startsWith("..")) continue; // outside src/
    const targetTop = relToSrc.split(path.sep)[0];
    const targetSurface = SURFACES.has(targetTop) ? targetTop : null;
    if (targetSurface === null) continue; // importing a leaf (pi/shared) — always allowed

    if (isRootEntry) continue; // composition root may wire any surface
    if (isLeaf) {
      violations.push(
        `${path.relative(pkgRoot, file)} imports ${spec} — leaf "${top}/" may not import surface "${targetSurface}"`,
      );
      continue;
    }
    if (fileSurface === null) continue; // not a surface, not a leaf, not root — nothing to enforce
    if (fileSurface === targetSurface) continue; // intra-surface — allowed
    const allowed = ALLOWED_SURFACE_IMPORTS[fileSurface];
    if (allowed === undefined || !allowed.has(targetSurface)) {
      violations.push(
        `${path.relative(pkgRoot, file)} imports ${spec} — surface "${fileSurface}" has no pinned edge to "${targetSurface}" (rule 3)`,
      );
    }
  }
}

if (violations.length > 0) {
  console.error("boundary check FAILED:");
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log(`boundaries: OK (${files.length} src files checked)`);
