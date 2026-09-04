#!/usr/bin/env node
// Download the verified prebuilt cc-lhc-native addon for this machine — no
// compiler required. Order of proof: SHA-256 checksum against the release's
// SHA256SUMS first, then (current target only) a subprocess load+probe of the
// downloaded temp file, and only after both pass is the installed addon
// replaced — via a rename-only backup/restore transaction that preserves the
// previously installed addon on any failure. The parent process never loads
// any addon file itself, so on Windows no file involved is ever locked by
// this script.
//
// Usage:
//   node .setup/scripts/fetch-prebuild.mjs [--tag <release-tag>] [--base-url <url>]
//                                          [--target <platform-arch>]
//                                          [--prebuilds-dir <dir>]
//
// Source precedence: --base-url > CC_LHC_PREBUILD_BASE_URL > tag
// (--tag > CC_LHC_PREBUILD_TAG > .setup/prebuild-release.json "tag") mapped to
// the GitHub release download URL. --target defaults to this machine and only
// needs setting when provisioning artifacts for another machine (foreign
// targets get checksum verification only — their addon cannot load here).
// --prebuilds-dir overrides the install root (test seam; normal installs omit
// it). CC_LHC_PREBUILD_TEST_FAIL=install injects a replacement failure between
// the two transaction renames (test seam for the rollback path).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assetNameForTarget,
  CHECKSUMS_ASSET_NAME,
  parseChecksums,
  readTargetsManifestLite,
  verifyAssetChecksum,
} from "../../packages/cc-lhc-native/scripts/asset-names.mjs";
import { resolveReleaseSource, validateProbeReport } from "./lib/prebuild.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const nativeRoot = join(repoRoot, "packages", "cc-lhc-native");

function fail(message) {
  console.error(`fetch-prebuild: ${message}`);
  process.exit(1);
}

function argValue(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx === -1) return undefined;
  const val = argv[idx + 1];
  if (val === undefined) fail(`missing value for ${flag}`);
  return val;
}

const manifest = readTargetsManifestLite(join(nativeRoot, "targets.json"));
const targetKey = argValue(process.argv, "--target") ?? `${process.platform}-${process.arch}`;
if (!manifest.targetKeys.includes(targetKey)) {
  fail(`${targetKey} is not a supported cc-lhc target; supported: ${manifest.targetKeys.join(", ")}`);
}

let config = {};
try {
  config = JSON.parse(readFileSync(join(repoRoot, ".setup", "prebuild-release.json"), "utf8"));
} catch {
  // resolveReleaseSource reports the missing-config case with guidance.
}
const source = resolveReleaseSource({
  argvBaseUrl: argValue(process.argv, "--base-url"),
  argvTag: argValue(process.argv, "--tag"),
  env: process.env,
  config,
});
if (!source.ok) fail(source.error);

