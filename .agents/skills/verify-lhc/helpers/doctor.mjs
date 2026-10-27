#!/usr/bin/env node
// Read-only worth-driving check: node version, built dist, CLI help, SDK import.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { LHC_BIN, LHC_DIST, fail, loadSdk } from "./lib.mjs";

const major = Number(process.versions.node.split(".")[0]);
if (major < 24) fail(`node >=24 required, got ${process.versions.node}`);
console.log(`node ${process.version} ok`);

if (!existsSync(LHC_DIST)) fail(`missing ${LHC_DIST}; run pnpm install --filter lhc && pnpm --filter lhc run build`);
console.log("lhc dist present");

const help = execFileSync("node", [LHC_BIN], { encoding: "utf8" });
if (!help.includes("usage: lhc thread")) fail(`unexpected CLI help: ${help.slice(0, 200)}`);
console.log("lhc CLI help ok");

const mod = await loadSdk();
for (const name of ["initLhc", "createDeterministicInferenceCallbacks"]) {
  if (typeof mod[name] !== "function") fail(`SDK export ${name} missing`);
}
console.log("verify-lhc doctor: PASS");
