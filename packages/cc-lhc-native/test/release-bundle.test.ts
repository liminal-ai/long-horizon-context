import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  missingReleaseBundleFiles,
  parseTargetsManifest,
  prebuiltArtifactRelativePath,
  RELEASE_BUNDLE_STATIC_FILES,
} from "../src/index.js";

const manifest = parseTargetsManifest({
  name: "cc-lhc-native",
  napiVersion: 8,
  artifact: "cc_lhc_identity.node",
  targets: [
    { platform: "linux", arch: "x64" },
    { platform: "darwin", arch: "arm64" },
    { platform: "win32", arch: "x64" },
  ],
});

const root = "/bundle";
const allStatic = RELEASE_BUNDLE_STATIC_FILES.map((relative) => join(root, relative));
const artifactFor = (key: string): string => join(root, prebuiltArtifactRelativePath(manifest, key));

function existsIn(paths: string[]): (path: string) => boolean {
  return (path) => paths.includes(path);
}

describe("missingReleaseBundleFiles", () => {
  it("accepts a complete full bundle", () => {
    const paths = [...allStatic, artifactFor("linux-x64"), artifactFor("darwin-arm64"), artifactFor("win32-x64")];
    expect(missingReleaseBundleFiles({ bundleRoot: root, manifest, exists: existsIn(paths) })).toEqual([]);
  });

  it("reports every missing prebuilt artifact by relative path", () => {
    const paths = [...allStatic, artifactFor("linux-x64")];
    const missing = missingReleaseBundleFiles({ bundleRoot: root, manifest, exists: existsIn(paths) });
    expect(missing).toEqual([
      prebuiltArtifactRelativePath(manifest, "darwin-arm64"),
      prebuiltArtifactRelativePath(manifest, "win32-x64"),
    ]);
  });

  it("reports missing static files (dist, manifest, docs)", () => {
    const paths = [
      ...allStatic.filter((path) => !path.endsWith("index.js") && !path.endsWith("targets.json")),
      artifactFor("linux-x64"),
      artifactFor("darwin-arm64"),
      artifactFor("win32-x64"),
    ];
    const missing = missingReleaseBundleFiles({ bundleRoot: root, manifest, exists: existsIn(paths) });
    expect(missing).toContain("targets.json");
    expect(missing).toContain(join("dist", "index.js"));
  });

  it("checks only the requested subset for matrix jobs", () => {
    const paths = [...allStatic, artifactFor("linux-x64")];
    expect(
      missingReleaseBundleFiles({
        bundleRoot: root,
        manifest,
        exists: existsIn(paths),
        targets: ["linux-x64"],
      }),
    ).toEqual([]);
    expect(
      missingReleaseBundleFiles({
        bundleRoot: root,
        manifest,
        exists: existsIn(paths),
        targets: ["win32-x64"],
      }),
    ).toEqual([prebuiltArtifactRelativePath(manifest, "win32-x64")]);
  });

  it("throws on a requested target outside the manifest", () => {
    expect(() =>
      missingReleaseBundleFiles({
        bundleRoot: root,
        manifest,
        exists: existsIn(allStatic),
        targets: ["freebsd-x64"],
      }),
    ).toThrow(/freebsd-x64/);
  });

  it("static file list covers the runtime module graph and metadata", () => {
    for (const required of ["package.json", "README.md", "targets.json", "dist/index.js", "dist/loader.js"]) {
      expect(RELEASE_BUNDLE_STATIC_FILES).toContain(required);
    }
  });
});
