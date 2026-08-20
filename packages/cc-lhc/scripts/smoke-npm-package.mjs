#!/usr/bin/env node

/** Pack and globally install the release package in disposable prefixes. */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const candidateRoot = resolve(process.argv[2] ?? join(packageRoot, "..", "..", "build", "cc-lhc-npm"));
const npmCliCandidates = [
  process.env.npm_execpath,
  join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  join(dirname(dirname(process.execPath)), "lib", "node_modules", "npm", "bin", "npm-cli.js"),
].filter(Boolean);
const npmCli = npmCliCandidates.find(existsSync);
if (!npmCli) {
  console.error(`cc-lhc npm smoke: cannot locate npm CLI (checked ${npmCliCandidates.join(", ")})`);
  process.exit(1);
}

function fail(message, result) {
  console.error(`cc-lhc npm smoke: ${message}`);
  if (result?.error) console.error(result.error);
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

function runNpm(args) {
  return run(process.execPath, [npmCli, ...args]);
}

function runInstalledCli(executable, args) {
  if (process.platform !== "win32") return run(executable, args);
  // A .cmd shim is not a Win32 executable. `call` lets cmd.exe parse the
  // quoted path without Node passing the quote characters through literally.
  const command = ["call", `"${executable.replaceAll('"', '""')}"`, ...args].join(" ");
  return run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command], {
    windowsVerbatimArguments: true,
  });
}

const manifest = JSON.parse(readFileSync(join(candidateRoot, "package.json"), "utf8"));
if (
  manifest.name !== "cc-lhc" ||
  manifest.version !== "0.2.0" ||
  manifest.private === true ||
  manifest.license !== "MIT" ||
  manifest.publishConfig?.access !== "public"
) {
  fail("refusing to smoke a package that does not match the approved release identity");
}

const scratch = mkdtempSync(join(tmpdir(), "cc-lhc-npm-smoke-"));
try {
  const packDir = join(scratch, "pack");
  mkdirSync(packDir);
  const pack = runNpm(["pack", candidateRoot, "--pack-destination", packDir, "--json"]);
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
    const install = runNpm(installArgs);
    if (/node-gyp|\b(?:g\+\+|clang|msbuild)\b|visual studio build tools/i.test(install.stdout + install.stderr)) {
      fail(`${label} install invoked a native compiler`, install);
    }

    const executable = process.platform === "win32" ? join(prefix, "cc-lhc.cmd") : join(prefix, "bin", "cc-lhc");
    const help = runInstalledCli(executable, ["--lhc-help"]);
    if (!help.stdout.includes("get-turns") || !help.stdout.includes("get-messages")) {
      fail(`${label} install did not expose the retrieval commands`, help);
    }
    if (help.stderr.includes("ExperimentalWarning: SQLite is an experimental feature")) {
      fail(`${label} install leaked the known Node 24.3 node:sqlite warning`, help);
    }

    const npmRoot = runNpm(["root", "--global", "--prefix", prefix]).stdout.trim();
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
