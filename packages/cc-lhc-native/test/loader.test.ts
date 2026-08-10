import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  AddonArtifactMissingError,
  AddonContractError,
  createExactIdentityReader,
  IDENTITY_ADDON_ENV,
  IDENTITY_CONTRACT_VERSION,
  type LoaderSeams,
  loadIdentityAddon,
  parseTargetsManifest,
  resolveAddonArtifact,
  UnsupportedPlatformTargetError,
} from "../src/index.js";

const manifest = parseTargetsManifest({
  name: "cc-lhc-native",
  napiVersion: 8,
  artifact: "cc_lhc_identity.node",
  targets: [
    { platform: "linux", arch: "x64" },
    { platform: "darwin", arch: "arm64" },
    { platform: "win32", arch: "x64" },
  ],
});

const root = "/pkg";
const prebuiltFor = (platform: string, arch: string): string =>
  join(root, "prebuilds", `${platform}-${arch}`, "cc_lhc_identity.node");
const devBuild = join(root, "build", "Release", "cc_lhc_identity.node");

function seams(overrides: Partial<LoaderSeams> & { existing?: string[] }): LoaderSeams {
  const { existing = [], ...rest } = overrides;
  return {
    platform: "darwin",
    arch: "arm64",
    packageRoot: root,
    env: {},
    manifest,
    exists: (path) => existing.includes(path),
    ...rest,
  };
}

