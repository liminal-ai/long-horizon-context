/**
 * Release-asset contract: shared asset naming + SHA-256 checksum logic
 * (scripts/asset-names.mjs) and the aggregation script that merges per-target
 * CI artifacts into a bundle plus checksummed release-candidate assets
 * (scripts/assemble-release-bundle.mjs). The aggregation script is exercised
 * for real against fake package roots, including every rejection path.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { defaultPackageRoot } from "../src/index.js";
import { loadTargetsManifest, targetKey } from "../src/targets.js";

const packageRoot = defaultPackageRoot();
const realManifest = loadTargetsManifest(join(packageRoot, "targets.json"));
const assetLib = await import(pathToFileURL(join(packageRoot, "scripts", "asset-names.mjs")).href);

describe("asset naming", () => {
  it("maps every manifest target to a distinct flat asset name", () => {
    const names = realManifest.targets.map((t) => assetLib.assetNameForTarget(realManifest.artifact, targetKey(t)));
    expect(names).toContain("cc_lhc_identity-linux-x64.node");
    expect(names).toContain("cc_lhc_identity-win32-arm64.node");
    expect(new Set(names).size).toBe(realManifest.targets.length);
    for (const name of names) {
      expect(name.endsWith(".node")).toBe(true);
    }
  });

  it("rejects malformed artifact names and target keys", () => {
    expect(() => assetLib.assetNameForTarget("evil.dll", "linux-x64")).toThrow(/\.node/);
    expect(() => assetLib.assetNameForTarget("cc_lhc_identity.node", "linux/x64")).toThrow(/malformed/);
    expect(() => assetLib.assetNameForTarget("cc_lhc_identity.node", "..")).toThrow(/malformed/);
  });
});

describe("checksum parsing and verification", () => {
  const body = Buffer.from("native-addon-bytes");
  const hex = createHash("sha256").update(body).digest("hex");
  const name = "cc_lhc_identity-linux-x64.node";

  it("round trips through checksumLine/parseChecksums/verifyAssetChecksum", () => {
    const entries = assetLib.parseChecksums(assetLib.checksumLine(hex, name) + "\n");
    expect(entries.get(name)).toBe(hex);
    expect(assetLib.verifyAssetChecksum(entries, name, body)).toEqual({ ok: true });
  });

  it("rejects a tampered buffer", () => {
    const entries = assetLib.parseChecksums(assetLib.checksumLine(hex, name));
    const verdict = assetLib.verifyAssetChecksum(entries, name, Buffer.from("tampered"));
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("checksum mismatch");
  });

  it("rejects an asset with no checksum entry", () => {
    const entries = assetLib.parseChecksums(assetLib.checksumLine(hex, name));
    const verdict = assetLib.verifyAssetChecksum(entries, "cc_lhc_identity-win32-x64.node", body);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("no entry");
  });

  it("uppercase digests are normalized before comparison", () => {
    const entries = assetLib.parseChecksums(assetLib.checksumLine(hex.toUpperCase(), name));
    expect(assetLib.verifyAssetChecksum(entries, name, body)).toEqual({ ok: true });
  });

  it("throws on malformed, duplicate, or empty checksum files", () => {
    expect(() => assetLib.parseChecksums("not a checksum line")).toThrow(/malformed/);
    expect(() => assetLib.parseChecksums(`${hex} ${name}`)).toThrow(/malformed/); // single space
    expect(() =>
      assetLib.parseChecksums([assetLib.checksumLine(hex, name), assetLib.checksumLine(hex, name)].join("\n")),
    ).toThrow(/twice/);
    expect(() => assetLib.parseChecksums("\n\n")).toThrow(/empty/);
  });
});

// ---------------------------------------------------------------------------
// Aggregation script against fake package roots.
// ---------------------------------------------------------------------------

const FAKE_TARGET_KEYS = ["linux-x64", "win32-arm64"];

function makeFakePackageRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "cc-lhc-agg-pkg-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "cc-lhc-native", private: true }));
  writeFileSync(join(root, "README.md"), "# fake\n");
  writeFileSync(
    join(root, "targets.json"),
    JSON.stringify({
      name: "cc-lhc-native",
      napiVersion: 8,
      artifact: "cc_lhc_identity.node",
      targets: FAKE_TARGET_KEYS.map((key) => {
        const [platform, arch] = key.split("-");
        return { platform, arch };
      }),
    }),
  );
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "dist", "index.js"), "export {};\n");
  return root;
}

function makeArtifacts(keys: string[], mutate?: (dir: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), "cc-lhc-agg-art-"));
  for (const key of keys) {
    const dir = join(root, `prebuild-${key}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "cc_lhc_identity.node"), `bytes-for-${key}`);
  }
  mutate?.(root);
  return root;
}

function runAssemble(artifacts: string, pkgRoot: string) {
  const out = mkdtempSync(join(tmpdir(), "cc-lhc-agg-out-"));
  const bundleOut = join(out, "bundle");
  const assetsOut = join(out, "assets");
  const result = spawnSync(
    process.execPath,
    [
      join(packageRoot, "scripts", "assemble-release-bundle.mjs"),
      "--artifacts",
      artifacts,
      "--bundle-out",
      bundleOut,
      "--assets-out",
      assetsOut,
      "--package-root",
      pkgRoot,
    ],
    { encoding: "utf8" },
  );
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", bundleOut, assetsOut };
}

describe("assemble-release-bundle", () => {
  it("merges a complete artifact set into bundle + checksummed assets", () => {
    const pkg = makeFakePackageRoot();
    const run = runAssemble(makeArtifacts(FAKE_TARGET_KEYS), pkg);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);

    for (const name of ["package.json", "README.md", "targets.json", join("dist", "index.js")]) {
      expect(existsSync(join(run.bundleOut, name)), name).toBe(true);
    }
    for (const key of FAKE_TARGET_KEYS) {
      const artifact = join(run.bundleOut, "prebuilds", key, "cc_lhc_identity.node");
      expect(readFileSync(artifact, "utf8")).toBe(`bytes-for-${key}`);
    }

    const sums = assetLib.parseChecksums(readFileSync(join(run.assetsOut, "SHA256SUMS"), "utf8"));
    expect(sums.size).toBe(FAKE_TARGET_KEYS.length);
    for (const key of FAKE_TARGET_KEYS) {
      const assetName = `cc_lhc_identity-${key}.node`;
      const bytes = readFileSync(join(run.assetsOut, assetName));
      expect(bytes.toString("utf8")).toBe(`bytes-for-${key}`);
      expect(assetLib.verifyAssetChecksum(sums, assetName, bytes)).toEqual({ ok: true });
    }
  });

  it("rejects a missing target", () => {
    const run = runAssemble(makeArtifacts(["linux-x64"]), makeFakePackageRoot());
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("missing artifact for target win32-arm64");
  });

  it("rejects an unknown artifact directory", () => {
    const artifacts = makeArtifacts(FAKE_TARGET_KEYS, (root) => {
      mkdirSync(join(root, "prebuild-sunos-sparc"));
      writeFileSync(join(root, "prebuild-sunos-sparc", "cc_lhc_identity.node"), "x");
    });
    const run = runAssemble(artifacts, makeFakePackageRoot());
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("unexpected entry prebuild-sunos-sparc");
  });

  it("rejects stray files inside a target artifact", () => {
    const artifacts = makeArtifacts(FAKE_TARGET_KEYS, (root) => {
      writeFileSync(join(root, "prebuild-linux-x64", "extra.txt"), "nope");
    });
    const run = runAssemble(artifacts, makeFakePackageRoot());
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("exactly one file named cc_lhc_identity.node");
  });

  it("rejects a wrongly named artifact file", () => {
    const artifacts = makeArtifacts(["win32-arm64"], (root) => {
      const dir = join(root, "prebuild-linux-x64");
      mkdirSync(dir);
      writeFileSync(join(dir, "wrong.node"), "bytes");
    });
    const run = runAssemble(artifacts, makeFakePackageRoot());
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("prebuild-linux-x64 must contain exactly one file");
  });

  it("rejects an empty artifact", () => {
    const artifacts = makeArtifacts(FAKE_TARGET_KEYS, (root) => {
      writeFileSync(join(root, "prebuild-linux-x64", "cc_lhc_identity.node"), "");
    });
    const run = runAssemble(artifacts, makeFakePackageRoot());
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("empty");
  });

  it("refuses a package root without built dist", () => {
    const pkg = makeFakePackageRoot();
    const bare = mkdtempSync(join(tmpdir(), "cc-lhc-agg-bare-"));
    writeFileSync(join(bare, "package.json"), "{}");
    writeFileSync(join(bare, "README.md"), "#\n");
    writeFileSync(join(bare, "targets.json"), readFileSync(join(pkg, "targets.json")));
    const run = runAssemble(makeArtifacts(FAKE_TARGET_KEYS), bare);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("dist");
  });
});
