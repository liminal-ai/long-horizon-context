/**
 * TC-3.1a/TC-3.1b: CC-LHC version identity without launching Claude, and the
 * versioned help header. The subprocess leg drives the real bin path with a
 * poisoned CC_LHC_CLAUDE_BIN that records any launch attempt.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { CC_LHC_HELP } from "../src/help.js";
import { formatLhcVersion, readBuildIdentity } from "../src/version.js";
import { tsxCommand } from "./helpers/tsx.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const manifestVersion = (JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version: string })
  .version;

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("build identity", () => {
  it("reports the manifest version and truthful stamp state", () => {
    const identity = readBuildIdentity();
    expect(identity.name).toBe("cc-lhc");
    expect(identity.version).toBe(manifestVersion);
    if (!identity.stamped) {
      expect(identity.sourceSha).toBeNull();
    }
  });

  it("formats an unstamped source run without inventing a SHA", () => {
    const text = formatLhcVersion({ name: "cc-lhc", version: "9.9.9", sourceSha: null, stamped: false });
    expect(text).toContain("cc-lhc 9.9.9");
    expect(text).toContain("unstamped source run");
  });

  it("formats a stamped identity as the accepted SHA, or truthfully unavailable", () => {
    const sha = "a".repeat(40);
    expect(formatLhcVersion({ name: "cc-lhc", version: "1.2.3", sourceSha: sha, stamped: true })).toContain(
      `source: ${sha}`,
    );
    expect(formatLhcVersion({ name: "cc-lhc", version: "1.2.3", sourceSha: null, stamped: true })).toContain(
      "source: unavailable",
    );
  });

  const STAMPER = join(packageRoot, "scripts", "stamp-build-identity.mjs");
  /** A PATH holding only a `git` that records any invocation; Node itself is invoked by absolute path. */
  function poisonedGitPath(): { path: string; marker: string } {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-nogit-"));
    temps.push(dir);
    const marker = join(dir, "git-invoked.marker");
    const shim = join(dir, "git");
    writeFileSync(shim, `#!/bin/sh\nprintf invoked > ${JSON.stringify(marker)}\necho deadbeef\n`);
    chmodSync(shim, 0o755);
    return { path: dir, marker };
  }
  function stamp(args: string[], path: string): ReturnType<typeof spawnSync> {
    return spawnSync(process.execPath, [STAMPER, ...args], { encoding: "utf8", env: { PATH: path } });
  }

  it("stamps identity unavailable for an ordinary build, deterministically, without consulting git", () => {
    const out = mkdtempSync(join(tmpdir(), "cc-lhc-stamp-"));
    temps.push(out);
    const git = poisonedGitPath();
    expect(stamp(["--out", out], git.path).status).toBe(0);
    const first = readFileSync(join(out, "build-identity.json"), "utf8");
    expect(stamp(["--out", out], git.path).status).toBe(0);
    expect(readFileSync(join(out, "build-identity.json"), "utf8")).toBe(first);
    expect(JSON.parse(first)).toEqual({ name: "cc-lhc", version: manifestVersion, sourceSha: null });
    expect(first).not.toContain("sourceDirty");
    expect(existsSync(git.marker), "the stamper must never invoke git").toBe(false);
  });

  it("stamps exactly the explicit --source-sha and refuses a malformed one", () => {
    const out = mkdtempSync(join(tmpdir(), "cc-lhc-stamp-"));
    temps.push(out);
    const git = poisonedGitPath();
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(stamp(["--out", out, "--source-sha", sha], git.path).status).toBe(0);
    expect(JSON.parse(readFileSync(join(out, "build-identity.json"), "utf8"))).toEqual({
      name: "cc-lhc",
      version: manifestVersion,
      sourceSha: sha,
    });
    for (const bad of ["deadbeef", "HEAD", "A".repeat(40)]) {
      const result = stamp(["--out", out, "--source-sha", bad], git.path);
      expect(result.status).toBe(2);
      expect(String(result.stderr)).toContain("--source-sha");
    }
    expect(stamp(["--out", out, "--dirty"], git.path).status).toBe(2);
    expect(existsSync(git.marker)).toBe(false);
  });
});

describe("help header", () => {
  it("includes the CC-LHC version and both identity flags (TC-3.1b)", () => {
    expect(CC_LHC_HELP.startsWith(`cc-lhc ${manifestVersion} — `)).toBe(true);
    expect(CC_LHC_HELP).toContain("--lhc-version");
    expect(CC_LHC_HELP).toContain("--version, are forwarded");
  });
});

describe("cc-lhc --lhc-version subprocess", () => {
  it("prints identity, exits 0, and never launches Claude (TC-3.1a)", async () => {
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-version-home-"));
    temps.push(home);
    const marker = join(home, "claude-launched.marker");
    const fakeClaude = join(home, "fake-claude.mjs");
    writeFileSync(
      fakeClaude,
      `import{writeFileSync}from"node:fs";writeFileSync(${JSON.stringify(marker)},"launched");\n`,
    );

    const tsx = tsxCommand(join(packageRoot, "src", "bin.ts"));
    const child = spawn(tsx.command, [...tsx.args, "--lhc-version"], {
      env: { ...process.env, CC_LHC_HOME: home, CC_LHC_CLAUDE_BIN: fakeClaude },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const exitCode = await new Promise<number | null>((resolveExit) => {
      child.on("close", (code) => resolveExit(code));
    });

    expect(exitCode, stderr).toBe(0);
    expect(stdout).toContain(`cc-lhc ${manifestVersion}`);
    expect(stdout).toContain("source");
    expect(existsSync(marker), "Claude must not be launched by --lhc-version").toBe(false);
  }, 30_000);
});
