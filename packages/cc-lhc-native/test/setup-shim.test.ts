/**
 * Launcher-shim gates: content of the POSIX and Windows shims, PATH
 * containment/guidance logic, and a real install + execution round trip
 * against a fake repo layout. The platform-specific execution branch runs on
 * whichever OS hosts the suite — the Windows branch is exercised by the
 * win32 CI matrix legs, not simulated here.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { defaultPackageRoot } from "../src/index.js";

const repoRoot = join(defaultPackageRoot(), "..", "..");
const installShim = join(repoRoot, ".setup", "scripts", "install-shim.mjs");
const shimLib = await import(pathToFileURL(join(repoRoot, ".setup", "scripts", "lib", "shim.mjs")).href);

function makeFakeRepo(marker: string): string {
  const root = mkdtempSync(join(tmpdir(), "cc-lhc-shim-repo-"));
  const distDir = join(root, "packages", "cc-lhc", "dist");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(
    join(distDir, "bin.js"),
    `console.log(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));\n`,
  );
  return root;
}

describe("shim content", () => {
  it("POSIX shim guards missing dist and forwards all arguments", () => {
    const content = shimLib.posixShimContent("cc-lhc", "cc-lhc", "/repo/packages/cc-lhc/dist/bin.js", "/repo");
    expect(content.startsWith("#!/usr/bin/env bash\n")).toBe(true);
    expect(content).toContain('if [[ ! -f "$DIST_BIN" ]]');
    expect(content).toContain("pnpm --config.verify-deps-before-run=false --filter cc-lhc run build");
    expect(content).toContain('exec node "$DIST_BIN" "$@"');
  });

  it("POSIX shim survives a repo path containing a single quote", () => {
    const content = shimLib.posixShimContent("cc-lhc", "cc-lhc", "/it's here/dist/bin.js", "/it's here");
    expect(content).toContain(`'/it'"'"'s here/dist/bin.js'`);
  });

  it("Windows .cmd shim is stable batch text: fixed launcher name only, never a repo path", () => {
    const content = shimLib.windowsCmdShimContent("cc-lhc");
    expect(content.startsWith("@echo off\r\n")).toBe(true);
    expect(content).toContain('node "%~dp0cc-lhc.launcher.js" %*');
    expect(content).toContain("exit /b %ERRORLEVEL%");
    expect(content.endsWith("\r\n")).toBe(true);
    expect(shimLib.windowsCmdShimContent("cc-lhc")).toBe(content);
    expect(() => shimLib.windowsCmdShimContent("evil & calc")).toThrow(/unsafe launcher name/);
  });

  it("Windows launcher.js JSON-encodes hostile repo paths so cmd.exe never parses them", () => {
    const hostileDist = 'C:\\repo & echo pwned (x86)\\100% "q"\\dist\\bin.js';
    const hostileRoot = 'C:\\repo & echo pwned (x86)\\100% "q"';
    const content = shimLib.windowsLauncherJsContent("cc-lhc", "cc-lhc", hostileDist, hostileRoot);
    expect(content).toContain(`const DIST_BIN = ${JSON.stringify(hostileDist)};`);
    expect(content).toContain(`const REPO_ROOT = ${JSON.stringify(hostileRoot)};`);
    expect(content).toContain("process.argv.slice(2)");
    expect(content).toContain('stdio: "inherit"');
    expect(content).toContain("pnpm --config.verify-deps-before-run=false --filter ");
    // The launcher must be valid JS even with the hostile path embedded.
    expect(() => new Function(content)).not.toThrow();
  });

  it("Windows launcher.js executes: forwards args, guards missing dist (runs on every platform)", () => {
    const marker = `launcher-ok-${process.pid}`;
    // Metacharacters that are legal in directory names on every filesystem.
    const repo = mkdtempSync(join(tmpdir(), "cc-lhc shim $ & (x) 'q\" repo-"));
    const distDir = join(repo, "packages", "cc-lhc", "dist");
    mkdirSync(distDir, { recursive: true });
    const distBin = join(distDir, "bin.js");
    writeFileSync(distBin, `console.log(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));\n`);
    const binDir = mkdtempSync(join(tmpdir(), "cc-lhc-shim-bin-"));
    const launcher = join(binDir, "cc-lhc.launcher.js");
    writeFileSync(launcher, shimLib.windowsLauncherJsContent("cc-lhc", "cc-lhc", distBin, repo));

    const run = spawnSync(process.execPath, [launcher, "hello world", "--flag"], { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(marker);
    expect(run.stdout).toContain("hello world");
    expect(run.stdout).toContain("--flag");

    const missing = join(binDir, "missing.launcher.js");
    writeFileSync(missing, shimLib.windowsLauncherJsContent("cc-lhc", "cc-lhc", join(repo, "nope", "bin.js"), repo));
    const guard = spawnSync(process.execPath, [missing], { encoding: "utf8" });
    expect(guard.status).toBe(1);
    expect(guard.stderr).toContain("missing built launcher");
    expect(guard.stderr).toContain("pnpm --config.verify-deps-before-run=false --filter cc-lhc run build");
  });
});

describe("PATH containment and guidance", () => {
  it("POSIX: exact, colon-separated, trailing-slash tolerant", () => {
    expect(shimLib.binDirOnPath("/home/u/.local/bin", "/usr/bin:/home/u/.local/bin", "linux")).toBe(true);
    expect(shimLib.binDirOnPath("/home/u/.local/bin", "/usr/bin:/home/u/.local/bin/", "linux")).toBe(true);
    expect(shimLib.binDirOnPath("/home/u/.local/bin", "/usr/bin:/home/U/.local/bin", "linux")).toBe(false);
    expect(shimLib.binDirOnPath("/home/u/.local/bin", "", "linux")).toBe(false);
  });

  it("win32: case-insensitive, semicolon-separated, separator tolerant", () => {
    const bin = "C:\\Users\\u\\.local\\bin";
    expect(shimLib.binDirOnPath(bin, "C:\\Windows;c:\\users\\U\\.LOCAL\\bin", "win32")).toBe(true);
    expect(shimLib.binDirOnPath(bin, "C:\\Windows;C:\\Users\\u\\.local\\bin\\", "win32")).toBe(true);
    expect(shimLib.binDirOnPath(bin, "C:\\Windows", "win32")).toBe(false);
  });

  it("guidance is platform-correct and actionable", () => {
    const win = shimLib.pathGuidance("C:\\Users\\u\\.local\\bin", "win32").join("\n");
    expect(win).toContain("SetEnvironmentVariable");
    expect(win).toContain("';C:\\Users\\u\\.local\\bin'");
    const posix = shimLib.pathGuidance("/home/u/.local/bin", "linux").join("\n");
    expect(posix).toContain('export PATH="/home/u/.local/bin:$PATH"');
  });

  it("win32 guidance uses single-quoted PowerShell literals so $ and metacharacters stay literal", () => {
    const hostile = "C:\\Users\\o'brien\\$env dirs\\`bin";
    const line = shimLib.pathGuidance(hostile, "win32").find((l: string) => l.includes("SetEnvironmentVariable"));
    expect(line).toBeDefined();
    expect(line).toContain(shimLib.psQuote(`;${hostile}`));
    expect(line).not.toContain('"Path"');
    expect(shimLib.psQuote("a'b$c")).toBe("'a''b$c'");
  });
});

describe("install-shim CLI round trip (fake repo)", () => {
  it("installs a runnable launcher that forwards arguments", () => {
    const marker = `shim-ok-${process.pid}`;
    const repo = makeFakeRepo(marker);
    const binDir = mkdtempSync(join(tmpdir(), "cc-lhc-shim-bin-"));
    const install = spawnSync(process.execPath, [installShim, "--repo-root", repo, "--bin-dir", binDir], {
      encoding: "utf8",
    });
    expect(install.status).toBe(0);
    expect(install.stdout).toContain("wrote ");

    if (process.platform === "win32") {
      const dest = join(binDir, "cc-lhc.cmd");
      expect(existsSync(dest)).toBe(true);
      const content = readFileSync(dest, "utf8");
      expect(content).toContain("%*");
      expect(content).toContain("%~dp0cc-lhc.launcher.js");
      expect(content).not.toContain(repo);
      const launcher = readFileSync(join(binDir, "cc-lhc.launcher.js"), "utf8");
      expect(launcher).toContain(JSON.stringify(join(repo, "packages", "cc-lhc", "dist", "bin.js")));
      const exec = spawnSync(dest, ["hello-world", "--flag"], { encoding: "utf8", shell: true });
      expect(exec.status).toBe(0);
      expect(exec.stdout).toContain(marker);
      expect(exec.stdout).toContain("hello-world");
      expect(exec.stdout).toContain("--flag");
    } else {
      const dest = join(binDir, "cc-lhc");
      expect(existsSync(dest)).toBe(true);
      expect(statSync(dest).mode & 0o111).not.toBe(0);
      const exec = spawnSync(dest, ["hello world", "--flag"], { encoding: "utf8" });
      expect(exec.status).toBe(0);
      expect(exec.stdout).toContain(marker);
      expect(exec.stdout).toContain("hello world");
      expect(exec.stdout).toContain("--flag");
    }
  });

  it("prints PATH guidance only when the bin dir is off PATH", () => {
    const repo = makeFakeRepo("m");
    const binDir = mkdtempSync(join(tmpdir(), "cc-lhc-shim-bin-"));
    const off = spawnSync(process.execPath, [installShim, "--repo-root", repo, "--bin-dir", binDir], {
      encoding: "utf8",
    });
    expect(off.stdout).toContain("not on PATH");

    const pathSep = process.platform === "win32" ? ";" : ":";
    const on = spawnSync(process.execPath, [installShim, "--repo-root", repo, "--bin-dir", binDir], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${process.env.PATH}${pathSep}${binDir}` },
    });
    expect(on.stdout).not.toContain("not on PATH");
  });

  it("refuses with build guidance when dist is missing", () => {
    const repo = mkdtempSync(join(tmpdir(), "cc-lhc-shim-nodist-"));
    const binDir = mkdtempSync(join(tmpdir(), "cc-lhc-shim-bin-"));
    const run = spawnSync(process.execPath, [installShim, "--repo-root", repo, "--bin-dir", binDir], {
      encoding: "utf8",
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("missing built launcher");
    expect(run.stderr).toContain("pnpm --config.verify-deps-before-run=false --filter cc-lhc run build");
  });
});
