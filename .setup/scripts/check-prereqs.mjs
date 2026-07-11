#!/usr/bin/env node
// Prerequisite check for standalone setup. Exits 0 when all pass.
// Usage: node .setup/scripts/check-prereqs.mjs [--for cc-lhc|pi-lhc] [--skip-claude-call]
// Default --for is cc-lhc (Claude Code on PATH + auth). pi-lhc skips Claude Code checks.
import { execFileSync } from "node:child_process";

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
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 }).trim();
  } catch {
    return null;
  }
}

function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// 1. git
const gitV = run("git", ["--version"]);
check("git", gitV !== null, gitV ?? "not found on PATH");

// 2. node 24.x (>=24.17.0 <25)
const [maj, min] = process.versions.node.split(".").map(Number);
const nodeOk = maj === 24 && (min > 17 || (min === 17 && Number(process.versions.node.split(".")[2]) >= 0));
check("node >=24.17.0 <25", nodeOk, `found v${process.versions.node}`);

// 3. pnpm 11.x
const pnpmV = run("pnpm", ["--version"]);
check("pnpm 11.x", pnpmV !== null && pnpmV.startsWith("11."), pnpmV ?? "not found — try: corepack enable && corepack prepare pnpm@11.8.0 --activate");

// 4–5. Claude Code (cc-lhc only)
if (target === "cc-lhc") {
  const claudeV = run("claude", ["--version"]);
  check("claude on PATH", claudeV !== null, claudeV ?? "Claude Code not found");

  if (claudeV !== null && !skipClaudeCall) {
    const out = run("claude", ["-p", "reply with exactly: ok"]);
    check("claude -p auth", out !== null && out.length > 0, out === null ? "call failed — check Claude Code login" : undefined);
  } else if (skipClaudeCall) {
    console.log("SKIP  claude -p auth (--skip-claude-call)");
  }
} else {
  console.log("SKIP  claude on PATH (pi-lhc — no Claude Code required)");
  console.log("SKIP  claude -p auth (pi-lhc — model auth is via PI login later)");
}

process.exit(failures === 0 ? 0 : 1);
