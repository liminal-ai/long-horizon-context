/**
 * Downloader mutation gates: .setup/scripts/fetch-prebuild.mjs run for real
 * against a loopback HTTP server (127.0.0.1 only — no external network),
 * with the install root redirected via the --prebuilds-dir test seam.
 *
 * Proven here: a checksum mismatch installs nothing; a checksum-valid but
 * unloadable artifact is rejected by the subprocess probe BEFORE the
 * installed addon is touched; a failure during replacement restores the
 * previously installed addon; success replaces it and leaves no temp/backup
 * residue; and a foreign target gets checksum verification only (a
 * deliberately unloadable foreign artifact still installs cleanly).
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { defaultPackageRoot } from "../src/index.js";
import { loadTargetsManifest, targetKey } from "../src/targets.js";

const packageRoot = defaultPackageRoot();
const repoRoot = join(packageRoot, "..", "..");
const fetchPrebuild = join(repoRoot, ".setup", "scripts", "fetch-prebuild.mjs");
const assetLib = await import(pathToFileURL(join(packageRoot, "scripts", "asset-names.mjs")).href);

const manifest = loadTargetsManifest(join(packageRoot, "targets.json"));
const currentKey = `${process.platform}-${process.arch}`;
const foreignKey = manifest.targets.map(targetKey).find((key) => key !== currentKey)!;
const artifact = manifest.artifact;
const currentAsset = assetLib.assetNameForTarget(artifact, currentKey) as string;

const requireAddon = process.env.CC_LHC_NATIVE_REQUIRE_ADDON === "1";
const realAddonPath = [
  join(packageRoot, "prebuilds", currentKey, artifact),
  join(packageRoot, "build", "Release", artifact),
].find(existsSync);
const realAddonBytes = realAddonPath ? readFileSync(realAddonPath) : undefined;

function sums(entries: Array<[string, Buffer]>): Buffer {
  return Buffer.from(
    `${entries.map(([name, body]) => assetLib.checksumLine(assetLib.sha256Hex(body), name)).join("\n")}\n`,
    "utf8",
  );
}

async function withServer(assets: Record<string, Buffer>, fn: (baseUrl: string) => void | Promise<void>) {
  const server: Server = createServer((req, res) => {
    const body = assets[(req.url ?? "").replace(/^\//, "")];
    if (body === undefined) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.end(body);
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

// Async spawn on purpose: the loopback server lives in THIS process, so a
// spawnSync here would block the event loop and deadlock every download.
function runFetch(
  baseUrl: string,
  target: string,
  prebuildsDir: string,
  extraEnv: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      process.execPath,
      [fetchPrebuild, "--base-url", baseUrl, "--target", target, "--prebuilds-dir", prebuildsDir],
      {
        timeout: 120_000,
        env: {
          ...process.env,
          CC_LHC_PREBUILD_TAG: undefined,
          CC_LHC_PREBUILD_BASE_URL: undefined,
          CC_LHC_PREBUILD_TEST_FAIL: undefined,
          ...extraEnv,
        },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", rejectRun);
    child.on("close", (status) => resolveRun({ status, stdout, stderr }));
  });
}

/** Fresh install root with a sentinel "previously installed addon" for `target`. */
function seededRoot(target: string, sentinel: Buffer): { root: string; dest: string } {
  const root = mkdtempSync(join(tmpdir(), "cc-lhc-fetch-http-"));
  const destDir = join(root, target);
  mkdirSync(destDir, { recursive: true });
  const dest = join(destDir, artifact);
  writeFileSync(dest, sentinel);
  return { root, dest };
}

function residue(root: string, target: string): string[] {
  return readdirSync(join(root, target)).filter((name) => name !== artifact);
}

