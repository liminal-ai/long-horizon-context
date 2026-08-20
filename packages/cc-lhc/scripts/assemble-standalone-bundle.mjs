#!/usr/bin/env node

/** Assemble one registry-free cc-lhc runtime bundle on its target platform. */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptRoot, "..", "..", "..");

function fail(message, result) {
  console.error(`cc-lhc standalone assembly: ${message}`);
  if (result?.stdout) process.stderr.write(result.stdout);
  if (result?.stderr) process.stderr.write(result.stderr);
  process.exit(1);
}

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) fail(`${flag} requires a value`);
  return value;
}

const valuedFlags = new Set(["--package-root", "--target", "--out", "--source-commit"]);
const unknown = process.argv.slice(2).filter((arg, index, args) => {
  if (index > 0 && valuedFlags.has(args[index - 1])) return false;
  return !valuedFlags.has(arg);
});
if (unknown.length > 0) fail(`unknown arguments: ${unknown.join(", ")}`);

const packageRoot = resolve(argValue("--package-root") ?? join(repoRoot, "build", "cc-lhc-npm"));
const target = argValue("--target") ?? `${process.platform}-${process.arch}`;
const outputRoot = resolve(argValue("--out") ?? join(repoRoot, "build", "cc-lhc-standalone"));
const sourceCommit = argValue("--source-commit") ?? "local";
const currentTarget = `${process.platform}-${process.arch}`;
if (target !== currentTarget) fail(`target ${target} must be assembled on ${currentTarget}`);
if (!existsSync(join(packageRoot, "package.json"))) fail(`package root is missing package.json: ${packageRoot}`);

const packageManifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
if (packageManifest.name !== "cc-lhc" || packageManifest.version !== "0.2.0") {
  fail("package root does not contain the approved cc-lhc@0.2.0 candidate");
}
if (JSON.stringify(packageManifest.ccLhcPackage?.targets) !== JSON.stringify([target])) {
  fail(`package candidate must contain only target ${target}`);
}

const npmCliCandidates = [
  process.env.npm_execpath,
  join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  join(dirname(dirname(process.execPath)), "lib", "node_modules", "npm", "bin", "npm-cli.js"),
].filter(Boolean);
const npmCli = npmCliCandidates.find(existsSync);
if (!npmCli) fail(`cannot locate npm CLI (checked ${npmCliCandidates.join(", ")})`);

const relativeOutput = relative(repoRoot, outputRoot);
if (
  !relativeOutput ||
  relativeOutput === "build" ||
  relativeOutput.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
  isAbsolute(relativeOutput) ||
  !relativeOutput.startsWith(`build${process.platform === "win32" ? "\\" : "/"}`)
) {
  fail(`output root must be a child of ${join(repoRoot, "build")}: ${outputRoot}`);
}
rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true });

const standaloneCandidate = join(outputRoot, ".candidate");
cpSync(packageRoot, standaloneCandidate, { recursive: true });
const standaloneManifestPath = join(standaloneCandidate, "package.json");
const standaloneManifest = JSON.parse(readFileSync(standaloneManifestPath, "utf8"));
for (const [name, path] of [
  ["@lydell/node-pty", join(repoRoot, "packages", "cc-lhc", "node_modules", "@lydell", "node-pty", "package.json")],
  ["effect", join(repoRoot, "packages", "lhc", "node_modules", "effect", "package.json")],
  ["js-tiktoken", join(repoRoot, "packages", "lhc", "node_modules", "js-tiktoken", "package.json")],
]) {
  if (!existsSync(path)) fail(`cannot pin ${name}; installed workspace manifest is missing: ${path}`);
  const installed = JSON.parse(readFileSync(path, "utf8"));
  standaloneManifest.dependencies[name] = installed.version;
}
writeFileSync(standaloneManifestPath, `${JSON.stringify(standaloneManifest, null, 2)}\n`);