describe("resolveAddonArtifact", () => {
  it("selects the exact platform/arch prebuilt (released path)", () => {
    const resolved = resolveAddonArtifact(seams({ existing: [prebuiltFor("darwin", "arm64"), devBuild] }));
    expect(resolved).toEqual({ path: prebuiltFor("darwin", "arm64"), source: "prebuilt" });
  });

  it("falls back to the source build when no prebuilt exists (dev path)", () => {
    const resolved = resolveAddonArtifact(seams({ existing: [devBuild] }));
    expect(resolved).toEqual({ path: devBuild, source: "source-build" });
  });

  it("never serves another target's prebuilt", () => {
    const resolved = resolveAddonArtifact(
      seams({ platform: "win32", arch: "x64", existing: [prebuiltFor("darwin", "arm64"), devBuild] }),
    );
    expect(resolved).toEqual({ path: devBuild, source: "source-build" });
  });

  it("fails explicitly for platforms outside the manifest, listing supported targets", () => {
    let caught: unknown;
    try {
      resolveAddonArtifact(seams({ platform: "freebsd", arch: "x64", existing: [devBuild] }));
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(UnsupportedPlatformTargetError);
    expect((caught as Error).message).toContain("freebsd-x64");
    expect((caught as Error).message).toContain("linux-x64");
    expect((caught as Error).message).toContain("darwin-arm64");
    expect((caught as Error).message).toContain("win32-x64");
  });

  it("fails explicitly for unsupported arch on a supported platform", () => {
    expect(() => resolveAddonArtifact(seams({ platform: "linux", arch: "arm64", existing: [devBuild] }))).toThrow(
      UnsupportedPlatformTargetError,
    );
  });

  it("fails explicitly when a supported target has no artifact, naming both paths", () => {
    let caught: unknown;
    try {
      resolveAddonArtifact(seams({ existing: [] }));
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(AddonArtifactMissingError);
    expect((caught as Error).message).toContain(prebuiltFor("darwin", "arm64"));
    expect((caught as Error).message).toContain(devBuild);
    expect((caught as Error).message).toContain(
      "pnpm --config.verify-deps-before-run=false --filter cc-lhc-native run build:native",
    );
  });

  it("honors the env override and requires it to exist", () => {
    const override = "/custom/identity.node";
    const resolved = resolveAddonArtifact(seams({ env: { [IDENTITY_ADDON_ENV]: override }, existing: [override] }));
    expect(resolved).toEqual({ path: override, source: "env-override" });
    expect(() => resolveAddonArtifact(seams({ env: { [IDENTITY_ADDON_ENV]: override }, existing: [] }))).toThrow(
      AddonArtifactMissingError,
    );
  });
});

describe("loadIdentityAddon contract validation", () => {
  const goodAddon = {
    platform: "darwin",
    identityContractVersion: IDENTITY_CONTRACT_VERSION,
    readProcessIdentity: () => ({ ok: false, code: "not_found", message: "stub" }),
  };

  it("loads and validates a conforming addon", () => {
    const loaded = loadIdentityAddon(seams({ existing: [prebuiltFor("darwin", "arm64")], loadAddon: () => goodAddon }));
    expect(loaded.source).toBe("prebuilt");
    expect(loaded.addon.platform).toBe("darwin");
  });

  it("rejects addons without the expected export shape", () => {
    expect(() => loadIdentityAddon(seams({ existing: [devBuild], loadAddon: () => "junk" }))).toThrow(
      AddonContractError,
    );
    expect(() => loadIdentityAddon(seams({ existing: [devBuild], loadAddon: () => ({}) }))).toThrow(
      /readProcessIdentity/,
    );
  });

  it("rejects contract-version mismatches", () => {
    expect(() =>
      loadIdentityAddon(
        seams({ existing: [devBuild], loadAddon: () => ({ ...goodAddon, identityContractVersion: 99 }) }),
      ),
    ).toThrow(/contract version/);
  });

  it("rejects artifacts compiled for another platform", () => {
    expect(() =>
      loadIdentityAddon(seams({ existing: [devBuild], loadAddon: () => ({ ...goodAddon, platform: "linux" }) })),
    ).toThrow(/compiled for/);
  });

  it("wraps loader dlopen failures as AddonContractError", () => {
    expect(() =>
      loadIdentityAddon(
        seams({
          existing: [devBuild],
          loadAddon: () => {
            throw new Error("invalid ELF header");
          },
        }),
      ),
    ).toThrow(/invalid ELF header/);
  });
});

describe("createExactIdentityReader fail-closed mapping", () => {
  it("maps unsupported platforms to a result, not a throw", () => {
    const read = createExactIdentityReader(seams({ platform: "freebsd", arch: "x64" }));
    const result = read(1234);
    expect(result).toMatchObject({ ok: false, code: "unsupported_platform" });
  });

  it("maps missing artifacts to addon_unavailable", () => {
    const read = createExactIdentityReader(seams({ existing: [] }));
    expect(read(1234)).toMatchObject({ ok: false, code: "addon_unavailable" });
  });

  it("rejects invalid pids before touching the addon", () => {
    const read = createExactIdentityReader(seams({ existing: [] }));
    expect(read(0)).toMatchObject({ ok: false, code: "invalid_pid" });
    expect(read(-1)).toMatchObject({ ok: false, code: "invalid_pid" });
    expect(read(1.5)).toMatchObject({ ok: false, code: "invalid_pid" });
  });

  it("fails closed on malformed native results", () => {
    const junkAddon = {
      platform: "darwin",
      identityContractVersion: IDENTITY_CONTRACT_VERSION,
      readProcessIdentity: () => ({ ok: true, pid: 999, bootId: "boot-uuid", starttime: "123" }),
    };
    const read = createExactIdentityReader(seams({ existing: [devBuild], loadAddon: () => junkAddon }));
    // Echoed pid disagrees with the queried pid — must not be trusted.
    expect(read(1234)).toMatchObject({ ok: false, code: "native_error" });
  });

  it("passes through exact identities and preserves failure codes", () => {
    const addon = {
      platform: "darwin",
      identityContractVersion: IDENTITY_CONTRACT_VERSION,
      readProcessIdentity: (pid: number) =>
        pid === 42
          ? { ok: true, pid: 42, bootId: "11111111-2222", starttime: "987654321" }
          : { ok: false, code: "access_denied", message: "nope" },
    };
    const read = createExactIdentityReader(seams({ existing: [devBuild], loadAddon: () => addon }));
    expect(read(42)).toEqual({
      ok: true,
      identity: { platform: "darwin", pid: 42, bootId: "11111111-2222", starttime: "987654321" },
    });
    expect(read(43)).toEqual({ ok: false, code: "access_denied", message: "nope" });
  });
});
