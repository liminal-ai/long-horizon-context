/**
 * The release scripts take their version from --version, else
 * packages/cc-lhc/package.json, never a literal (long-horizon-context-bvb).
 * Exercises the real scripts as subprocesses; each stops at its version check
 * or the check right after it, so nothing is installed.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// @ts-expect-error — plain .mjs helper without declarations
import { candidateVersionFromArgv, packageVersion } from "../scripts/lib/candidate-version.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scripts = join(here, "..", "scripts");
const STANDALONE = join(scripts, "assemble-standalone-bundle.mjs");
const CHECK_STANDALONE = join(scripts, "check-standalone-bundle.mjs");
const REPO_VERSION = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version as string;
const target = `${process.platform}-${process.arch}`;
const temps: string[] = [];
afterAll(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/** A package root carrying only a manifest, with a target other than this host's. */
function packageRootWith(version: string): string {
  const root = tempDir("cc-lhc-bundle-version-");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "cc-lhc", version, ccLhcPackage: { targets: ["not-this-target"] } }),
  );
  return root;
}

function assembleStandalone(root: string, extra: string[] = []) {
  return spawnSync(process.execPath, [STANDALONE, "--package-root", root, "--target", target, ...extra], {
    encoding: "utf8",
  });
}

describe("candidateVersionFromArgv", () => {
  it("defaults to packages/cc-lhc/package.json and takes --version when given", () => {
    expect(packageVersion()).toBe(REPO_VERSION);
    expect(candidateVersionFromArgv([])).toBe(REPO_VERSION);
    expect(candidateVersionFromArgv(["--version", "0.4.3-local.2"])).toBe("0.4.3-local.2");
    expect(() => candidateVersionFromArgv(["--version"])).toThrow(/requires a value/);
    expect(() => candidateVersionFromArgv(["--version", "latest"])).toThrow(/invalid candidate version/);
  });
});

describe("assemble-standalone-bundle version check", () => {
  it("accepts a candidate whose version equals --version (not only 0.4.2)", () => {
    const result = assembleStandalone(packageRootWith("0.4.3-local.9"), ["--version", "0.4.3-local.9"]);
    expect(result.status).toBe(1);
    // Past the version check: it stops at the next one, the target list.
    expect(result.stderr).not.toContain("approved cc-lhc@");
    expect(result.stderr).toContain(`package candidate must contain only target ${target}`);
  });

  it("refuses a candidate whose version differs from --version", () => {
    const result = assembleStandalone(packageRootWith("0.4.3-local.9"), ["--version", "0.4.3"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("package root does not contain the approved cc-lhc@0.4.3 candidate");
  });

  it("without --version expects packages/cc-lhc/package.json's version", () => {
    const matching = assembleStandalone(packageRootWith(REPO_VERSION));
    expect(matching.stderr).not.toContain("approved cc-lhc@");
    const other = assembleStandalone(packageRootWith("9.9.9"));
    expect(other.stderr).toContain(`approved cc-lhc@${REPO_VERSION} candidate`);
  });
});

describe("check-standalone-bundle version check", () => {
  it("expects --version when given, else package.json's version", () => {
    const bundle = tempDir("cc-lhc-bundle-check-");
    mkdirSync(bundle, { recursive: true });
    writeFileSync(
      join(bundle, "release-manifest.json"),
      JSON.stringify({ schemaVersion: 1, product: "cc-lhc", version: "0.4.3-local.9", target }),
    );
    const run = (extra: string[]) =>
      spawnSync(process.execPath, [CHECK_STANDALONE, bundle, ...extra], { encoding: "utf8" });
    expect(run(["--version", "0.4.3-local.9"]).stderr).not.toContain("unexpected identity");
    expect(run([]).stderr).toContain("unexpected identity");
  });
});
