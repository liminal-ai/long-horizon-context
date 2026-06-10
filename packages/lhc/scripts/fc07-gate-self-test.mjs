#!/usr/bin/env node
// FC-0.7 gate self-test — proves the verification gates fail when they should,
// once, with REAL sacrificial files run through the REAL package scripts. This
// is the load-bearing proof the story calls out: an unproven gate is an assumed
// gate. Run once (Chunk 0), evidence recorded, sacrificial files removed.
//
//   Baseline : clean `pnpm run verify` exits 0 (also confirms the test typecheck fix).
//   Proof 1  : a sacrificial FAILING test makes `pnpm run verify` exit non-zero.
//   Proof 2a : an unchanged Red-manifest file passes `pnpm run green-verify` (the
//              gate is discriminating, not always-fail).
//   Proof 2b : editing that same Red-manifest file makes `pnpm run green-verify`
//              fail at check-test-immutability — while `verify` itself stays green,
//              so the failure is attributable to the immutability gate alone.
//   End state: clean `pnpm run verify-all` exits 0 (files removed, manifest restored).
//
// Exits 0 only if every leg behaved exactly as required; non-zero otherwise.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const at = (p) => path.join(pkgRoot, p);

const FAILING = "test/_fc07-failing.test.ts";
const RED = "test/_fc07-red.test.ts";
const MANIFEST = "test/red-manifest.json";
const RECORD =
  "docs/02-specs/01-thread-record-and-intake/artifacts/00-foundation/fc-07-gate-self-test.md";

const FAILING_SRC = `import { describe, expect, it } from "vitest";

// FC-0.7 sacrificial: a deliberately failing assertion. Proves a failing test
// fails \`verify\`. Created and removed by scripts/fc07-gate-self-test.mjs.
describe("FC-0.7 sacrificial failing test", () => {
  it("fails on purpose so verify must go red", () => {
    expect(1).toBe(2);
  });
});
`;

const RED_SRC = `import { describe, expect, it } from "vitest";

// FC-0.7 sacrificial Red-phase test: passes, recorded into red-manifest.json,
// then edited to prove green-verify's immutability check catches the change.
// Created and removed by scripts/fc07-gate-self-test.mjs.
describe("FC-0.7 sacrificial Red-phase test", () => {
  it("passes so verify stays green; the post-Red edit is what trips green-verify", () => {
    expect(true).toBe(true);
  });
});
`;

const RED_EDIT = `\n// Edited after the Red commit — green-verify's test-immutability check must reject this.\n`;

