import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
}

function readPackageJson(): PackageJson {
  return JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as PackageJson;
}

// Foundation invariant (test-plan Chunk 0): the package's verification tiers and
// their script files exist and run, so every later chunk can exit on its gate.
describe("package verification config", () => {
  it("declares every verification-tier script the gates depend on", () => {
    const pkg = readPackageJson();
    for (const script of [
      "build",
      "typecheck",
      "lint",
      "boundaries",
      "test",
      "red-verify",
      "verify",
      "green-verify",
      "verify-all",
    ]) {
      expect(typeof pkg.scripts?.[script]).toBe("string");
    }
  });

  it("composes the tiers the way the tech design specifies", () => {
    const pkg = readPackageJson();
    const scripts = pkg.scripts ?? {};
    // red-verify = build + typecheck + lint + boundaries (no behavior tests)
    expect(scripts["red-verify"]).toContain("build");
    expect(scripts["red-verify"]).toContain("boundaries");
    // verify (the story gate) is red-verify + the test run
    expect(scripts["verify"]).toContain("red-verify");
    expect(scripts["verify"]).toContain("vitest run");
    // green-verify adds the test-immutability guard; verify-all == verify (no e2e yet)
    expect(scripts["green-verify"]).toContain("check-test-immutability");
    expect(scripts["verify-all"]).toContain("verify");
  });

  it("ships the gate script files package.json references", () => {
    for (const script of [
      "lint.mjs",
      "check-boundaries.mjs",
      "check-test-immutability.mjs",
      "record-red-manifest.mjs",
    ]) {
      expect(existsSync(join(pkgRoot, "scripts", script))).toBe(true);
    }
  });

  it("depends on the lhc workspace package", () => {
    const pkg = readPackageJson();
    expect(pkg.dependencies?.lhc).toBeDefined();
  });
});
