#!/usr/bin/env node
// Port gate for lhc-convex — receipts, not frozen counts (py-wave pattern).
//
// Runs the full vitest suite with the JSON reporter and fails closed unless:
//   1. vitest itself exits cleanly and the JSON report is produced;
//   2. zero failed tests;
//   3. every non-passed test is registered in scripts/intentional_skips.json
//      (and every registered skip still exists — no stale register entries);
//   4. counts reconcile: passed + skipped == total collected (no bucket the
//      gate does not understand — vitest 'todo'/'disabled' would surface here).
//
// Prints PORT-GATE receipt lines. Totals are evidence, never pass criteria.
//
// Usage: node scripts/check_gate.mjs   (from packages/lhc-convex)

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT = join("/tmp", `lhc-convex-gate-${process.pid}.json`);

let vitestFailed = false;
try {
  execFileSync("pnpm", ["exec", "vitest", "run", "--reporter=json", `--outputFile=${REPORT}`], {
    cwd: PKG,
    stdio: ["ignore", "ignore", "inherit"],
  });
} catch {
  // A failing suite still writes the report; classify from the report below.
  vitestFailed = true;
}

const report = JSON.parse(readFileSync(REPORT, "utf8"));
const register = JSON.parse(readFileSync(join(PKG, "scripts", "intentional_skips.json"), "utf8"));
const registered = new Map(register.skips.map((s) => [s.fullName, s]));

const problems = [];
const seenSkips = new Set();
let passed = 0;
let skipped = 0;
let failed = 0;
let other = 0;

for (const file of report.testResults) {
  for (const t of file.assertionResults) {
    if (t.status === "passed") passed += 1;
    else if (t.status === "failed") {
      failed += 1;
      problems.push(`FAILED: ${t.fullName}`);
    } else if (t.status === "skipped" || t.status === "pending" || t.status === "todo") {
      skipped += 1;
      if (!registered.has(t.fullName)) {
        problems.push(`UNREGISTERED SKIP: ${t.fullName}`);
      } else {
        seenSkips.add(t.fullName);
      }
    } else {
      other += 1;
      problems.push(`UNCLASSIFIED STATUS ${t.status}: ${t.fullName}`);
    }
  }
}

for (const name of registered.keys()) {
  if (!seenSkips.has(name)) problems.push(`STALE REGISTER ENTRY (no such skipped test): ${name}`);
}

const total = report.numTotalTests;
if (passed + skipped + failed + other !== total) {
  problems.push(
    `RECONCILIATION: passed(${passed}) + skipped(${skipped}) + failed(${failed}) + other(${other}) != total(${total})`,
  );
}
if (vitestFailed && failed === 0) {
  problems.push(
    "RUNNER: vitest exited non-zero but the report shows no failed tests — investigate before trusting this run",
  );
}

const byClass = { "ts-mirror": 0, "port-lag": 0, infra: 0 };
for (const name of seenSkips) byClass[registered.get(name).class] += 1;

console.log(`PORT-GATE total=${total} passed=${passed} skipped=${skipped} failed=${failed}`);
console.log(
  `PORT-GATE skips: ts-mirror=${byClass["ts-mirror"]} port-lag=${byClass["port-lag"]} infra=${byClass["infra"]}`,
);
if (problems.length > 0) {
  console.error("PORT-GATE FAIL");
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log("PORT-GATE PASS");
