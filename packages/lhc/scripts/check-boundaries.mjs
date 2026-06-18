#!/usr/bin/env node
// Zero-dependency import-boundary check for the flat src/ layout (Epic 07
// Story 0): the six domains are direct children of src/, and all non-domain
// technical infrastructure lives under one src/shared-tech/ area.
// Rules (AC-0.6, tech design §Import Boundary Rules):
//   1. src/shared-tech/** may not import from any domain folder.
//   2. A domain may import another domain's internal/ modules only from within
//      that same domain — cross-domain internal access is forbidden.
//   3. A domain may import another domain's surface (its index.ts / public
//      files) only along an edge pinned in ALLOWED_SURFACE_IMPORTS below — a
//      new cross-domain edge is a conscious decision, never a silent pass.
//   4. Domains consume shared-tech through its public entrypoint or explicit
//      sub-capability public entrypoints, not arbitrary shared-tech files.
// Domains may freely import src/shared-tech/** (the shared technical area is a
// dependency of every domain, never the reverse). The test fixtures directory
// (test/fixtures/) is exempt by design — it is the one sanctioned below-SDK
// writer.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = path.join(pkgRoot, "src");
const testRoot = path.join(pkgRoot, "test");
const fixturesRoot = path.join(testRoot, "fixtures");

// The six domain surfaces (AC-0.1): direct children of src/.
const DOMAINS = new Set([
  "intake-stream",
  "messages",
  "turns",
  "threads",
  "thread-view",
  "inspect",
]);
const SHARED_TECH = "shared-tech";
const SHARED_TECH_PUBLIC_ENTRIES = new Set([
  "index",
  "logging/index",
  "prompts/index",
  "token-counting/index",
  "work-queue/index",
]);

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

// The domain a file belongs to, or null for src/shared-tech/**, src/sdk.ts, and
// test files. With the domains/ wrapper gone, the domain is simply parts[0]
// when it names one of the six surfaces.
function domainOf(filePath) {
  const rel = path.relative(srcRoot, filePath);
  if (rel.startsWith("..")) return null;
  const parts = rel.split(path.sep);
  if (parts.length > 0 && DOMAINS.has(parts[0])) return parts[0];
  return null;
}

function isSharedTech(filePath) {
  const rel = path.relative(srcRoot, filePath);
  return !rel.startsWith("..") && rel.split(path.sep)[0] === SHARED_TECH;
}

function sharedTechEntryKey(parts) {
  if (parts[0] !== SHARED_TECH || parts.length < 2) return null;
  const last = parts.at(-1);
  if (last === undefined) return null;
  const withoutExt = last.replace(/\.(?:js|ts)$/, "");
  return [...parts.slice(1, -1), withoutExt].join("/");
}

// The pinned domain-surface dependency edges (rule 3). Epic 03 adds two:
// thread-view consumes the messages/turns report surfaces and the threads
// resolver; intake-stream gains the thread-view surface for the boundary
// advance registration (Flow 4).
// SANCTIONED CYCLE (Epic 03 tech design §Module Boundaries): intake-stream →
// thread-view → messages/turns → intake-stream (the last edges are type-only
// event vocabulary). The domain graph is therefore deliberately not a DAG —
// runtime-safe because the advance is registration-then-flush with no
// import-time execution — so this check pins the allowed edge set instead of
// asserting acyclicity.
const ALLOWED_SURFACE_IMPORTS = {
  "intake-stream": new Set(["threads", "messages", "turns", "thread-view"]),
  messages: new Set(["threads", "intake-stream"]),
  turns: new Set(["threads", "intake-stream", "messages"]),
  "thread-view": new Set(["threads", "messages", "turns"]),
  threads: new Set(),
  // Epic 04: inspect sits at the top of the graph — pure consumer of the
  // five surfaces, nothing imports it except sdk.ts. Acyclic by
  // construction.
  inspect: new Set(["threads", "intake-stream", "messages", "turns", "thread-view"]),
};

