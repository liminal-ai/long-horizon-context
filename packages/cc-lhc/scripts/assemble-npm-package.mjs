#!/usr/bin/env node

/**
 * Assemble the globally-installable cc-lhc npm package.
 *
 * The user installs one package and gets one `cc-lhc` executable. The two
 * private workspace runtimes are bundled under node_modules so the tarball
 * never depends on unpublished workspace package names. Third-party JS and
 * PTY packages remain ordinary registry dependencies.
 *
 * This script never publishes. It only creates the exact package directory
 * that later inspection, smoke tests, and a separately authorized publish use.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sourceShaFromArgv, writeBuildIdentity } from "./lib/build-identity.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = resolve(packageRoot, "..", "..");
const lhcRoot = join(repoRoot, "packages", "lhc");
const nativeRoot = join(repoRoot, "packages", "cc-lhc-native");

function fail(message) {
  console.error(`cc-lhc npm assembly: ${message}`);
  process.exit(1);
}

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) fail(`${flag} requires a value`);
  return value;
}

const VALUE_FLAGS = ["--out", "--name", "--version", "--targets", "--native-bundle", "--source-sha"];
const unknown = process.argv.slice(2).filter((arg, index, args) => {
  if (index > 0 && VALUE_FLAGS.includes(args[index - 1])) {
    return false;
  }
  return !VALUE_FLAGS.includes(arg);
});
if (unknown.length > 0) fail(`unknown arguments: ${unknown.join(", ")}`);

const outputRoot = resolve(argValue("--out") ?? join(repoRoot, "build", "cc-lhc-npm"));
const packageName = argValue("--name") ?? "cc-lhc";
const version = argValue("--version") ?? "0.3.0";
const targetMode = argValue("--targets") ?? "all";
const nativeBundleRoot = resolve(argValue("--native-bundle") ?? nativeRoot);
// The candidate's accepted source identity, supplied explicitly; absent means
// the assembled build truthfully carries identity unavailable.
let sourceSha = null;
try {
  sourceSha = sourceShaFromArgv(process.argv.slice(2)) ?? null;
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(packageName)) {
  fail(`invalid npm package name ${JSON.stringify(packageName)}`);
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  fail(`invalid candidate version ${JSON.stringify(version)}`);
}
if (targetMode !== "all" && targetMode !== "current") {
  fail(`--targets must be all or current, got ${JSON.stringify(targetMode)}`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function requirePath(path, label) {
  if (!existsSync(path)) fail(`missing ${label}: ${relative(repoRoot, path)}`);
}

function copyDirectory(source, destination, label) {
  requirePath(source, label);
  cpSync(source, destination, { recursive: true });
}

const ccManifest = readJson(join(packageRoot, "package.json"));
const lhcManifest = readJson(join(lhcRoot, "package.json"));
const nativeManifest = readJson(join(nativeRoot, "package.json"));
const targetsManifest = readJson(join(nativeRoot, "targets.json"));
const allTargetKeys = targetsManifest.targets.map(({ platform, arch }) => `${platform}-${arch}`);
const currentTarget = `${process.platform}-${process.arch}`;
const requiredTargets = targetMode === "all" ? allTargetKeys : [currentTarget];
for (const target of requiredTargets) {
  if (!allTargetKeys.includes(target)) fail(`current target ${target} is unsupported`);
  const artifact = join(nativeBundleRoot, "prebuilds", target, targetsManifest.artifact);
  requirePath(artifact, `native prebuild for ${target}`);
  if (statSync(artifact).size === 0) fail(`native prebuild for ${target} is empty`);
}

for (const [root, name] of [
  [packageRoot, "cc-lhc"],
  [lhcRoot, "lhc"],
  [nativeRoot, "cc-lhc-native"],
]) {
  requirePath(join(root, "dist"), `${name} dist`);
  if (readdirSync(join(root, "dist")).length === 0) fail(`${name} dist is empty`);
}

rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(join(outputRoot, "node_modules", "lhc"), { recursive: true });
mkdirSync(join(outputRoot, "node_modules", "cc-lhc-native"), { recursive: true });

copyDirectory(join(packageRoot, "dist"), join(outputRoot, "dist"), "cc-lhc dist");
// Re-stamp the assembled dist from explicit inputs only: the candidate name and
// version this assembly was asked for, and the accepted source SHA if given.
writeBuildIdentity(join(outputRoot, "dist"), { name: packageName, version, sourceSha });
cpSync(join(packageRoot, "README.md"), join(outputRoot, "README.md"));
cpSync(join(packageRoot, "LICENSE"), join(outputRoot, "LICENSE"));

const bundledLhcRoot = join(outputRoot, "node_modules", "lhc");
copyDirectory(join(lhcRoot, "dist"), join(bundledLhcRoot, "dist"), "lhc dist");
if (existsSync(join(lhcRoot, "README.md"))) cpSync(join(lhcRoot, "README.md"), join(bundledLhcRoot, "README.md"));
writeFileSync(
  join(bundledLhcRoot, "package.json"),
  `${JSON.stringify(
    {
      name: "lhc",
      version,
      private: true,
      type: "module",
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      exports: lhcManifest.exports,
      engines: ccManifest.engines,
    },
    null,
    2,
  )}\n`,
);

const bundledNativeRoot = join(outputRoot, "node_modules", "cc-lhc-native");
copyDirectory(join(nativeRoot, "dist"), join(bundledNativeRoot, "dist"), "cc-lhc-native dist");
cpSync(join(nativeRoot, "targets.json"), join(bundledNativeRoot, "targets.json"));
if (existsSync(join(nativeRoot, "README.md")))
  cpSync(join(nativeRoot, "README.md"), join(bundledNativeRoot, "README.md"));
for (const target of requiredTargets) {
  const destination = join(bundledNativeRoot, "prebuilds", target);
  mkdirSync(destination, { recursive: true });
  cpSync(
    join(nativeBundleRoot, "prebuilds", target, targetsManifest.artifact),
    join(destination, targetsManifest.artifact),
  );
}
writeFileSync(
  join(bundledNativeRoot, "package.json"),
  `${JSON.stringify(
    {
      name: "cc-lhc-native",
      version,
      private: true,
      type: "module",
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      exports: nativeManifest.exports,
      engines: ccManifest.engines,
    },
    null,
    2,
  )}\n`,
);

const manifest = {
  name: packageName,
  version,
  description: "Independent Long Horizon Context wrapper compatible with Claude Code.",
  license: "MIT",
  author: { name: "Lee Moore" },
  type: "module",
  bin: { "cc-lhc": "./dist/bin.js" },
  files: ["dist", "README.md", "LICENSE"],
  bundledDependencies: ["lhc", "cc-lhc-native"],
  dependencies: {
    "@lydell/node-pty": ccManifest.dependencies["@lydell/node-pty"],
    effect: lhcManifest.dependencies.effect,
    "js-tiktoken": lhcManifest.dependencies["js-tiktoken"],
    lhc: version,
    "cc-lhc-native": version,
  },
  engines: ccManifest.engines,
  repository: {
    type: "git",
    url: "git+https://github.com/liminal-ai/long-horizon-context.git",
    directory: "packages/cc-lhc",
  },
  homepage: "https://github.com/liminal-ai/long-horizon-context/tree/main/packages/cc-lhc",
  bugs: { url: "https://github.com/liminal-ai/long-horizon-context/issues" },
  keywords: ["long-horizon-context", "context-management", "coding-agent", "cli"],
  publishConfig: { access: "public" },
  ccLhcPackage: {
    targets: requiredTargets,
    nativeArtifact: targetsManifest.artifact,
  },
};
writeFileSync(join(outputRoot, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`cc-lhc npm assembly: wrote package to ${outputRoot}`);
console.log(`cc-lhc npm assembly: targets ${requiredTargets.join(", ")}`);
