/**
 * TC-3.1a/TC-3.1b: CC-LHC version identity without launching Claude, and the
 * versioned help header. The subprocess leg drives the real bin path with a
 * poisoned CC_LHC_CLAUDE_BIN that records any launch attempt.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    const text = formatLhcVersion({
      name: "cc-lhc",
      version: "9.9.9",
      sourceSha: null,
      sourceDirty: false,
      stamped: false,
    });
    expect(text).toContain("cc-lhc 9.9.9");
    expect(text).toContain("unstamped source run");
  });

  it("formats a stamped identity with SHA and dirty marker", () => {
    const sha = "a".repeat(40);
    const clean = formatLhcVersion({
      name: "cc-lhc",
      version: "1.2.3",
      sourceSha: sha,
      sourceDirty: false,
      stamped: true,
    });
    expect(clean).toContain(`source: ${sha}`);
    expect(clean).not.toContain("modified tree");
    const dirty = formatLhcVersion({
      name: "cc-lhc",
      version: "1.2.3",
      sourceSha: sha,
      sourceDirty: true,
      stamped: true,
    });
    expect(dirty).toContain("(modified tree)");
  });

  it("stamps deterministically for an identical source state", () => {
    const out = mkdtempSync(join(tmpdir(), "cc-lhc-stamp-"));
    temps.push(out);
    const script = join(packageRoot, "scripts", "stamp-build-identity.mjs");
    execFileSync(process.execPath, [script, out]);
    const first = readFileSync(join(out, "build-identity.json"), "utf8");
    execFileSync(process.execPath, [script, out]);
    const second = readFileSync(join(out, "build-identity.json"), "utf8");
    expect(second).toBe(first);
    const identity = JSON.parse(first) as { name: string; version: string; sourceSha: string | null };
    expect(identity.name).toBe("cc-lhc");
    expect(identity.version).toBe(manifestVersion);
    if (identity.sourceSha !== null) expect(identity.sourceSha).toMatch(/^[0-9a-f]{40}$/);
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
    const child = spawn(
      tsx.command,
      [...tsx.args, "--lhc-version"],
      {
        env: { ...process.env, CC_LHC_HOME: home, CC_LHC_CLAUDE_BIN: fakeClaude },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
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
