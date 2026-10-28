import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import * as modal from "../../src/wrapper/modal.js";
import * as terminology from "../../src/wrapper/terminology.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (path.endsWith(".ts") || path.endsWith(".md")) out.push(path);
  }
  return out;
}

const FORBIDDEN = [
  /compact_confirm/,
  /compact-confirm/,
  /COMPACT_CONFIRM/,
  /CompactConfirm/,
  /askBeforeSwap/,
  /wait-or-orphan/,
  /\bconsent\b/i,
  /formatOperatorAuthorized/,
  /NotAuthorized/,
  /AskingBefore/,
  /\bgraceMs\b/,
  /\bgracePeriod/,
  /\bgrace_pending\b/,
  /\bgraceEpoch\b/,
  /\bcompactGrace/,
  /\bgrace (period|state|timer|window)\b/i,
];

const SURFACES = [
  ...walk(join(PACKAGE_ROOT, "src")),
  join(PACKAGE_ROOT, "README.md"),
  join(REPO_ROOT, "docs", "onboard", "05-host-cc-lhc.md"),
];

describe("removed surfaces: Compact-delay grace and wait-or-orphan consent (TC-2.4c, TC-2.5c)", () => {
  it("source, help, README, and onboarding docs carry none of it", () => {
    const hits: string[] = [];
    for (const file of SURFACES) {
      const lines = readFileSync(file, "utf8").split("\n");
      for (const pattern of FORBIDDEN) {
        const line = lines.findIndex((l) => pattern.test(l));
        if (line >= 0) hits.push(`${file.replace(`${REPO_ROOT}/`, "")}:${line + 1} ${pattern}`);
      }
    }
    expect(hits).toEqual([]);
    expect(existsSync(join(PACKAGE_ROOT, "src", "wrapper", "compact-confirm.ts"))).toBe(false);
  });

  it("the census is scoped: child-termination timing is still present and legal", () => {
    const run = readFileSync(join(PACKAGE_ROOT, "src", "wrapper", "run.ts"), "utf8");
    expect(run).toMatch(/sigtermGraceMs/);
    expect(run).toMatch(/graceful/);
    expect(FORBIDDEN.some((p) => p.test("compactGraceMs: 30_000"))).toBe(true);
    expect(FORBIDDEN.some((p) => p.test("grace_pending"))).toBe(true);
    expect(FORBIDDEN.some((p) => p.test("sigtermGraceMs: 300"))).toBe(false);
    expect(FORBIDDEN.some((p) => p.test("const graceful = true"))).toBe(false);
  });

  it("the modal has no confirmation mode and terminology has no consent copy", () => {
    expect("openCompactConfirm" in modal).toBe(false);
    for (const name of [
      "formatOperatorAuthorized",
      "formatAskingBeforeSmartCompact",
      "formatAutoNotAuthorizedLog",
      "formatAutoNotAuthorizedSummary",
    ]) {
      expect(name in terminology, name).toBe(false);
    }
    const result = modal.processInputChunk(Buffer.from("y"), modal.createInputState());
    expect(result.state.mode).toBe("passthrough");
    expect(result.actions.some((action) => (action.kind as string).includes("confirm"))).toBe(false);
  });

  it("the tests that drove the removed screen are gone", () => {
    for (const name of ["async-work-confirm.test.ts", "compact-confirm.test.ts"]) {
      expect(existsSync(join(PACKAGE_ROOT, "test", "wrapper", name)), name).toBe(false);
    }
  });
});
