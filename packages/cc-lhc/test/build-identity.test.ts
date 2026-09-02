/**
 * TC-3.1a build identity binding: the stamp is explicit input, and the package
 * check accepts a stamped SHA only when it equals the accepted --source-sha.
 * Exercises the real scripts as subprocesses on a minimal assembled-package
 * fixture, and the real assembly when the workspace dists are present.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// @ts-expect-error plain ESM script module without types
import { buildIdentity, verifyBuildIdentity } from "../scripts/lib/build-identity.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const CHECK = join(packageRoot, "scripts", "check-npm-package.mjs");
const ASSEMBLE = join(packageRoot, "scripts", "assemble-npm-package.mjs");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "fedcba9876543210fedcba9876543210fedcba98";
const temps: string[] = [];
afterAll(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const manifest = { name: "cc-lhc", version: "0.4.0" };

describe("verifyBuildIdentity binds a stamp to explicit accepted input", () => {
  it("passes only unavailable identity without an accepted SHA, and only the exact SHA with one", () => {
    expect(verifyBuildIdentity({ ...manifest, sourceSha: null }, manifest, undefined)).toEqual([]);
    expect(verifyBuildIdentity({ ...manifest, sourceSha: SHA }, manifest, SHA)).toEqual([]);
    expect(verifyBuildIdentity({ ...manifest, sourceSha: SHA }, manifest, undefined).join()).toContain(
      "no accepted --source-sha",
    );
    expect(verifyBuildIdentity({ ...manifest, sourceSha: SHA }, manifest, OTHER).join()).toContain("does not equal");
    expect(verifyBuildIdentity({ ...manifest, sourceSha: null }, manifest, SHA).join()).toContain("does not equal");
    expect(verifyBuildIdentity({ ...manifest, sourceSha: "deadbeef" }, manifest, undefined).join()).toContain("40-hex");
    expect(
      verifyBuildIdentity({ ...manifest, sourceSha: null, sourceDirty: false }, manifest, undefined).join(),
    ).toContain("ambient repository state");
    expect(verifyBuildIdentity({ name: "x", version: "9", sourceSha: null }, manifest, undefined)).toHaveLength(2);
    expect(() => buildIdentity({ ...manifest, sourceSha: "HEAD" })).toThrow(/40-hex/);
  });
});

/** The smallest root check-npm-package accepts, with the given stamped identity. */
function fixture(identity: object): string {
  const root = mkdtempSync(join(tmpdir(), "cc-lhc-check-"));
  temps.push(root);
  const write = (rel: string, body: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  write(
    "package.json",
    JSON.stringify({
      ...manifest,
      license: "MIT",
      publishConfig: { access: "public" },
      bin: { "cc-lhc": "./dist/bin.js" },
      bundledDependencies: ["lhc", "cc-lhc-native"],
      ccLhcPackage: { targets: ["linux-x64"], nativeArtifact: "cc_lhc_identity.node" },
    }),
  );
  write("node_modules/lhc/package.json", "{}");
  write("node_modules/cc-lhc-native/package.json", "{}");
  write("node_modules/cc-lhc-native/prebuilds/linux-x64/cc_lhc_identity.node", "x");
  write("dist/bin.js", "");
  write("dist/build-identity.json", `${JSON.stringify(identity)}\n`);
  write("LICENSE", "MIT License\n\nCopyright (c) 2026 Lee Moore\n");
  return root;
}
function check(root: string, args: string[] = []) {
  const result = spawnSync(process.execPath, [CHECK, root, ...args], { encoding: "utf8" });
  return { status: result.status, out: String(result.stdout), err: String(result.stderr) };
}

describe("check-npm-package binds the stamped identity to --source-sha", () => {
  it("accepts the exact accepted SHA and an unavailable development stamp; rejects mismatch, unbound, and ambient state", () => {
    expect(check(fixture({ ...manifest, sourceSha: SHA }), ["--source-sha", SHA])).toMatchObject({ status: 0 });
    expect(check(fixture({ ...manifest, sourceSha: null }))).toMatchObject({ status: 0 });
    const mismatch = check(fixture({ ...manifest, sourceSha: SHA }), ["--source-sha", OTHER]);
    expect(mismatch.status).toBe(1);
    expect(mismatch.err).toContain("does not equal the accepted --source-sha");
    const unbound = check(fixture({ ...manifest, sourceSha: SHA }));
    expect(unbound.status).toBe(1);
    expect(unbound.err).toContain("no accepted --source-sha");
    expect(check(fixture({ ...manifest, sourceSha: null }), ["--source-sha", SHA]).status).toBe(1);
    const dirty = check(fixture({ ...manifest, sourceSha: null, sourceDirty: true }));
    expect(dirty.status).toBe(1);
    expect(dirty.err).toContain("ambient repository state");
    const malformed = check(fixture({ ...manifest, sourceSha: null }), ["--source-sha", "HEAD"]);
    expect(malformed.status).toBe(1);
    expect(malformed.err).toContain("--source-sha must be");
  });
});

const dists = [
  join(packageRoot, "dist", "bin.js"),
  join(packageRoot, "..", "lhc", "dist"),
  join(packageRoot, "..", "cc-lhc-native", "dist"),
];
const prebuild = join(packageRoot, "..", "cc-lhc-native", "prebuilds", `${process.platform}-${process.arch}`);
const canAssemble = dists.every((p) => existsSync(p)) && existsSync(prebuild);

describe.skipIf(!canAssemble)("assembled package identity comes from the assembly's explicit input", () => {
  it("assemble --source-sha stamps exactly that SHA; check passes with it and fails without it or with another", () => {
    const out = mkdtempSync(join(tmpdir(), "cc-lhc-assembled-"));
    temps.push(out);
    const assembled = spawnSync(
      process.execPath,
      [ASSEMBLE, "--out", out, "--targets", "current", "--source-sha", SHA],
      {
        encoding: "utf8",
      },
    );
    expect(assembled.status, String(assembled.stderr)).toBe(0);
    expect(JSON.parse(readFileSync(join(out, "dist", "build-identity.json"), "utf8"))).toEqual({
      ...manifest,
      sourceSha: SHA,
    });
    expect(check(out, ["--source-sha", SHA]).status).toBe(0);
    expect(check(out).status).toBe(1);
    expect(check(out, ["--source-sha", OTHER]).status).toBe(1);
    // Without an accepted SHA the assembly truthfully stamps identity unavailable, whatever the workspace stamp said.
    const plain = spawnSync(process.execPath, [ASSEMBLE, "--out", out, "--targets", "current"], { encoding: "utf8" });
    expect(plain.status, String(plain.stderr)).toBe(0);
    expect(JSON.parse(readFileSync(join(out, "dist", "build-identity.json"), "utf8"))).toEqual({
      ...manifest,
      sourceSha: null,
    });
    expect(check(out).status).toBe(0);
  }, 60_000);
});
