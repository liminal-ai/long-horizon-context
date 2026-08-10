// Validate a release-bundle directory against the contract in
// src/release-bundle.ts (single source of truth, imported from dist).
//
// Usage:
//   node scripts/check-release-bundle.mjs [--dir <bundleRoot>] [--target <platform-arch>]...
//
// Without --target, every target in the bundle's targets.json must have its
// prebuilt artifact (full-bundle/aggregation check). Matrix jobs pass their
// own --target to validate a partial bundle.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const args = process.argv.slice(2);
let bundleRoot = packageRoot;
const targets = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--dir" && args[i + 1] !== undefined) {
    bundleRoot = resolve(args[i + 1]);
    i += 1;
  } else if (args[i] === "--target" && args[i + 1] !== undefined) {
    targets.push(args[i + 1]);
    i += 1;
  } else {
    console.error(`cc-lhc-native: unknown argument ${args[i]}`);
    process.exit(2);
  }
}

const distEntry = join(packageRoot, "dist", "release-bundle.js");
const distTargets = join(packageRoot, "dist", "targets.js");
if (!existsSync(distEntry) || !existsSync(distTargets)) {
  console.error("cc-lhc-native: dist/ is not built; run the build script first");
  process.exit(2);
}

const { missingReleaseBundleFiles } = await import(pathToFileURL(distEntry).href);
const { loadTargetsManifest, TARGETS_MANIFEST_FILENAME } = await import(pathToFileURL(distTargets).href);

const manifestPath = join(bundleRoot, TARGETS_MANIFEST_FILENAME);
if (!existsSync(manifestPath)) {
  console.error(`cc-lhc-native: bundle has no ${TARGETS_MANIFEST_FILENAME} at ${bundleRoot}`);
  process.exit(1);
}
const manifest = loadTargetsManifest(manifestPath);

const missing = missingReleaseBundleFiles({
  bundleRoot,
  manifest,
  exists: existsSync,
  ...(targets.length > 0 ? { targets } : {}),
});

if (missing.length > 0) {
  console.error(`cc-lhc-native: release bundle at ${bundleRoot} is incomplete; missing:`);
  for (const relative of missing) {
    console.error(`  - ${relative}`);
  }
  process.exit(1);
}
const scope = targets.length > 0 ? `targets ${targets.join(", ")}` : "all manifest targets";
console.log(`cc-lhc-native: release bundle at ${bundleRoot} complete for ${scope}`);
