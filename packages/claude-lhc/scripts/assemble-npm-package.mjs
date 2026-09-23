#!/usr/bin/env node

/**
 * Assemble the publishable claude-lhc npm package.
 *
 * Same shape as cc-lhc's assembler: the private workspace `lhc` core is
 * bundled under node_modules (bundledDependencies), so the tarball never
 * names an unpublished package and `lhc` is not published on its own.
 * Third-party runtime dependencies stay ordinary npm dependencies.
 *
 *   node packages/claude-lhc/scripts/assemble-npm-package.mjs \
 *     [--out build/claude-lhc-npm] [--version 0.1.0] [--source-sha <40-hex>]
 *
 * Requires `pnpm --filter lhc build && pnpm --filter claude-lhc build` first.
 * Then `npm pack <out>` produces claude-lhc-<version>.tgz.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "..", "..");
const lhcRoot = join(repoRoot, "packages", "lhc");

function fail(message) {
  console.error(`claude-lhc npm assembly: ${message}`);
  process.exit(1);
}

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) fail(`${flag} needs a value`);
  return value;
}

const known = new Set(["--out", "--version", "--source-sha"]);
for (let i = 2; i < process.argv.length; i += 2) {
  if (!known.has(process.argv[i])) fail(`unknown argument ${JSON.stringify(process.argv[i])}`);
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const claudeManifest = readJson(join(packageRoot, "package.json"));
const lhcManifest = readJson(join(lhcRoot, "package.json"));

const outputRoot = resolve(argValue("--out") ?? join(repoRoot, "build", "claude-lhc-npm"));
const version = argValue("--version") ?? claudeManifest.version;
const sourceSha = argValue("--source-sha") ?? null;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) fail(`invalid version ${JSON.stringify(version)}`);
if (sourceSha !== null && !/^[0-9a-f]{40}$/.test(sourceSha)) fail("--source-sha must be a full 40-hex commit");
const rel = relative(repoRoot, outputRoot);
if (!rel || rel.startsWith("..") || !rel.startsWith("build")) fail("--out must be under the repo's build/ directory");

function requirePath(path, label) {
  if (!existsSync(path)) fail(`missing ${label}: ${relative(repoRoot, path)} (build lhc and claude-lhc first)`);
}
requirePath(join(packageRoot, "dist", "sidecar.js"), "claude-lhc dist");
requirePath(join(lhcRoot, "dist", "index.js"), "lhc dist");

rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(join(outputRoot, "bin"), { recursive: true });

// Compiled JS only: declaration files and source maps are not a runtime need.
const jsOnly = (source) => !/\.(?:d\.ts|d\.ts\.map|js\.map)$/.test(source);
cpSync(join(packageRoot, "dist"), join(outputRoot, "dist"), { recursive: true, filter: jsOnly });
cpSync(join(packageRoot, "bin", "claude-lhc.js"), join(outputRoot, "bin", "claude-lhc.js"));
cpSync(join(packageRoot, "README.md"), join(outputRoot, "README.md"));
cpSync(join(repoRoot, "LICENSE"), join(outputRoot, "LICENSE"));

const bundledLhcRoot = join(outputRoot, "node_modules", "lhc");
cpSync(join(lhcRoot, "dist"), join(bundledLhcRoot, "dist"), { recursive: true, filter: jsOnly });
writeFileSync(
  join(bundledLhcRoot, "package.json"),
  `${JSON.stringify(
    {
      name: "lhc",
      version,
      private: true,
      type: "module",
      main: "./dist/index.js",
      exports: lhcManifest.exports,
      engines: claudeManifest.engines,
    },
    null,
    2,
  )}\n`,
);

const { lhc: _workspaceLhc, ...thirdParty } = claudeManifest.dependencies;
const manifest = {
  name: "claude-lhc",
  version,
  description: claudeManifest.description,
  license: "MIT",
  author: { name: "Lee Moore" },
  type: "module",
  bin: { "claude-lhc": "./bin/claude-lhc.js" },
  main: "./dist/sidecar.js",
  files: ["bin", "dist", "README.md", "LICENSE"],
  bundledDependencies: ["lhc"],
  dependencies: {
    ...thirdParty,
    effect: lhcManifest.dependencies.effect,
    "js-tiktoken": lhcManifest.dependencies["js-tiktoken"],
    lhc: version,
  },
  engines: claudeManifest.engines,
  repository: {
    type: "git",
    url: "git+https://github.com/liminal-ai/long-horizon-context.git",
    directory: "packages/claude-lhc",
  },
  homepage: "https://github.com/liminal-ai/long-horizon-context/tree/main/packages/claude-lhc",
  bugs: { url: "https://github.com/liminal-ai/long-horizon-context/issues" },
  keywords: ["long-horizon-context", "claude-code", "t3code", "sidecar"],
  publishConfig: { access: "public" },
  ...(sourceSha === null ? {} : { gitHead: sourceSha }),
};
writeFileSync(join(outputRoot, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(
  `claude-lhc npm assembly: wrote ${outputRoot} (claude-lhc@${version}${sourceSha ? ` from ${sourceSha}` : ""})`,
);
