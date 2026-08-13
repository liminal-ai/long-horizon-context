#!/usr/bin/env node

/** Pack and globally install an unpublished candidate in disposable prefixes. */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const candidateRoot = resolve(process.argv[2] ?? join(packageRoot, "..", "..", "build", "cc-lhc-npm"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function fail(message, result) {
  console.error(`cc-lhc npm smoke: ${message}`);
  if (result?.stdout) process.stderr.write(result.stdout);
  if (result?.stderr) process.stderr.write(result.stderr);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error || result.status !== 0) {
    fail(`${basename(command)} ${args.join(" ")} failed`, result);
  }
  return result;
}

const manifest = JSON.parse(readFileSync(join(candidateRoot, "package.json"), "utf8"));
if (manifest.private !== true || manifest.ccLhcCandidate?.publishLocked !== true) {
  fail("refusing to smoke an unlocked publication candidate");
}

const scratch = mkdtempSync(join(tmpdir(), "cc-lhc-npm-smoke-"));
try {
  const packDir = join(scratch, "pack");
  mkdirSync(packDir);
  const pack = run(npm, ["pack", candidateRoot, "--pack-destination", packDir, "--json"]);
  const packed = JSON.parse(pack.stdout);
  if (!Array.isArray(packed) || packed.length !== 1 || typeof packed[0]?.filename !== "string") {
    fail("npm pack returned an unexpected result");
  }
  const tarball = join(packDir, packed[0].filename);

  for (const ignoreScripts of [false, true]) {
    const label = ignoreScripts ? "scripts-disabled" : "normal";
    const prefix = join(scratch, label);
    const installArgs = ["install", "--global", "--prefix", prefix, tarball];
    if (ignoreScripts) installArgs.push("--ignore-scripts");
    const install = run(npm, installArgs);
    if (/node-gyp|\b(?:g\+\+|clang|msbuild)\b|visual studio build tools/i.test(install.stdout + install.stderr)) {
      fail(`${label} install invoked a native compiler`, install);
    }

    const executable = process.platform === "win32" ? join(prefix, "cc-lhc.cmd") : join(prefix, "bin", "cc-lhc");
    const help = run(executable, ["--lhc-help"]);
    if (!help.stdout.includes("get-turns") || !help.stdout.includes("get-messages")) {
      fail(`${label} install did not expose the retrieval commands`, help);
    }

    const npmRoot = run(npm, ["root", "--global", "--prefix", prefix]).stdout.trim();
    const installedRoot = join(npmRoot, ...manifest.name.split("/"));
    const nativeEntry = join(installedRoot, "node_modules", "cc-lhc-native", "dist", "index.js");
    const nativeProbe = [
      `import { readExactProcessIdentity } from ${JSON.stringify(pathToFileURL(nativeEntry).href)};`,
      "const result = readExactProcessIdentity(process.pid);",
      "if (!result.ok) { console.error(JSON.stringify(result)); process.exit(1); }",
    ].join("\n");
    run(process.execPath, ["--input-type=module", "--eval", nativeProbe]);
  }

  console.log(`cc-lhc npm smoke: ${manifest.name}@${manifest.version} installs without a compiler`);
  console.log("cc-lhc npm smoke: wrapper help, retrieval commands, and native identity load passed");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
