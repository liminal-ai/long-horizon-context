/**
 * Guards for cross-platform script execution and the no-compile install
 * contract. Package scripts must run under native Windows cmd via npm/pnpm:
 * no `rm -rf`, no POSIX inline env assignment, no nested pnpm-run (this repo
 * tracks a pnpm pre-run crash), and binding.gyp's implicit install
 * compilation must stay neutralized by an explicit install script.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { defaultPackageRoot } from "../src/index.js";

const root = defaultPackageRoot();
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
  private?: boolean;
};

describe("package scripts are portable to native Windows cmd", () => {
  it.each(Object.entries(pkg.scripts))("%s: %s", (_name, command) => {
    // No POSIX-only file removal.
    expect(command).not.toMatch(/\brm\s+-rf?\b/);
    // No POSIX inline environment assignment (VAR=x cmd).
    expect(command).not.toMatch(/^[A-Z_][A-Z0-9_]*=\S+\s/);
    expect(command).not.toMatch(/&&\s*[A-Z_][A-Z0-9_]*=\S+\s/);
    // No nested pnpm-run dependence.
    expect(command).not.toMatch(/\bpnpm\s+(run|exec|--filter)\b/);
    expect(command).not.toMatch(/\bnpm\s+run\b/);
  });

  it("every script-referenced Node helper exists", () => {
    for (const command of Object.values(pkg.scripts)) {
      for (const match of command.matchAll(/node\s+(scripts\/[\w-]+\.mjs)/g)) {
        expect(existsSync(join(root, match[1]!)), `${match[1]} referenced but missing`).toBe(true);
      }
    }
  });
});

describe("install never compiles", () => {
  it("binding.gyp exists but the implicit node-gyp install step is neutralized", () => {
    expect(existsSync(join(root, "binding.gyp"))).toBe(true);
    expect(pkg.scripts.install).toBe("node scripts/noop-install.mjs");
    const noop = readFileSync(join(root, "scripts", "noop-install.mjs"), "utf8");
    expect(noop).toContain("process.exit(0)");
    expect(noop).not.toMatch(/child_process|spawn|exec[AS(]/);
  });

  it("source builds stay available through an explicit development script", () => {
    expect(pkg.scripts["build:native"]).toContain("node-gyp rebuild");
  });

  it("package stays private (workspace + release bundle, not npm publish)", () => {
    expect(pkg.private).toBe(true);
  });
});
