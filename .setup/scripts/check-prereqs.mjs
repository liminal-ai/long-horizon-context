#!/usr/bin/env node
// Prerequisite check for standalone setup. Exits 0 when all pass.
// Usage: node .setup/scripts/check-prereqs.mjs [--for cc-lhc|pi-lhc] [--skip-claude-call]
// Default --for is cc-lhc (native OS/arch support + Claude Code on PATH + auth).
// pi-lhc skips the Claude Code and native-target checks.
// Runs on native Linux, macOS, and Windows (cmd or PowerShell).
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readTargetsManifestLite } from "../../packages/cc-lhc-native/scripts/asset-names.mjs";
import { claudeAuthProbeArgs, evaluateNodeVersion, probeSpawnOptions, safeProbeToken, targetSupport } from "./lib/prereqs.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function parseFor(argv) {
  const idx = argv.indexOf("--for");
  if (idx === -1) return "cc-lhc";
  const val = argv[idx + 1];
  if (val !== "cc-lhc" && val !== "pi-lhc") {
    console.error(`unknown --for value: ${val ?? "(missing)"} (expected cc-lhc or pi-lhc)`);
    process.exit(1);
  }
  return val;
}

const target = parseFor(process.argv);
const skipClaudeCall = process.argv.includes("--skip-claude-call");
let failures = 0;

function run(cmd, args) {
  for (const token of [cmd, ...args]) {
    if (!safeProbeToken(token)) throw new Error(`unsafe probe token: ${token}`);
  }
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
    ...probeSpawnOptions(process.platform),
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") return null;
  return result.stdout.trim();
}

function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// 1. git
const gitV = run("git", ["--version"]);
check("git", gitV !== null, gitV ?? "not found on PATH");

// 2. node >=24.17.0 (stable node:sqlite floor; newer majors allowed but untested)
const nodeV = evaluateNodeVersion(process.versions.node);
check("node >=24.17.0", nodeV.ok, nodeV.note);

// 3. pnpm 11.x
const pnpmV = run("pnpm", ["--version"]);
check(
  "pnpm 11.x",
  pnpmV !== null && pnpmV.startsWith("11."),
  pnpmV ?? "not found — try: corepack enable && corepack prepare pnpm@11.8.0 --activate",
);

// 4. native OS/arch support (cc-lhc only; targets.json is the source of truth)
if (target === "cc-lhc") {
  const manifest = readTargetsManifestLite(join(repoRoot, "packages", "cc-lhc-native", "targets.json"));
  const support = targetSupport(process.platform, process.arch, manifest.targetKeys);
  check("os/arch supported", support.ok, support.ok ? support.key : support.detail);
} else {
  console.log("SKIP  os/arch supported (pi-lhc — no native addon required)");
}

// 5–6. Claude Code (cc-lhc only)
if (target === "cc-lhc") {
  const claudeV = run("claude", ["--version"]);
  check("claude on PATH", claudeV !== null, claudeV ?? "Claude Code not found");

  if (claudeV !== null && !skipClaudeCall) {
    // Real auth probe; --no-session-persistence keeps the probe from writing
    // a session file into this directory (it would pollute the resume picker).
    const out = run("claude", claudeAuthProbeArgs());
    check("claude -p auth", out !== null && out.length > 0, out === null ? "call failed — check Claude Code login" : undefined);
  } else if (skipClaudeCall) {
    console.log("SKIP  claude -p auth (--skip-claude-call)");
  }
} else {
  console.log("SKIP  claude on PATH (pi-lhc — no Claude Code required)");
  console.log("SKIP  claude -p auth (pi-lhc — model auth is via PI login later)");
}

process.exit(failures === 0 ? 0 : 1);