// Epic 04 source check (tech design §Testing Strategy): inspect composes
// other domains' SURFACES — it owns no tables and may not reach storage at
// all. Any sqlite usage or SQL keyword over a known table name inside
// src/inspect/** is a violation; a direct-SQL implementation could match
// report output while violating inspect's entire contract.
const INSPECT_FORBIDDEN_PATTERNS = [
  [/node:sqlite/, "imports node:sqlite"],
  [/DatabaseSync/, "references DatabaseSync"],
  [/\.prepare\s*\(/, "prepares a SQL statement"],
  [
    /\b(?:FROM|JOIN|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:event|message|message_block|turns|chunk|chunk_member|work_item|derived_form|derivation|thread_metadata|thread_view|thread_view_band|view_boundary|log)\b/i,
    "contains raw SQL over a domain table",
  ],
];

function inspectSourceViolations(file, source) {
  const rel = path.relative(srcRoot, file);
  if (!rel.startsWith(path.join("inspect") + path.sep)) return [];
  const found = [];
  for (const [pattern, label] of INSPECT_FORBIDDEN_PATTERNS) {
    if (pattern.test(source)) {
      found.push(`${path.relative(pkgRoot, file)} ${label} — inspect may not read storage`);
    }
  }
  return found;
}

// Classify one file's source for boundary violations (rules 1–3 + the inspect
// storage-ban). Exported so tests assert the rules directly with synthetic
// (path, source) pairs — the path need not exist on disk; only its src/-relative
// location and the source's import specifiers are read.
export function checkSource(filePath, source) {
  const violations = [];
  violations.push(...inspectSourceViolations(filePath, source));
  const fileDomain = domainOf(filePath);
  const fileSharedTech = isSharedTech(filePath);

  for (const spec of importSpecifiers(source)) {
    if (!spec.startsWith(".")) continue; // only relative imports cross our tree
    const resolved = path.resolve(path.dirname(filePath), spec);
    const relToSrc = path.relative(srcRoot, resolved);
    if (relToSrc.startsWith("..")) continue; // outside src/
    const parts = relToSrc.split(path.sep);
    const targetDomain = parts.length > 0 && DOMAINS.has(parts[0]) ? parts[0] : null;
    const sharedTechEntry = sharedTechEntryKey(parts);
    if (sharedTechEntry !== null) {
      if (fileDomain !== null && !SHARED_TECH_PUBLIC_ENTRIES.has(sharedTechEntry)) {
        violations.push(
          `${path.relative(pkgRoot, filePath)} imports ${spec} — domains must use shared-tech public entrypoint(s)`,
        );
      }
      continue;
    }
    if (targetDomain === null) continue; // imports elsewhere under src/ are not a domain edge

    // Rule 1: shared-tech may not import any domain (AC-0.6).
    if (fileSharedTech) {
      violations.push(
        `${path.relative(pkgRoot, filePath)} imports ${spec} — shared-tech may not import domain "${targetDomain}" (AC-0.6)`,
      );
      continue;
    }

    // Rule 2: a domain may not reach into another domain's internal/ modules.
    if (parts.includes("internal") && fileDomain !== targetDomain) {
      violations.push(
        `${path.relative(pkgRoot, filePath)} imports ${spec} — reaches into domain "${targetDomain}" internal/`,
      );
      continue;
    }

    // Rule 3: cross-domain surface imports only along a pinned edge.
    if (!parts.includes("internal") && fileDomain !== null && fileDomain !== targetDomain) {
      const allowed = ALLOWED_SURFACE_IMPORTS[fileDomain];
      if (allowed === undefined || !allowed.has(targetDomain)) {
        violations.push(
          `${path.relative(pkgRoot, filePath)} imports ${spec} — domain "${fileDomain}" has no pinned surface edge to "${targetDomain}" (rule 3)`,
        );
      }
    }
  }
  return violations;
}

// Run only when executed directly (not when imported by a test).
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const files = [...collectTsFiles(srcRoot), ...collectTsFiles(testRoot)];
  const violations = [];
  for (const file of files) violations.push(...checkSource(file, readFileSync(file, "utf8")));

  if (violations.length > 0) {
    console.error("boundary check FAILED:");
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }
  console.log(`boundaries: OK (${files.length} files checked, fixtures exempt)`);
}
