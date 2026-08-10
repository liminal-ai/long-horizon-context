/**
 * Release-bundle contract.
 *
 * cc-lhc-native is a private workspace package: it is consumed inside this
 * repo and shipped to end users through the GitHub release/setup flow, not
 * published to npm. A release bundle is a directory assembled by CI that must
 * contain, relative to its root:
 *
 *   - package.json, README.md, targets.json
 *   - dist/ runtime + type files (RELEASE_BUNDLE_STATIC_FILES)
 *   - prebuilds/<platform>-<arch>/<artifact> for every required target
 *
 * Matrix jobs validate their own target with a subset; the aggregation step
 * validates all manifest targets. End users receiving a bundle never compile:
 * the loader serves prebuilds/, and the package install script is a no-op.
 */

import { join } from "node:path";

import { type TargetsManifest, targetKey } from "./targets.js";

export const RELEASE_BUNDLE_STATIC_FILES: readonly string[] = [
  "package.json",
  "README.md",
  "targets.json",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/identity.js",
  "dist/identity.d.ts",
  "dist/loader.js",
  "dist/loader.d.ts",
  "dist/targets.js",
  "dist/targets.d.ts",
  "dist/release-bundle.js",
  "dist/release-bundle.d.ts",
];

export interface ReleaseBundleCheckOptions {
  bundleRoot: string;
  manifest: TargetsManifest;
  exists: (path: string) => boolean;
  /**
   * Target keys (`<platform>-<arch>`) whose prebuilt artifacts are required.
   * Defaults to every manifest target (full-bundle check). A key not present
   * in the manifest is a caller error and throws.
   */
  targets?: string[];
}

export function prebuiltArtifactRelativePath(manifest: TargetsManifest, key: string): string {
  return join("prebuilds", key, manifest.artifact);
}

/** Relative paths required but absent; empty means the bundle is complete. */
export function missingReleaseBundleFiles(options: ReleaseBundleCheckOptions): string[] {
  const { bundleRoot, manifest, exists } = options;
  const manifestKeys = manifest.targets.map(targetKey);
  const required = options.targets ?? manifestKeys;
  for (const key of required) {
    if (!manifestKeys.includes(key)) {
      throw new Error(`release bundle check: ${key} is not a target in targets.json`);
    }
  }
  const missing: string[] = [];
  for (const relative of RELEASE_BUNDLE_STATIC_FILES) {
    if (!exists(join(bundleRoot, relative))) {
      missing.push(relative);
    }
  }
  for (const key of required) {
    const relative = prebuiltArtifactRelativePath(manifest, key);
    if (!exists(join(bundleRoot, relative))) {
      missing.push(relative);
    }
  }
  return missing;
}