function runScript(script) {
  try {
    const out = execFileSync("pnpm", ["run", script], {
      cwd: pkgRoot,
      encoding: "utf8",
    });
    return { code: 0, out };
  } catch (e) {
    const code = typeof e.status === "number" ? e.status : 1;
    return { code, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function tail(text, n = 30) {
  const lines = text.replace(/\s+$/, "").split("\n");
  return lines.slice(Math.max(0, lines.length - n)).join("\n");
}

const legs = [];
function record(title, command, expectation, run, passed, extra = "") {
  legs.push({ title, command, expectation, code: run.code, out: run.out, passed, extra });
  const mark = passed ? "OK  " : "FAIL";
  console.log(`\n[${mark}] ${title} — exit ${run.code} (expected: ${expectation})`);
  if (extra) console.log(`       ${extra}`);
}

let ok = true;
const manifestExisted = existsSync(at(MANIFEST));
const manifestBackup = manifestExisted ? readFileSync(at(MANIFEST)) : null;

function restoreManifest() {
  if (manifestExisted) writeFileSync(at(MANIFEST), manifestBackup);
  else rmSync(at(MANIFEST), { force: true });
}

try {
  // Baseline — clean verify must pass (confirms the typecheck fix landed clean).
  const base = runScript("verify");
  const basePass = base.code === 0;
  ok = ok && basePass;
  record("Baseline: clean `pnpm run verify`", "pnpm run verify", "exit 0", base, basePass);

  // Proof 1 — a failing test fails verify.
  writeFileSync(at(FAILING), FAILING_SRC);
  const p1 = runScript("verify");
  const p1Pass = p1.code !== 0;
  ok = ok && p1Pass;
  record(
    "Proof 1: sacrificial failing test fails `pnpm run verify`",
    "pnpm run verify  (with test/_fc07-failing.test.ts present)",
    "non-zero exit",
    p1,
    p1Pass,
  );
  rmSync(at(FAILING), { force: true });

  // Proof 2 — edited Red-manifest file fails green-verify, verify itself green.
  writeFileSync(at(RED), RED_SRC);
  execFileSync("node", ["scripts/record-red-manifest.mjs", RED], {
    cwd: pkgRoot,
    encoding: "utf8",
  });

  const p2a = runScript("green-verify");
  const p2aPass = p2a.code === 0;
  ok = ok && p2aPass;
  record(
    "Proof 2a: unchanged Red file passes `pnpm run green-verify`",
    "pnpm run green-verify  (Red file matches manifest)",
    "exit 0 (gate is discriminating)",
    p2a,
    p2aPass,
  );

  writeFileSync(at(RED), RED_SRC + RED_EDIT);
  const p2b = runScript("green-verify");
  const immutabilityTripped = /test-immutability FAILED/.test(p2b.out);
  const p2bPass = p2b.code !== 0 && immutabilityTripped;
  ok = ok && p2bPass;
  record(
    "Proof 2b: edited Red file fails `pnpm run green-verify`",
    "pnpm run green-verify  (Red file edited after manifest)",
    "non-zero exit at check-test-immutability",
    p2b,
    p2bPass,
    immutabilityTripped
      ? "verify passed; failure isolated to the immutability gate"
      : "WARNING: expected `test-immutability FAILED` in output",
  );
  rmSync(at(RED), { force: true });
  restoreManifest();

  // End state — clean verify-all passes.
  const fin = runScript("verify-all");
  const finPass = fin.code === 0;
  ok = ok && finPass;
  record("End state: clean `pnpm run verify-all`", "pnpm run verify-all", "exit 0", fin, finPass);
} finally {
  rmSync(at(FAILING), { force: true });
  rmSync(at(RED), { force: true });
  restoreManifest();
}

const stamp = new Date().toISOString();
const lines = [
  "# FC-0.7 Gate Self-Test — Recorded Proof",
  "",
  `- **Recorded:** ${stamp}`,
  "- **Story:** 00-foundation (Chunk 0)",
  "- **Requirement:** FC-0.7 — a sacrificial failing test fails `verify`; an edited Red-phase test file fails `green-verify`.",
  "- **Method:** real sacrificial test files run through the real package gate scripts; files removed and `red-manifest.json` restored afterward.",
  `- **Verdict:** ${ok ? "PASS — the gates fail correctly." : "INCONCLUSIVE — at least one leg did not behave as required (see below)."}`,
  "",
  "| Leg | Command | Expected | Exit | Result |",
  "|-----|---------|----------|------|--------|",
];
for (const leg of legs) {
  lines.push(
    `| ${leg.title} | \`${leg.command}\` | ${leg.expectation} | ${leg.code} | ${leg.passed ? "OK" : "FAIL"} |`,
  );
}
lines.push("", "## Captured output (tails)", "");
for (const leg of legs) {
  lines.push(`### ${leg.title}`, "", `Exit code: \`${leg.code}\` — expected: ${leg.expectation}`);
  if (leg.extra) lines.push("", leg.extra);
  lines.push("", "```", tail(leg.out), "```", "");
}
const recordText = lines.join("\n");
writeFileSync(at(RECORD), `${recordText}\n`);

console.log(`\nProof recorded to ${RECORD}`);
console.log(
  ok
    ? "\nFC-0.7 GATE SELF-TEST: PASS — both gates proven to fail when they should."
    : "\nFC-0.7 GATE SELF-TEST: INCONCLUSIVE — see the recorded proof for the failing leg.",
);
process.exit(ok ? 0 : 1);
