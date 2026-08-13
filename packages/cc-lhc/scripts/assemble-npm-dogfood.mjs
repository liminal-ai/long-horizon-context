#!/usr/bin/env node
// Assemble a runtime-only npm package from built workspace artifacts and
// runner-produced cc-lhc-native prebuilds. This dogfood package is deliberately
// install-script-free: npm installs JavaScript dependencies from the registry,
// while the unpublished workspace packages are bundled into the tarball.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = resolve(packageRoot, "..", "..");

function fail(message) {
  console.error(`cc-lhc npm dogfood: ${message}`);
  process.exit(1);
}

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined) fail(`missing value for ${flag}`);
  return resolve(value);
}

const artifactsRoot = argValue("--artifacts");
const outputRoot = argValue("--out");
if (artifactsRoot === undefined || outputRoot === undefined) {
  fail("required: --artifacts <downloaded-actions-artifacts> --out <package-directory>");
}

const requiredTargets = ["win32-arm64", "win32-x64"];
const nativeArtifact = "cc_lhc_identity.node";
const workspacePackages = {
  lhc: join(repoRoot, "packages", "lhc"),
  "cc-lhc-native": join(repoRoot, "packages", "cc-lhc-native"),
};

for (const path of [
  join(packageRoot, "dist", "bin.js"),
  join(workspacePackages.lhc, "dist", "index.js"),
  join(workspacePackages["cc-lhc-native"], "dist", "index.js"),
]) {
  if (!existsSync(path)) fail(`missing built artifact ${path}`);
}

rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true });
cpSync(join(packageRoot, "dist"), join(outputRoot, "dist"), { recursive: true });
cpSync(join(packageRoot, "README.md"), join(outputRoot, "README.md"));

const bundledRoot = join(outputRoot, "node_modules");
for (const [name, sourceRoot] of Object.entries(workspacePackages)) {
  const destination = join(bundledRoot, name);
  mkdirSync(destination, { recursive: true });
  cpSync(join(sourceRoot, "dist"), join(destination, "dist"), { recursive: true });
  cpSync(join(sourceRoot, "README.md"), join(destination, "README.md"));

  const sourceManifest = JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8"));
  const runtimeManifest = {
    name,
    version: "0.0.0-windows-dogfood",
    description: sourceManifest.description,
    type: sourceManifest.type,
    main: sourceManifest.main,
    types: sourceManifest.types,
    exports: sourceManifest.exports,
    engines: sourceManifest.engines,
    ...(name === "lhc" ? { dependencies: sourceManifest.dependencies } : {}),
  };
  writeFileSync(join(destination, "package.json"), JSON.stringify(runtimeManifest, null, 2) + "\n");
}

const nativeDestination = join(bundledRoot, "cc-lhc-native");
cpSync(
  join(workspacePackages["cc-lhc-native"], "targets.json"),
  join(nativeDestination, "targets.json"),
);
for (const target of requiredTargets) {
  const source = join(artifactsRoot, `prebuild-${target}`, nativeArtifact);
  if (!existsSync(source)) fail(`missing tested Actions artifact ${source}`);
  const destination = join(nativeDestination, "prebuilds", target, nativeArtifact);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination);
}

const manifest = {
  name: "@liminal-ai/cc-lhc",
  version: "0.0.0-windows-dogfood",
  description: "Windows dogfood package for the Claude Code Long Horizon Context wrapper.",
  type: "module",
  bin: { "cc-lhc": "./dist/bin.js" },
  engines: { node: ">=24.17.0" },
  dependencies: {
    "@lydell/node-pty": "1.2.0-beta.12",
    "cc-lhc-native": "0.0.0-windows-dogfood",
    effect: "^3.21.2",
    "js-tiktoken": "^1.0.21",
    lhc: "0.0.0-windows-dogfood",
  },
  bundledDependencies: ["lhc", "cc-lhc-native"],
  files: ["dist", "README.md"],
};
writeFileSync(join(outputRoot, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`cc-lhc npm dogfood: assembled ${outputRoot}`);