describe("fetch-prebuild against a mutating loopback release server", () => {
  it("a real addon artifact is available to serve (mandatory-addon runs must not skip)", () => {
    if (requireAddon) {
      expect(realAddonPath, "CC_LHC_NATIVE_REQUIRE_ADDON=1 but no compiled addon to serve").toBeDefined();
    }
  });

  it("bad checksum: fails, installs nothing, preserves the installed addon, leaves no residue", async () => {
    const garbage = Buffer.from("not the addon you signed for");
    const other = Buffer.from("checksum of a different body");
    const sentinel = Buffer.from(`sentinel-${process.pid}-checksum`);
    const { root, dest } = seededRoot(currentKey, sentinel);
    await withServer(
      { [assetLib.CHECKSUMS_ASSET_NAME]: sums([[currentAsset, other]]), [currentAsset]: garbage },
      async (baseUrl) => {
        const run = await runFetch(baseUrl, currentKey, root);
        // Failure exits are nonzero, not exactly 1: Windows can surface a
        // native abnormal-termination status (e.g. 3221226505) for a failing
        // Node subprocess; the semantic proof is stderr + on-disk state.
        expect(run.status).not.toBe(0);
        expect(run.status).not.toBeNull();
        expect(run.stderr).toContain("checksum mismatch");
        expect(readFileSync(dest)).toEqual(sentinel);
        expect(residue(root, currentKey)).toEqual([]);
      },
    );
  });

  it("checksum-valid but unloadable: subprocess probe rejects before the installed addon is touched", async () => {
    const garbage = Buffer.from("valid checksum, invalid machine code");
    const sentinel = Buffer.from(`sentinel-${process.pid}-probe`);
    const { root, dest } = seededRoot(currentKey, sentinel);
    await withServer(
      { [assetLib.CHECKSUMS_ASSET_NAME]: sums([[currentAsset, garbage]]), [currentAsset]: garbage },
      async (baseUrl) => {
        const run = await runFetch(baseUrl, currentKey, root);
        expect(run.status).not.toBe(0);
        expect(run.status).not.toBeNull();
        expect(run.stdout).toContain("checksum verified");
        expect(run.stderr).toContain("rejected before install (installed addon untouched)");
        expect(readFileSync(dest)).toEqual(sentinel);
        expect(residue(root, currentKey)).toEqual([]);
      },
    );
  });

  it.skipIf(!realAddonBytes)(
    "failed replacement: rolls back, restoring the previously installed addon, no residue",
    async () => {
      const sentinel = Buffer.from(`sentinel-${process.pid}-rollback`);
      const { root, dest } = seededRoot(currentKey, sentinel);
      await withServer(
        {
          [assetLib.CHECKSUMS_ASSET_NAME]: sums([[currentAsset, realAddonBytes!]]),
          [currentAsset]: realAddonBytes!,
        },
        async (baseUrl) => {
          const run = await runFetch(baseUrl, currentKey, root, { CC_LHC_PREBUILD_TEST_FAIL: "install" });
          expect(run.status).not.toBe(0);
          expect(run.status).not.toBeNull();
          expect(run.stdout).toContain("addon verified live in subprocess");
          expect(run.stderr).toContain("test-injected replacement failure");
          expect(run.stderr).toContain("previously installed addon restored");
          expect(readFileSync(dest)).toEqual(sentinel);
          expect(residue(root, currentKey)).toEqual([]);
        },
      );
    },
  );

  it.skipIf(!realAddonBytes)(
    "success: probes the temp file live, replaces the old addon, cleans temp and backup",
    async () => {
      const sentinel = Buffer.from(`sentinel-${process.pid}-success`);
      const { root, dest } = seededRoot(currentKey, sentinel);
      await withServer(
        {
          [assetLib.CHECKSUMS_ASSET_NAME]: sums([[currentAsset, realAddonBytes!]]),
          [currentAsset]: realAddonBytes!,
        },
        async (baseUrl) => {
          const run = await runFetch(baseUrl, currentKey, root);
          expect(run.stderr).toBe("");
          expect(run.status).toBe(0);
          expect(run.stdout).toContain(`${currentAsset} checksum verified`);
          expect(run.stdout).toContain("addon verified live in subprocess");
          expect(run.stdout).toContain(`installed ${dest}`);
          expect(readFileSync(dest)).toEqual(realAddonBytes!);
          expect(residue(root, currentKey)).toEqual([]);
        },
      );
    },
  );

  it("foreign target: checksum only — an unloadable foreign artifact still installs cleanly", async () => {
    const foreignAsset = assetLib.assetNameForTarget(artifact, foreignKey) as string;
    const foreignBody = Buffer.from("foreign-target machine code this host cannot load");
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-fetch-http-"));
    await withServer(
      { [assetLib.CHECKSUMS_ASSET_NAME]: sums([[foreignAsset, foreignBody]]), [foreignAsset]: foreignBody },
      async (baseUrl) => {
        const run = await runFetch(baseUrl, foreignKey, root);
        expect(run.stderr).toBe("");
        expect(run.status).toBe(0);
        expect(run.stdout).toContain(`checksum-only for foreign target ${foreignKey}`);
        expect(run.stdout).not.toContain("verified live");
        expect(readFileSync(join(root, foreignKey, artifact))).toEqual(foreignBody);
        expect(residue(root, foreignKey)).toEqual([]);
      },
    );
  });
});