const prefix = join(outputRoot, ".npm-prefix");
const packRoot = join(outputRoot, ".pack");
mkdirSync(packRoot, { recursive: true });
const pack = spawnSync(
  process.execPath,
  [npmCli, "pack", standaloneCandidate, "--pack-destination", packRoot, "--json"],
  {
    encoding: "utf8",
  },
);
if (pack.error || pack.status !== 0) fail("npm pack failed", pack);
let packed;
try {
  packed = JSON.parse(pack.stdout);
} catch {
  fail("npm pack returned invalid JSON", pack);
}
if (!Array.isArray(packed) || packed.length !== 1 || typeof packed[0]?.filename !== "string") {
  fail("npm pack returned an unexpected artifact list", pack);
}
const tarball = join(packRoot, packed[0].filename);
const install = spawnSync(
  process.execPath,
  [npmCli, "install", "--global", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", tarball],
  { encoding: "utf8" },
);
if (install.error || install.status !== 0) fail("npm staging install failed", install);
if (/node-gyp|\b(?:g\+\+|clang|msbuild)\b|visual studio build tools/i.test(install.stdout + install.stderr)) {
  fail("staging install invoked a native compiler", install);
}

const npmRootResult = spawnSync(process.execPath, [npmCli, "root", "--global", "--prefix", prefix], {
  encoding: "utf8",
});
if (npmRootResult.error || npmRootResult.status !== 0) fail("could not resolve staged npm root", npmRootResult);
const installedPackage = join(npmRootResult.stdout.trim(), "cc-lhc");
if (!existsSync(installedPackage)) fail(`staged package is missing: ${installedPackage}`);

const bundleName = `cc-lhc-v${packageManifest.version}-${target}`;
const bundleRoot = join(outputRoot, bundleName);
const runtimeRoot = join(bundleRoot, "package");
mkdirSync(bundleRoot, { recursive: true });
cpSync(installedPackage, runtimeRoot, { recursive: true });

const nativeArtifact = packageManifest.ccLhcPackage.nativeArtifact;
const nativePath = join(runtimeRoot, "node_modules", "cc-lhc-native", "prebuilds", target, nativeArtifact);
if (!existsSync(nativePath) || statSync(nativePath).size === 0)
  fail(`bundle is missing native identity addon for ${target}`);

const ptyPackage = `@lydell/node-pty-${target}`;
const ptyRoot = join(runtimeRoot, "node_modules", ...ptyPackage.split("/"));
if (!existsSync(join(ptyRoot, "package.json"))) fail(`bundle is missing PTY runtime ${ptyPackage}`);

const nativeTargetsRoot = join(runtimeRoot, "node_modules", "cc-lhc-native", "prebuilds");
const includedNativeTargets = readdirSync(nativeTargetsRoot).sort();
if (JSON.stringify(includedNativeTargets) !== JSON.stringify([target])) {
  fail(`bundle contains unexpected native targets: ${includedNativeTargets.join(", ")}`);
}

const runtimePackages = [];
const runtimeModulesRoot = join(runtimeRoot, "node_modules");
for (const entry of readdirSync(runtimeModulesRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const packageRoots = entry.name.startsWith("@")
    ? readdirSync(join(runtimeModulesRoot, entry.name), { withFileTypes: true })
        .filter((child) => child.isDirectory())
        .map((child) => join(runtimeModulesRoot, entry.name, child.name))
    : [join(runtimeModulesRoot, entry.name)];
  for (const packagePath of packageRoots) {
    const manifestPath = join(packagePath, "package.json");
    if (!existsSync(manifestPath)) continue;
    const installed = JSON.parse(readFileSync(manifestPath, "utf8"));
    runtimePackages.push({ name: installed.name, version: installed.version });
  }
}
runtimePackages.sort((left, right) => left.name.localeCompare(right.name));

const manifest = {
  schemaVersion: 1,
  product: "cc-lhc",
  version: packageManifest.version,
  target,
  sourceCommit,
  node: packageManifest.engines.node,
  entrypoint: "package/dist/bin.js",
  nativeIdentityArtifact: `package/node_modules/cc-lhc-native/prebuilds/${target}/${nativeArtifact}`,
  ptyPackage,
  runtimePackages,
};
writeFileSync(join(bundleRoot, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

rmSync(prefix, { recursive: true, force: true });
rmSync(packRoot, { recursive: true, force: true });
rmSync(standaloneCandidate, { recursive: true, force: true });
console.log(`cc-lhc standalone assembly: wrote ${bundleRoot}`);
console.log(`cc-lhc standalone assembly: target ${target}, PTY ${ptyPackage}`);
