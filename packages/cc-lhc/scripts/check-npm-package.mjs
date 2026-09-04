#!/usr/bin/env node

/**
 * Validate an assembled cc-lhc npm package before npm pack/install.
 *
 *   node scripts/check-npm-package.mjs [ROOT] [--source-sha SHA]
 *
 * The build identity is bound to the caller's accepted source SHA: a stamped
 * SHA passes only when it equals `--source-sha`; without an accepted SHA only
 * an unavailable (null) identity passes.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { sourceShaFromArgv, verifyBuildIdentity } from "./lib/build-identity.mjs";

const argv = process.argv.slice(2);
const positional = argv.filter((arg, index) => !arg.startsWith("--") && argv[index - 1] !== "--source-sha");
const root = resolve(positional[0] ?? "build/cc-lhc-npm");
function fail(message) {
  console.error(`cc-lhc npm check: ${message}`);
  process.exitCode = 1;
}
let acceptedSourceSha;
try {
  acceptedSourceSha = sourceShaFromArgv(argv);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
  process.exit();
}
function required(path) {
  if (!existsSync(join(root, path))) fail(`missing ${path}`);
}

required("package.json");
if (process.exitCode) process.exit();
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (manifest.name !== "cc-lhc") fail("manifest name must be cc-lhc");
if (manifest.version !== "0.4.0") fail("manifest version must be 0.4.0");
if (manifest.private === true) fail("release package must not be private");
if (manifest.license !== "MIT") fail("release package must use MIT");
if (manifest.publishConfig?.access !== "public") fail("release package must declare public access");
if (manifest.bin?.["cc-lhc"] !== "./dist/bin.js") fail("manifest must expose one cc-lhc executable");
for (const name of ["lhc", "cc-lhc-native"]) {
  if (!manifest.bundledDependencies?.includes(name)) fail(`${name} is not a bundled dependency`);
  required(`node_modules/${name}/package.json`);
}
required("dist/bin.js");
required("dist/build-identity.json");
if (existsSync(join(root, "dist/build-identity.json"))) {
  const identity = JSON.parse(readFileSync(join(root, "dist/build-identity.json"), "utf8"));
  for (const message of verifyBuildIdentity(identity, manifest, acceptedSourceSha)) fail(message);
}
required("LICENSE");
if (existsSync(join(root, "LICENSE"))) {
  const license = readFileSync(join(root, "LICENSE"), "utf8");
  if (!license.includes("MIT License") || !license.includes("Copyright (c) 2026 Lee Moore")) {
    fail("LICENSE does not contain the approved MIT grant and copyright holder");
  }
}
const targets = manifest.ccLhcPackage?.targets;
if (!Array.isArray(targets) || targets.length === 0) fail("package target list is empty");
for (const target of targets ?? []) {
  const relative = `node_modules/cc-lhc-native/prebuilds/${target}/${manifest.ccLhcPackage.nativeArtifact}`;
  required(relative);
  const path = join(root, relative);
  if (existsSync(path) && statSync(path).size === 0) fail(`${relative} is empty`);
}
if (!process.exitCode) {
  console.log(`cc-lhc npm check: package valid (${targets.length} target${targets.length === 1 ? "" : "s"})`);
}
