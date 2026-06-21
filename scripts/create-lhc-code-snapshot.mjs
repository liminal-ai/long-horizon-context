#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const packageRoot = "packages/lhc";
const defaultOutput = join(repoRoot, "tmp", "lhc-codebase-snapshot.txt");
const args = process.argv.slice(2);
const fullMode = args.includes("--full");
const withTestsMode = args.includes("--with-tests");
const outputArg = args.find((arg) => !arg.startsWith("--"));
const outputPath = resolve(outputArg ?? defaultOutput);

const focusedFiles = new Set([
  `${packageRoot}/src/messages/index.ts`,
  `${packageRoot}/src/messages/internal/derive.ts`,
  `${packageRoot}/src/messages/internal/derivations.ts`,
  `${packageRoot}/src/messages/internal/handlers.ts`,
  `${packageRoot}/src/messages/internal/store.ts`,
  `${packageRoot}/src/messages/internal/work.ts`,
  `${packageRoot}/src/shared-tech/derivation.ts`,
  `${packageRoot}/src/shared-tech/durable-work/index.ts`,
  `${packageRoot}/src/shared-tech/errors.ts`,
  `${packageRoot}/src/shared-tech/index.ts`,
  `${packageRoot}/src/shared-tech/persist.ts`,
  `${packageRoot}/src/shared-tech/scheduler.ts`,
  `${packageRoot}/src/shared-tech/work-queue/index.ts`,
  `${packageRoot}/src/sdk.ts`,
  `${packageRoot}/src/thread-view/index.ts`,
  `${packageRoot}/src/thread-view/internal/render.ts`,
  `${packageRoot}/src/thread-view/internal/select.ts`,
  `${packageRoot}/src/thread-view/internal/snapshot.ts`,
  `${packageRoot}/src/thread-view/internal/sweep.ts`,
  `${packageRoot}/src/turns/index.ts`,
  `${packageRoot}/src/turns/internal/chunks.ts`,
  `${packageRoot}/src/turns/internal/compose.ts`,
  `${packageRoot}/src/turns/internal/derivations.ts`,
  `${packageRoot}/src/turns/internal/derive.ts`,
  `${packageRoot}/src/turns/internal/store.ts`,
  `${packageRoot}/package.json`,
]);

const includedExtensions = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".json",
  ".jsonl",
  ".md",
  ".mjs",
  ".mts",
  ".sql",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

const includedBasenames = new Set(["package.json"]);

const excludedPathParts = new Set([
  "dist",
  "node_modules",
  ".turbo",
  ".cache",
  "coverage",
  ".DS_Store",
]);

function trackedFiles() {
  const stdout = execFileSync("git", ["ls-files", packageRoot], { cwd: repoRoot, encoding: "utf8" });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

function shouldInclude(repoRelativePath) {
  const parts = repoRelativePath.split("/");
  if (parts.some((part) => excludedPathParts.has(part))) return false;
  if (!withTestsMode && repoRelativePath.startsWith(`${packageRoot}/test/`)) return false;
  if (repoRelativePath.startsWith(`${packageRoot}/reference/`)) return false;
  if (!fullMode) return focusedFiles.has(repoRelativePath);
  const basename = parts.at(-1) ?? "";
  if (
    !repoRelativePath.startsWith(`${packageRoot}/src/`) &&
    !repoRelativePath.startsWith(`${packageRoot}/test/`) &&
    !includedBasenames.has(basename)
  ) {
    return false;
  }
  if (includedBasenames.has(basename)) return true;
  return includedExtensions.has(extname(repoRelativePath));
}

function readTextFile(repoRelativePath) {
  const absolutePath = join(repoRoot, repoRelativePath);
  const buffer = readFileSync(absolutePath);
  if (buffer.includes(0)) return undefined;
  return buffer.toString("utf8");
}

const files = trackedFiles().filter(shouldInclude);
const generatedAt = new Date().toISOString();

const chunks = [
  [
    "# LHC Codebase Snapshot",
    "",
    "This is a single-file repo snapshot that can be pasted into a chat interface so the full LHC repo package can be parsed in one context.",
    `Repo root: ${repoRoot}`,
    `Snapshot root: ${packageRoot}`,
    `Snapshot mode: ${
      fullMode
        ? withTestsMode
          ? "full source with tests"
          : "full source"
        : "focused derivation/DWQ/thread-view architecture"
    }`,
    `Generated at: ${generatedAt}`,
    `File count: ${files.length}`,
    "",
    fullMode
      ? withTestsMode
        ? "This full-source snapshot includes test files and fixtures, but still excludes reference files, generated files, and vendor files."
        : "This full-source snapshot excludes tests, references, generated files, and vendor files."
      : "This focused snapshot includes the files most relevant to derivation artifacts, durable work queue mechanics, synchronous derive operations, and thread-view repair/selection coupling. It intentionally excludes tests, thread registry/creation, SDK construction, prompts, inspect, materialize, and general provider plumbing.",
    "",
  ].join("\n"),
];

for (const repoRelativePath of files) {
  const text = readTextFile(repoRelativePath);
  if (text === undefined) continue;
  chunks.push(
    [
      "",
      "=".repeat(100),
      "This is a single-file repo snapshot that can be pasted into a chat interface so the full LHC repo package can be parsed in one context.",
      `File: ${repoRelativePath}`,
      "=".repeat(100),
      "",
      text.trimEnd(),
      "",
    ].join("\n"),
  );
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, chunks.join("\n"), "utf8");

const relativeOutput = relative(repoRoot, outputPath);
console.log(`Wrote ${files.length} files to ${relativeOutput}`);
