#!/usr/bin/env node

/** Validate an assembled cc-lhc npm candidate before npm pack/install. */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "build/cc-lhc-npm");
function fail(message) {
  console.error(`cc-lhc npm check: ${message}`);
  process.exitCode = 1;
}
function required(path) {
  if (!existsSync(join(root, path))) fail(`missing ${path}`);
}

required("package.json");
if (process.exitCode) process.exit();
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (manifest.private !== true) fail("candidate must remain private until Lee approves publication");
if (manifest.license !== "UNLICENSED") fail("candidate must remain UNLICENSED until license approval");
if (manifest.bin?.["cc-lhc"] !== "./dist/bin.js") fail("manifest must expose one cc-lhc executable");
for (const name of ["lhc", "cc-lhc-native"]) {
  if (!manifest.bundledDependencies?.includes(name)) fail(`${name} is not a bundled dependency`);
  required(`node_modules/${name}/package.json`);
}
required("dist/bin.js");
const targets = manifest.ccLhcCandidate?.targets;
if (!Array.isArray(targets) || targets.length === 0) fail("candidate target list is empty");
for (const target of targets ?? []) {
  const relative = `node_modules/cc-lhc-native/prebuilds/${target}/${manifest.ccLhcCandidate.nativeArtifact}`;
  required(relative);
  const path = join(root, relative);
  if (existsSync(path) && statSync(path).size === 0) fail(`${relative} is empty`);
}
if (!process.exitCode) {
  console.log(`cc-lhc npm check: candidate valid (${targets.length} target${targets.length === 1 ? "" : "s"})`);
}
