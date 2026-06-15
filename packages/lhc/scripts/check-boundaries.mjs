#!/usr/bin/env node
// Zero-dependency import-boundary check.
// Rules:
//   1. No file may import another domain's internal/ modules.
//   2. tech-utils/ and shared/ may not import from domains/.
//   3. A domain may import another domain's surface (index.ts) only along an
//      edge pinned in ALLOWED_SURFACE_IMPORTS below — a new cross-domain
//      edge is a conscious decision, never a silent pass.
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
// domains/inspect/** is a violation; a direct-SQL implementation could match
// report output while violating inspect's entire contract.
const INSPECT_FORBIDDEN_PATTERNS = [
  [/node:sqlite/, "imports node:sqlite"],
  [/DatabaseSync/, "references DatabaseSync"],
  [/\.prepare\s*\(/, "prepares a SQL statement"],
  [
    /\b(?:FROM|JOIN|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:event|message|message_block|turns|chunk|chunk_member|work_item|derived_form|thread_metadata|thread_view|thread_view_band|view_boundary)\b/i,
    "contains raw SQL over a domain table",
  ],
];

function inspectSourceViolations(file, source) {
  const rel = path.relative(srcRoot, file);
  if (!rel.startsWith(path.join("domains", "inspect") + path.sep)) return [];
  const found = [];
  for (const [pattern, label] of INSPECT_FORBIDDEN_PATTERNS) {
    if (pattern.test(source)) {
      found.push(`${path.relative(pkgRoot, file)} ${label} — inspect may not read storage`);
    }
  }
  return found;
}

const files = [...collectTsFiles(srcRoot), ...collectTsFiles(testRoot)];
const violations = [];

for (const file of files) {
  const source = readFileSync(file, "utf8");
  violations.push(...inspectSourceViolations(file, source));
  const fileDomain = domainOf(file);
  // Epic 05: inference/ implements the provider seam, owns no thread state,
  // and depends only on shared/ types — it may not import domains/.
  const inTechUtilsOrShared =
    file.startsWith(path.join(srcRoot, "tech-utils") + path.sep) ||
    file.startsWith(path.join(srcRoot, "shared") + path.sep) ||
    file.startsWith(path.join(srcRoot, "inference") + path.sep);

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
    if (
      parts[0] === "domains" &&
      !parts.includes("internal") &&
      fileDomain !== null &&
      parts[1] !== fileDomain
    ) {
      const targetDomain = parts[1];
      const allowed = ALLOWED_SURFACE_IMPORTS[fileDomain];
      if (allowed === undefined || !allowed.has(targetDomain)) {
        violations.push(
          `${path.relative(pkgRoot, file)} imports ${spec} — domain "${fileDomain}" has no pinned surface edge to "${targetDomain}" (rule 3)`,
        );
      }
    }
    if (inTechUtilsOrShared && parts[0] === "domains") {
      violations.push(
        `${path.relative(pkgRoot, file)} imports ${spec} — tech-utils/shared/inference may not import domains/`,
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
