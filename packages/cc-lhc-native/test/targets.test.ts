import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  defaultPackageRoot,
  isSupportedTarget,
  loadTargetsManifest,
  parseTargetsManifest,
  TARGETS_MANIFEST_FILENAME,
  targetKey,
} from "../src/index.js";

describe("parseTargetsManifest", () => {
  const valid = {
    name: "cc-lhc-native",
    napiVersion: 8,
    artifact: "cc_lhc_identity.node",
    targets: [{ platform: "linux", arch: "x64" }],
  };

  it("accepts a valid manifest", () => {
    const manifest = parseTargetsManifest(valid);
    expect(manifest.artifact).toBe("cc_lhc_identity.node");
    expect(manifest.targets).toEqual([{ platform: "linux", arch: "x64" }]);
  });

  it("rejects non-objects and missing fields", () => {
    expect(() => parseTargetsManifest(null)).toThrow(/not an object/);
    expect(() => parseTargetsManifest([])).toThrow(/not an object/);
    expect(() => parseTargetsManifest({ ...valid, name: "" })).toThrow(/name/);
    expect(() => parseTargetsManifest({ ...valid, napiVersion: 7 })).toThrow(/napiVersion/);
    expect(() => parseTargetsManifest({ ...valid, artifact: "x.dll" })).toThrow(/artifact/);
    expect(() => parseTargetsManifest({ ...valid, targets: [] })).toThrow(/non-empty/);
  });

  it("rejects unknown platforms, unknown arches, and duplicates", () => {
    expect(() => parseTargetsManifest({ ...valid, targets: [{ platform: "freebsd", arch: "x64" }] })).toThrow(
      /unknown platform/,
    );
    expect(() => parseTargetsManifest({ ...valid, targets: [{ platform: "linux", arch: "ia32" }] })).toThrow(
      /unknown arch/,
    );
    expect(() =>
      parseTargetsManifest({
        ...valid,
        targets: [
          { platform: "linux", arch: "x64" },
          { platform: "linux", arch: "x64" },
        ],
      }),
    ).toThrow(/duplicate/);
  });
});

describe("shipped targets.json", () => {
  it("parses strictly and covers all three native platforms", () => {
    const manifest = loadTargetsManifest(join(defaultPackageRoot(), TARGETS_MANIFEST_FILENAME));
    expect(manifest.name).toBe("cc-lhc-native");
    expect(manifest.napiVersion).toBe(8);
    const keys = manifest.targets.map(targetKey);
    for (const required of ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64", "win32-arm64"]) {
      expect(keys).toContain(required);
    }
    expect(isSupportedTarget(manifest, "linux", "x64")).toBe(true);
    expect(isSupportedTarget(manifest, "freebsd", "x64")).toBe(false);
    expect(isSupportedTarget(manifest, "linux", "ia32")).toBe(false);
  });
});
