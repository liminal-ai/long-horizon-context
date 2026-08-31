/**
 * Workflow/manifest consistency: the GitHub matrix in
 * .github/workflows/native-platforms.yml must stay in lockstep with
 * targets.json (the single source of truth) and the pinned toolchain versions.
 * Deliberately string/regex-based so the gate needs no YAML dependency.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { defaultPackageRoot } from "../src/index.js";
import { loadTargetsManifest, targetKey } from "../src/targets.js";

const packageRoot = defaultPackageRoot();
const repoRoot = join(packageRoot, "..", "..");
const workflowPath = join(repoRoot, ".github", "workflows", "native-platforms.yml");
// Normalize newlines once: a Windows checkout (core.autocrlf) may hand this
// file over with CRLF, and every regex/indexOf below must parse identically
// on all six matrix legs.
const workflow = readFileSync(workflowPath, "utf8").replaceAll("\r\n", "\n");
const manifest = loadTargetsManifest(join(packageRoot, "targets.json"));
const manifestKeys = manifest.targets.map(targetKey);

/** The certified runner mapping; ARM Linux/Windows labels are public preview but required. */
const EXPECTED_RUNNERS: Record<string, string> = {
  "linux-x64": "ubuntu-24.04",
  "linux-arm64": "ubuntu-24.04-arm",
  "darwin-x64": "macos-15-intel",
  "darwin-arm64": "macos-15",
  "win32-x64": "windows-2022",
  "win32-arm64": "windows-11-arm",
};

const STORY0_RUNNERS: Record<string, string> = {
  "linux-x64": "blacksmith-2vcpu-ubuntu-2404",
  "darwin-arm64": "blacksmith-6vcpu-macos-15",
  "win32-x64": "blacksmith-2vcpu-windows-2025",
};

function jobBody(name: string): string {
  const heading = `\n  ${name}:\n`;
  const start = workflow.indexOf(heading);
  expect(start, `missing job ${name}`).toBeGreaterThan(-1);
  const from = start + heading.length;
  const next = workflow.slice(from).search(/\n {2}[A-Za-z0-9_-]+:\n/);
  return next === -1 ? workflow.slice(from) : workflow.slice(from, from + next);
}

function matrixEntries(section: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const match of section.matchAll(/- target: (\S+)\n\s+runner: (\S+)/g)) {
    expect(entries.has(match[1]!), `duplicate matrix target ${match[1]}`).toBe(false);
    entries.set(match[1]!, match[2]!);
  }
  return entries;
}

describe("matrix ↔ targets.json", () => {
  it("native-job matrix targets are exactly the manifest targets", () => {
    expect([...matrixEntries(jobBody("native")).keys()].sort()).toEqual([...manifestKeys].sort());
  });

  it("every native-job target runs on its certified runner label", () => {
    expect(Object.fromEntries(matrixEntries(jobBody("native")))).toEqual(EXPECTED_RUNNERS);
  });

  it("Story 0 process-capability is a dedicated Blacksmith job, not a native-job step", () => {
    expect(jobBody("native")).not.toContain("story0:process-capability");
    expect(workflow).toContain("  story0-process-capability:\n");
    const story0 = jobBody("story0-process-capability");
    expect(Object.fromEntries(matrixEntries(story0))).toEqual(STORY0_RUNNERS);
    expect(story0).toContain('npm_config_msvs_version: "2022"');
    expect(story0).toContain("story0:process-capability");
    expect(story0).not.toContain("pnpm --filter cc-lhc run test");
  });

  it("no target is made optional: fail-fast disabled but no continue-on-error/experimental escape", () => {
    expect(workflow).toContain("fail-fast: false");
    expect(workflow).not.toContain("continue-on-error");
    expect(workflow).not.toMatch(/experimental/i);
  });
});

describe("pinned toolchain and required steps", () => {
  it("checks out recursive submodules in every job", () => {
    expect(workflow.match(/submodules: recursive/g)?.length).toBe(3);
  });

  it("pins current-runtime action majors (Node 24) so Node 20 deprecation warnings cannot return", () => {
    // Current major per action, verified against the official releases via gh
    // on 2026-08-13 — all run on the Node 24 actions runtime.
    const REQUIRED_ACTION_MAJORS: Record<string, number> = {
      "actions/checkout": 7,
      "actions/download-artifact": 8,
      "actions/setup-node": 7,
      "actions/upload-artifact": 7,
      "pnpm/action-setup": 6,
    };
    const used = [...workflow.matchAll(/uses: ([^\s@]+)@v(\d+)/g)].map((m) => [m[1]!, Number(m[2])] as const);
    expect(used.length).toBeGreaterThan(0);
    for (const [action, major] of used) {
      expect(REQUIRED_ACTION_MAJORS[action], `unexpected action ${action} — add it to the pinned majors`).toBeDefined();
      expect(major, `${action} must stay on v${REQUIRED_ACTION_MAJORS[action]}`).toBe(REQUIRED_ACTION_MAJORS[action]);
    }
    expect(new Set(used.map(([action]) => action)).size).toBe(Object.keys(REQUIRED_ACTION_MAJORS).length);
  });

  it("pins Node 24.18.0 and pnpm 11.8.0 (matching packageManager)", () => {
    expect(workflow).toContain("node-version: 24.18.0");
    expect(workflow.match(/version: 11\.8\.0/g)?.length).toBe(3);
    const rootPkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { packageManager?: string };
    expect(rootPkg.packageManager).toBe("pnpm@11.8.0");
  });

  it("installs frozen and builds in dependency order before native compile", () => {
    expect(workflow).toContain("pnpm install --frozen-lockfile");
    const lhcBuild = workflow.indexOf("pnpm --filter lhc run build");
    const nativeBuild = workflow.indexOf("pnpm --filter cc-lhc-native run build\n");
    const gyp = workflow.indexOf("pnpm --filter cc-lhc-native run build:native");
    const stage = workflow.indexOf("run stage:prebuild");
    const nativeTest = workflow.indexOf("run test:native");
    const ccBuild = workflow.indexOf("pnpm --filter cc-lhc run build");
    expect(lhcBuild).toBeGreaterThan(-1);
    expect(nativeBuild).toBeGreaterThan(lhcBuild);
    expect(gyp).toBeGreaterThan(nativeBuild);
    expect(stage).toBeGreaterThan(gyp);
    expect(nativeTest).toBeGreaterThan(stage);
    expect(ccBuild).toBeGreaterThan(nativeTest);
  });

  it("runs the cc-lhc suite with the compiled addon mandatory", () => {
    expect(workflow).toContain("pnpm --filter cc-lhc run test");
    expect(workflow).toContain('CC_LHC_NATIVE_REQUIRE_ADDON: "1"');
  });

  it("does not force a non-native shell (Windows evidence stays PowerShell)", () => {
    expect(workflow).not.toMatch(/shell: *bash/);
    expect(workflow).not.toMatch(/defaults:\s*\n\s*run:/);
  });
});

describe("mainline source-checkout contract", () => {
  it("runs for relevant pushes to main and remains manually dispatchable", () => {
    expect(workflow).toContain("push:");
    expect(workflow).toContain("branches: [main]");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toContain("pull_request:");
  });

  it("assembles an npm package without release or publication side effects", () => {
    expect(workflow).toContain("assemble-npm-package.mjs");
    expect(workflow).toContain("smoke-npm-package.mjs");
    expect(workflow).toContain("npm pack ./build/cc-lhc-npm");
    expect(workflow).toContain("cc-lhc-npm-package");
    expect(workflow).not.toMatch(/npm publish|gh release|action-gh-release|releases\/create|git tag|git push/);
  });
});
