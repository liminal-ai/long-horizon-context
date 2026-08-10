// Aggregation step: merge per-target CI prebuild artifacts into one release
// bundle plus flat release-candidate assets with SHA-256 checksums.
//
// Usage:
//   node scripts/assemble-release-bundle.mjs \
//     --artifacts <dir>    downloaded artifacts: one prebuild-<target>/ dir per target
//     --bundle-out <dir>   assembled release bundle (validate with check-release-bundle.mjs)
//     --assets-out <dir>   flat assets: <artifactBase>-<target>.node x N + SHA256SUMS
//     [--package-root <dir>]  source of package.json/README.md/targets.json/dist (default: this package)
//
// The artifacts directory must contain exactly one `prebuild-<target>`
// directory per targets.json target, each holding exactly one non-empty file
// named after the manifest artifact. Anything missing, duplicated, unknown,
// or extra is a hard failure — a release candidate is all six proven targets
// or nothing. This script does not create tags or releases.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assetNameForTarget,
  CHECKSUMS_ASSET_NAME,
  checksumLine,
  readTargetsManifestLite,
  sha256Hex,
} from "./asset-names.mjs";

const scriptPackageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function fail(message) {
  console.error(`cc-lhc-native: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const options = { packageRoot: scriptPackageRoot };
for (let i = 0; i < args.length; i += 1) {
  const flag = args[i];
  const value = args[i + 1];
  if (value === undefined) fail(`missing value for ${flag}`);
  if (flag === "--artifacts") options.artifacts = resolve(value);
  else if (flag === "--bundle-out") options.bundleOut = resolve(value);
  else if (flag === "--assets-out") options.assetsOut = resolve(value);
  else if (flag === "--package-root") options.packageRoot = resolve(value);
  else fail(`unknown argument ${flag}`);
  i += 1;
}
if (!options.artifacts || !options.bundleOut || !options.assetsOut) {
  fail("required: --artifacts <dir> --bundle-out <dir> --assets-out <dir>");
}

const manifestPath = join(options.packageRoot, "targets.json");
if (!existsSync(manifestPath)) fail(`no targets.json at ${options.packageRoot}`);
const manifest = readTargetsManifestLite(manifestPath);

// --- validate the downloaded artifact set -------------------------------
if (!existsSync(options.artifacts)) fail(`artifacts directory does not exist: ${options.artifacts}`);
const expectedDirs = new Map(manifest.targetKeys.map((key) => [`prebuild-${key}`, key]));
const entries = readdirSync(options.artifacts, { withFileTypes: true });
const problems = [];
const found = new Map();

for (const entry of entries) {
  if (!expectedDirs.has(entry.name)) {
    problems.push(`unexpected entry ${entry.name} (expected only: ${[...expectedDirs.keys()].join(", ")})`);
    continue;
  }
  if (!entry.isDirectory()) {
    problems.push(`${entry.name} is not a directory`);
    continue;
  }
  const key = expectedDirs.get(entry.name);
  if (found.has(key)) {
    problems.push(`duplicate artifact for target ${key}`);
    continue;
  }
  const dir = join(options.artifacts, entry.name);
  const files = readdirSync(dir);
  if (files.length !== 1 || files[0] !== manifest.artifact) {
    problems.push(
      `${entry.name} must contain exactly one file named ${manifest.artifact}, found: ${files.join(", ") || "(empty)"}`,
    );
    continue;
  }
  const artifactPath = join(dir, manifest.artifact);
  if (!statSync(artifactPath).isFile() || statSync(artifactPath).size === 0) {
    problems.push(`${entry.name}/${manifest.artifact} is empty or not a regular file`);
    continue;
  }
  found.set(key, artifactPath);
}
for (const key of manifest.targetKeys) {
  if (!found.has(key))
    problems.push(`missing artifact for target ${key} (expected prebuild-${key}/${manifest.artifact})`);
}
if (problems.length > 0) {
  console.error(`cc-lhc-native: artifact set at ${options.artifacts} rejected:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

// --- assemble the bundle -------------------------------------------------
const staticEntries = ["package.json", "README.md", "targets.json"];
for (const name of staticEntries) {
  if (!existsSync(join(options.packageRoot, name))) fail(`package root is missing ${name}`);
}
const distDir = join(options.packageRoot, "dist");
if (!existsSync(distDir) || readdirSync(distDir).length === 0) {
  fail(`package root has no built dist/ at ${distDir}; run the build script first`);
}

rmSync(options.bundleOut, { recursive: true, force: true });
mkdirSync(options.bundleOut, { recursive: true });
for (const name of staticEntries) {
  cpSync(join(options.packageRoot, name), join(options.bundleOut, name));
}
cpSync(distDir, join(options.bundleOut, "dist"), { recursive: true });
for (const [key, artifactPath] of found) {
  const destDir = join(options.bundleOut, "prebuilds", key);
  mkdirSync(destDir, { recursive: true });
  cpSync(artifactPath, join(destDir, manifest.artifact));
}

// --- flat release-candidate assets + SHA256SUMS --------------------------
rmSync(options.assetsOut, { recursive: true, force: true });
mkdirSync(options.assetsOut, { recursive: true });
const lines = [];
for (const key of manifest.targetKeys) {
  const assetName = assetNameForTarget(manifest.artifact, key);
  const bytes = readFileSync(found.get(key));
  writeFileSync(join(options.assetsOut, assetName), bytes);
  lines.push(checksumLine(sha256Hex(bytes), assetName));
}
writeFileSync(join(options.assetsOut, CHECKSUMS_ASSET_NAME), lines.join("\n") + "\n");

console.log(`cc-lhc-native: assembled release bundle at ${options.bundleOut} (${found.size} targets)`);
console.log(`cc-lhc-native: wrote ${found.size} assets + ${CHECKSUMS_ASSET_NAME} at ${options.assetsOut}`);
