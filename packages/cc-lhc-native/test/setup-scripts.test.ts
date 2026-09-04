/**
 * Setup-script gates: prerequisite target mapping, the non-persistent Claude
 * auth probe, and the prebuild downloader's source resolution and refusal
 * paths. Libraries under .setup/scripts/lib are imported directly; CLI wiring
 * is exercised by spawning the real scripts. Network downloads are foreign
 * evidence and are not attempted here — every spawned path below fails or
 * succeeds before any fetch.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { defaultPackageRoot } from "../src/index.js";
import { loadTargetsManifest, targetKey } from "../src/targets.js";

const packageRoot = defaultPackageRoot();
const repoRoot = join(packageRoot, "..", "..");
const setupScripts = join(repoRoot, ".setup", "scripts");
const manifest = loadTargetsManifest(join(packageRoot, "targets.json"));
const manifestKeys = manifest.targets.map(targetKey);

const prereqsLib = await import(pathToFileURL(join(setupScripts, "lib", "prereqs.mjs")).href);
const prebuildLib = await import(pathToFileURL(join(setupScripts, "lib", "prebuild.mjs")).href);

function runScript(script: string, args: string[], env: Record<string, string | undefined> = {}) {
  const result = spawnSync(process.execPath, [join(setupScripts, script), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 120_000,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("prereqs: node version floor", () => {
  it.each([
    ["24.17.0", true],
    ["24.18.0", true],
    ["25.0.0", true],
    ["24.16.9", false],
    ["22.12.0", false],
  ])("%s -> ok=%s", (version, ok) => {
    expect(prereqsLib.evaluateNodeVersion(version).ok).toBe(ok);
  });

  it("newer major carries an untested note", () => {
    expect(prereqsLib.evaluateNodeVersion("25.1.0").note).toMatch(/untested major/);
  });
});

describe("prereqs: OS/arch target mapping", () => {
  it.each(manifestKeys)("%s is supported", (key) => {
    const [platform, arch] = key.split("-");
    expect(prereqsLib.targetSupport(platform, arch, manifestKeys)).toEqual({ ok: true, key });
  });

  it.each([
    ["sunos", "sparc"],
    ["linux", "ia32"],
    ["darwin", "ppc64"],
    ["win32", "ia32"],
  ])("%s-%s is refused with the supported list", (platform, arch) => {
    const support = prereqsLib.targetSupport(platform, arch, manifestKeys);
    expect(support.ok).toBe(false);
    expect(support.detail).toContain(`${platform}-${arch}`);
    for (const key of manifestKeys) {
      expect(support.detail).toContain(key);
    }
  });

  it("the manifest holds exactly the six certified targets", () => {
    expect([...manifestKeys].sort()).toEqual(
      ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"].sort(),
    );
  });
});

describe("prereqs: Claude auth probe", () => {
  it("uses -p with --no-session-persistence (never writes a session file)", () => {
    const args = prereqsLib.claudeAuthProbeArgs();
    expect(args).toContain("-p");
    expect(args).toContain("--no-session-persistence");
  });

  it("every probe token is safe for the Windows shell-resolution path", () => {
    for (const token of ["git", "pnpm", "claude", "--version", ...prereqsLib.claudeAuthProbeArgs()]) {
      expect(prereqsLib.safeProbeToken(token), token).toBe(true);
    }
    expect(prereqsLib.safeProbeToken("a b")).toBe(false);
    expect(prereqsLib.safeProbeToken('a"b')).toBe(false);
    expect(prereqsLib.safeProbeToken("a;b")).toBe(false);
  });

  it("probes go through the shell only on win32", () => {
    expect(prereqsLib.probeSpawnOptions("win32")).toEqual({ shell: true });
    expect(prereqsLib.probeSpawnOptions("linux")).toEqual({});
    expect(prereqsLib.probeSpawnOptions("darwin")).toEqual({});
  });
});

describe("check-prereqs CLI", () => {
  it("--for pi-lhc passes on a machine with git+node+pnpm (this one and every matrix runner)", () => {
    const run = runScript("check-prereqs.mjs", ["--for", "pi-lhc"]);
    expect(run.stdout).toMatch(/PASS {2}git/);
    expect(run.stdout).toMatch(/PASS {2}node >=24\.17\.0/);
    expect(run.stdout).toMatch(/PASS {2}pnpm 11\.x/);
    expect(run.stdout).toMatch(/SKIP {2}claude on PATH/);
    expect(run.status).toBe(0);
  });

  it("cc-lhc mode reports os/arch support from targets.json and honors --skip-claude-call", () => {
    const run = runScript("check-prereqs.mjs", ["--skip-claude-call"]);
    expect(run.stdout).toMatch(new RegExp(`PASS {2}os/arch supported — ${process.platform}-${process.arch}`));
    if (run.stdout.includes("PASS  claude on PATH")) {
      expect(run.stdout).toMatch(/SKIP {2}claude -p auth \(--skip-claude-call\)/);
    }
  });

  it("rejects an unknown --for value", () => {
    const run = runScript("check-prereqs.mjs", ["--for", "bogus"]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("unknown --for value");
  });
});

describe("fetch-prebuild: release-source resolution", () => {
  const config = { repo: "liminal-ai/long-horizon-context", tag: null };

  it("--base-url wins over everything and is stripped of trailing slashes", () => {
    const source = prebuildLib.resolveReleaseSource({
      argvBaseUrl: "https://mirror.example/assets///",
      argvTag: "v9.9.9",
      env: { CC_LHC_PREBUILD_TAG: "v0.0.1" },
      config: { ...config, tag: "v0.2.0" },
    });
    expect(source).toEqual({ ok: true, baseUrl: "https://mirror.example/assets", via: "--base-url" });
  });

  it("--tag beats env beats config", () => {
    const argvTag = prebuildLib.resolveReleaseSource({ argvTag: "v2", env: { CC_LHC_PREBUILD_TAG: "v1" }, config });
    expect(argvTag.baseUrl).toBe("https://github.com/liminal-ai/long-horizon-context/releases/download/v2");
    const envTag = prebuildLib.resolveReleaseSource({ env: { CC_LHC_PREBUILD_TAG: "v1" }, config });
    expect(envTag.baseUrl).toContain("/download/v1");
    const configTag = prebuildLib.resolveReleaseSource({ env: {}, config: { ...config, tag: "v0.2.0" } });
    expect(configTag.baseUrl).toContain("/download/v0.2.0");
    expect(configTag.via).toBe("prebuild-release.json");
  });

  it("no tag anywhere fails with actionable guidance (XP4 flips the config, not the script)", () => {
    const source = prebuildLib.resolveReleaseSource({ env: {}, config });
    expect(source.ok).toBe(false);
    expect(source.error).toContain("--tag");
    expect(source.error).toContain("prebuild-release.json");
    // Build-from-source fallback must not point at the broken bare pnpm
    // pre-run path (open bug long-horizon-context-52k).
    expect(source.error).toContain(
      "pnpm --config.verify-deps-before-run=false --filter cc-lhc-native run build:native",
    );
  });

  it("prebuild-release.json guidance also carries the pnpm pre-run workaround", () => {
    const shipped = JSON.parse(readFileSync(join(repoRoot, ".setup", "prebuild-release.json"), "utf8")) as {
      note: string;
    };
    expect(shipped.note).toContain(
      "pnpm --config.verify-deps-before-run=false --filter cc-lhc-native run build:native",
    );
    expect(shipped.note).not.toMatch(/ pnpm --filter/);
  });

  it("malformed tags and missing repo are refused", () => {
    expect(prebuildLib.resolveReleaseSource({ argvTag: "v1;rm", env: {}, config }).ok).toBe(false);
    expect(prebuildLib.resolveReleaseSource({ argvTag: "v1", env: {}, config: {} }).ok).toBe(false);
  });
});

describe("fetch-prebuild: subprocess probe-report validation (full portable-identity contract)", () => {
  const goodProbe = { ok: true, pid: 4242, bootId: "boot-uuid-0799", starttime: "119880620" };
  const goodFileProbe = { ok: true, path: "/tmp/x.node", volumeId: "66306", fileId: "ino:1234" };
  const goodReport = {
    contract: 3,
    platform: process.platform,
    pid: 4242,
    probe: goodProbe,
    fileProbe: goodFileProbe,
    exports: [...prebuildLib.PREBUILD_FUNCTION_EXPORTS],
  };
  const withProbe = (probe: unknown) => ({ ...goodReport, probe });
  const withFileProbe = (fileProbe: unknown) => ({ ...goodReport, fileProbe });

  it("accepts a complete live identity for the probed pid", () => {
    const verdict = prebuildLib.validateProbeReport(goodReport, process.platform);
    expect(verdict).toEqual({ ok: true, probe: goodProbe });
  });

  it("accepts every tagged file-identity shape the addon can report", () => {
    for (const fileId of ["ino:1234", `id128:${"ab".repeat(16)}`, "index64:8444249301319707"]) {
      const verdict = prebuildLib.validateProbeReport(withFileProbe({ ...goodFileProbe, fileId }), process.platform);
      expect(verdict, fileId).toEqual({ ok: true, probe: goodProbe });
    }
  });

  it.each([
    ["non-object report", "nope", /not an object/],
    ["wrong contract version", { ...goodReport, contract: 2 }, /contract version 2/],
    [
      "contract-3 export missing",
      { ...goodReport, exports: ["readProcessIdentity", "readFileIdentity"] },
      /export pauseProcess/,
    ],
    ["exports missing entirely", { ...goodReport, exports: undefined }, /export readProcessIdentity/],
    ["file probe missing (addon predates file identity)", withFileProbe(null), /identify the downloaded file/],
    ["file probe not ok", withFileProbe({ ok: false, code: "not_found" }), /identify the downloaded file/],
    ["file probe volumeId not digits", withFileProbe({ ...goodFileProbe, volumeId: "x" }), /volumeId/],
    ["file probe fileId untagged", withFileProbe({ ...goodFileProbe, fileId: "1234" }), /fileId/],
    ["foreign platform", { ...goodReport, platform: "beos" }, /compiled for beos/],
    ["probe not ok", withProbe({ ok: false, code: "not_found" }), /identify a live process/],
    ["probe missing", withProbe(undefined), /identify a live process/],
    ["mismatched pid echo", withProbe({ ...goodProbe, pid: 4243 }), /does not match probed pid/],
    ["non-integer pid", withProbe({ ...goodProbe, pid: "4242" }), /does not match probed pid/],
    ["short bootId", withProbe({ ...goodProbe, bootId: "boot" }), /invalid bootId/],
    ["empty bootId", withProbe({ ...goodProbe, bootId: "" }), /invalid bootId/],
    ["missing bootId", withProbe({ ...goodProbe, bootId: undefined }), /invalid bootId/],
    ["empty starttime", withProbe({ ...goodProbe, starttime: "" }), /invalid starttime/],
    ["non-digit starttime", withProbe({ ...goodProbe, starttime: "12a4" }), /invalid starttime/],
    ["numeric (non-string) starttime", withProbe({ ...goodProbe, starttime: 119880620 }), /invalid starttime/],
    ["oversized starttime", withProbe({ ...goodProbe, starttime: "9".repeat(21) }), /invalid starttime/],
  ])("rejects %s", (_label, report, reasonPattern) => {
    const verdict = prebuildLib.validateProbeReport(report, process.platform);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(reasonPattern as RegExp);
  });
});

describe("fetch-prebuild CLI refusal paths (no network reached)", () => {
  const cleanEnv = { CC_LHC_PREBUILD_TAG: undefined, CC_LHC_PREBUILD_BASE_URL: undefined };

  it("refuses an unsupported target before anything else", () => {
    const run = runScript("fetch-prebuild.mjs", ["--target", "sunos-sparc"], cleanEnv);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("sunos-sparc is not a supported cc-lhc target");
    expect(run.stderr).toContain("linux-x64");
  });

  it("without any configured tag it refuses with guidance (repo config ships tag=null until XP4)", () => {
    const run = runScript("fetch-prebuild.mjs", [], cleanEnv);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("no release tag configured");
  });
});
