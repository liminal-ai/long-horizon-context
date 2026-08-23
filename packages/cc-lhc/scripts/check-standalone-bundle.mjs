#!/usr/bin/env node

/** Validate and execute one unpacked cc-lhc standalone bundle. */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

function fail(message, result) {
  console.error(`cc-lhc standalone check: ${message}`);
  if (result?.stdout) process.stderr.write(result.stdout);
  if (result?.stderr) process.stderr.write(result.stderr);
  process.exit(1);
}

const root = resolve(process.argv[2] ?? "");
if (!root || !existsSync(join(root, "release-manifest.json"))) fail(`bundle is missing: ${root}`);
const manifest = JSON.parse(readFileSync(join(root, "release-manifest.json"), "utf8"));
const expectedTarget = `${process.platform}-${process.arch}`;
if (manifest.schemaVersion !== 1 || manifest.product !== "cc-lhc" || manifest.version !== "0.3.0") {
  fail("release manifest has an unexpected identity");
}
if (manifest.target !== expectedTarget) fail(`bundle target ${manifest.target} does not match ${expectedTarget}`);
if (!Array.isArray(manifest.runtimePackages) || manifest.runtimePackages.length === 0) {
  fail("release manifest does not record runtime package versions");
}

for (const relative of [
  manifest.entrypoint,
  manifest.nativeIdentityArtifact,
  `package/node_modules/${manifest.ptyPackage}/package.json`,
]) {
  const path = join(root, relative);
  if (!existsSync(path) || statSync(path).size === 0) fail(`bundle is missing ${relative}`);
}

const ptyVersion = manifest.runtimePackages.find(({ name }) => name === "@lydell/node-pty")?.version;
const targetPtyVersion = manifest.runtimePackages.find(({ name }) => name === manifest.ptyPackage)?.version;
if (ptyVersion !== "1.2.0-beta.12" || targetPtyVersion !== ptyVersion) {
  fail(`bundle PTY versions are not certified: ${ptyVersion ?? "missing"} / ${targetPtyVersion ?? "missing"}`);
}

const nativeTargetsRoot = join(root, "package", "node_modules", "cc-lhc-native", "prebuilds");
const nativeTargets = readdirSync(nativeTargetsRoot).sort();
if (JSON.stringify(nativeTargets) !== JSON.stringify([expectedTarget])) {
  fail(`bundle contains unexpected native targets: ${nativeTargets.join(", ")}`);
}

const result = spawnSync(process.execPath, [join(root, manifest.entrypoint), "--lhc-help"], {
  encoding: "utf8",
  env: { ...process.env, CC_LHC_NATIVE_REQUIRE_ADDON: "1" },
});
if (result.error || result.status !== 0) fail("bundled CLI failed", result);
if (!result.stdout.includes("get-turns") || !result.stdout.includes("get-messages")) {
  fail("bundled CLI help is missing retrieval commands", result);
}
if (result.stderr.includes("ExperimentalWarning: SQLite is an experimental feature")) {
  fail("bundled CLI leaked the known Node 24.3 node:sqlite warning", result);
}

console.log(`cc-lhc standalone check: ${manifest.version} ${manifest.target} passed`);
console.log("cc-lhc standalone check: native identity and retrieval CLI loaded");
