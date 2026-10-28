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
  targets?: string[];
}

export function prebuiltArtifactRelativePath(manifest: TargetsManifest, key: string): string {
  return join("prebuilds", key, manifest.artifact);
}

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