async function fetchAsset(name) {
  const url = `${source.baseUrl}/${name}`;
  let response;
  try {
    response = await fetch(url, { redirect: "follow" });
  } catch (cause) {
    fail(`download failed for ${url}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (!response.ok) fail(`download failed for ${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

const assetName = assetNameForTarget(manifest.artifact, targetKey);
console.log(`fetch-prebuild: source ${source.baseUrl} (via ${source.via})`);

const checksums = parseChecksums((await fetchAsset(CHECKSUMS_ASSET_NAME)).toString("utf8"));
const assetBytes = await fetchAsset(assetName);
const verdict = verifyAssetChecksum(checksums, assetName, assetBytes);
if (!verdict.ok) fail(verdict.reason);
console.log(`fetch-prebuild: ${assetName} checksum verified (sha256)`);

const prebuildsDir = argValue(process.argv, "--prebuilds-dir") ?? join(nativeRoot, "prebuilds");
const destDir = join(prebuildsDir, targetKey);
mkdirSync(destDir, { recursive: true });
const dest = join(destDir, manifest.artifact);
const tmp = `${dest}.download-${process.pid}`;
const backup = `${dest}.backup-${process.pid}`;
writeFileSync(tmp, assetBytes);

// Load + probe the downloaded TEMP file in a subprocess before touching the
// installed addon. A subprocess (not this process) does the dlopen so the
// temp file is never locked here — on Windows a loaded addon file can be
// neither deleted nor replaced by the process holding it.
if (targetKey === `${process.platform}-${process.arch}`) {
  const probeSource =
    'const m = { exports: {} };\n' +
    "try {\n" +
    "  process.dlopen(m, process.argv[1]);\n" +
    "} catch (cause) {\n" +
    '  console.error("dlopen failed: " + (cause instanceof Error ? cause.message : String(cause)));\n' +
    "  process.exit(1);\n" +
    "}\n" +
    "const addon = m.exports;\n" +
    "const probe = typeof addon.readProcessIdentity === \"function\" ? addon.readProcessIdentity(process.pid) : null;\n" +
    "const fileProbe = typeof addon.readFileIdentity === \"function\" ? addon.readFileIdentity(process.argv[1]) : null;\n" +
    "console.log(JSON.stringify({\n" +
    "  contract: addon.identityContractVersion ?? null,\n" +
    "  exports: Object.keys(addon).filter((k) => typeof addon[k] === \"function\"),\n" +
    "  platform: addon.platform ?? null,\n" +
    "  pid: process.pid,\n" +
    "  probe,\n" +
    "  fileProbe,\n" +
    "}));\n";
  const probeRun = spawnSync(process.execPath, ["-e", probeSource, tmp], {
    encoding: "utf8",
    timeout: 30_000,
  });
  const probeFail = (reason) => {
    rmSync(tmp, { force: true });
    fail(`downloaded addon rejected before install (installed addon untouched): ${reason}`);
  };
  if (probeRun.status !== 0) {
    probeFail(`probe subprocess exited ${probeRun.status}: ${(probeRun.stderr ?? "").trim()}`);
  }
  let report;
  try {
    report = JSON.parse(probeRun.stdout);
  } catch {
    probeFail(`probe subprocess produced no parseable report: ${JSON.stringify(probeRun.stdout)}`);
  }
  const probeVerdict = validateProbeReport(report, process.platform);
  if (!probeVerdict.ok) probeFail(probeVerdict.reason);
  console.log(
    `fetch-prebuild: addon verified live in subprocess (pid ${probeVerdict.probe.pid}, ` +
      `bootId ${probeVerdict.probe.bootId}, starttime ${probeVerdict.probe.starttime})`,
  );
} else {
  console.log(`fetch-prebuild: checksum-only for foreign target ${targetKey} (cannot load it on this machine)`);
}

// Replacement transaction: rename installed -> backup, rename temp -> dest.
// Renames only (Windows-correct: never overwrite in place); any failure
// restores the backup so the previously installed addon survives, and always
// cleans the temp file.
const hadExisting = existsSync(dest);
try {
  if (hadExisting) renameSync(dest, backup);
  if (process.env.CC_LHC_PREBUILD_TEST_FAIL === "install") {
    throw new Error("test-injected replacement failure (CC_LHC_PREBUILD_TEST_FAIL=install)");
  }
  renameSync(tmp, dest);
} catch (cause) {
  let restoreNote = "";
  if (hadExisting && existsSync(backup) && !existsSync(dest)) {
    try {
      renameSync(backup, dest);
      restoreNote = "; previously installed addon restored";
    } catch (restoreCause) {
      restoreNote = `; RESTORE FAILED, previous addon left at ${backup}: ${
        restoreCause instanceof Error ? restoreCause.message : String(restoreCause)
      }`;
    }
  }
  rmSync(tmp, { force: true });
  fail(`could not install ${dest}: ${cause instanceof Error ? cause.message : String(cause)}${restoreNote}`);
}
if (hadExisting) {
  try {
    rmSync(backup, { force: true });
  } catch (cause) {
    console.log(
      `fetch-prebuild: note — could not remove backup ${backup} (${
        cause instanceof Error ? cause.message : String(cause)
      }); safe to delete once no process is using it`,
    );
  }
}
console.log(`fetch-prebuild: installed ${dest}`);
