/**
 * XP2: cc-lhc-native as the production-default exact identity provider.
 *
 * Part 1 — deterministic mapping invariants over injected readers: exact
 * match/mismatch/not_found/fail-closed semantics, actionable remediation.
 * Part 2 — the real compiled addon through production-default loading.
 * All Part 2 assertions are platform neutral (they hold on native Linux,
 * macOS, and Windows); kernel ground-truth parity with /proc is a separate
 * Linux-conditional block. Loader seams pass `env: {}` so the suite-wide
 * CC_LHC_IDENTITY_ADDON stub can never mask the real artifact — proven
 * explicitly below. Skipped only when no artifact is built;
 * CC_LHC_NATIVE_REQUIRE_ADDON=1 turns silent skip into loud failure (the
 * production-default gate for CI matrix jobs).
 */

import { type ChildProcess, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { IDENTITY_ADDON_ENV, loadIdentityAddon, resolveAddonArtifact } from "cc-lhc-native";
import { describe, expect, it } from "vitest";

import {
  createOpeningDescriptor,
  type DescriptorIo,
  defaultDescriptorIo,
  loadDescriptor,
  newDescriptorPath,
} from "../../src/runtime/descriptor.js";
import { createNativeIdentityProbe, probeFromExactReader } from "../../src/runtime/native-identity.js";
import { identitiesEqual, readProcessIdentityLinux } from "../../src/runtime/process-identity.js";
import { acquireSessionOwner, SessionOwnershipConflictError } from "../../src/runtime/session-owner.js";
import { STUB_BOOT_ID } from "../helpers/identity.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("probeFromExactReader mapping (deterministic)", () => {
  const identity = {
    platform: "linux" as const,
    pid: 4242,
    bootId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    starttime: "123456789",
  };

  it("ok projects to the stored pid+bootId+starttime schema (platform dropped)", () => {
    const probe = probeFromExactReader(() => ({ ok: true, identity }));
    const r = probe(4242);
    expect(r).toEqual({
      ok: true,
      identity: { pid: 4242, bootId: identity.bootId, starttime: identity.starttime },
    });
  });

  it("not_found stays not_found (kernel-proven dead, reclaimable)", () => {
    const probe = probeFromExactReader(() => ({
      ok: false,
      code: "not_found",
      message: "no such process",
    }));
    const r = probe(4242);
    expect(r).toMatchObject({ ok: false, code: "not_found" });
  });

  it.each([
    "invalid_pid",
    "access_denied",
    "native_error",
  ] as const)("%s maps to indeterminate (fail closed)", (code) => {
    const probe = probeFromExactReader(() => ({ ok: false, code, message: "boom" }));
    const r = probe(4242);
    expect(r).toMatchObject({ ok: false, code: "indeterminate" });
    if (!r.ok) expect(r.message).toContain(code);
  });

  it.each([
    "addon_unavailable",
    "unsupported_platform",
  ] as const)("%s maps to indeterminate with actionable remediation", (code) => {
    const probe = probeFromExactReader(() => ({ ok: false, code, message: "no artifact" }));
    const r = probe(4242);
    expect(r).toMatchObject({ ok: false, code: "indeterminate" });
    if (!r.ok) {
      expect(r.message).toContain(code);
      expect(r.message).toContain("pnpm --config.verify-deps-before-run=false --filter cc-lhc-native run build:native");
      expect(r.message).toContain(
        "pnpm --config.verify-deps-before-run=false --filter cc-lhc-native run stage:prebuild",
      );
      expect(r.message).toMatch(/will not fall back to PID-only/);
    }
  });
});

describe("createNativeIdentityProbe loader failures (real loader, seams)", () => {
  it("missing artifact on a supported platform is indeterminate with both candidate paths", () => {
    const bareRoot = mkdtempSync(join(tmpdir(), "cc-lhc-native-bare-"));
    copyFileSync(join(here, "../../../cc-lhc-native/targets.json"), join(bareRoot, "targets.json"));
    const probe = createNativeIdentityProbe({ packageRoot: bareRoot, env: {} });
    const r = probe(process.pid);
    expect(r).toMatchObject({ ok: false, code: "indeterminate" });
    if (!r.ok) {
      expect(r.message).toContain("addon_unavailable");
      expect(r.message).toContain("prebuilds");
      expect(r.message).toContain("pnpm --config.verify-deps-before-run=false --filter cc-lhc-native run build:native");
    }
  });

  it("unsupported platform target is indeterminate and lists the supported set", () => {
    const probe = createNativeIdentityProbe({ platform: "sunos", arch: "sparc", env: {} });
    const r = probe(process.pid);
    expect(r).toMatchObject({ ok: false, code: "indeterminate" });
    if (!r.ok) {
      expect(r.message).toContain("unsupported_platform");
      expect(r.message).toContain("linux-x64");
    }
  });

  it("loader failure is stable across calls and never throws", () => {
    const probe = createNativeIdentityProbe({ platform: "sunos", arch: "sparc", env: {} });
    expect(probe(process.pid)).toEqual(probe(process.pid));
  });
});

// ---------------------------------------------------------------------------
// Real compiled addon — production-default resolution (prebuilds/ or
// build/Release under the real package root). `env: {}` removes only the
// test-suite stub override; everything else is the production path.
// ---------------------------------------------------------------------------

const requireAddon = process.env.CC_LHC_NATIVE_REQUIRE_ADDON === "1";
const realProbe = createNativeIdentityProbe({ env: {} });
const selfProbeResult = realProbe(process.pid);

it("real addon availability contract", () => {
  if (requireAddon) {
    expect(
      selfProbeResult.ok,
      `CC_LHC_NATIVE_REQUIRE_ADDON=1 but the production-default addon did not serve an identity: ${
        selfProbeResult.ok ? "" : selfProbeResult.message
      }`,
    ).toBe(true);
  }
});

it("the suite-wide stub override cannot mask real-addon resolution", () => {
  // The vitest env pins the stub through the documented loader env seam…
  expect(process.env[IDENTITY_ADDON_ENV]).toMatch(/stub-identity-addon\.cjs$/);
  const withEnv = resolveAddonArtifact({});
  expect(withEnv.source).toBe("env-override");
  // …and the real-addon tests resolve with env:{} — the override is
  // structurally unreachable there, on every platform.
  if (selfProbeResult.ok) {
    const withoutEnv = resolveAddonArtifact({ env: {} });
    expect(withoutEnv.source).not.toBe("env-override");
    expect(["prebuilt", "source-build"]).toContain(loadIdentityAddon({ env: {} }).source);
  }
});

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
  });
}

describe.skipIf(!selfProbeResult.ok)("real compiled addon (production default, platform neutral)", () => {
  function nativeIo(): DescriptorIo {
    return {
      ...defaultDescriptorIo(),
      readProcessIdentity: realProbe,
    };
  }

  it("serves an exact self identity, distinct from the stub's synthetic one", () => {
    if (!selfProbeResult.ok) return;
    const id = selfProbeResult.identity;
    expect(id.pid).toBe(process.pid);
    expect(id.bootId.length).toBeGreaterThanOrEqual(8);
    expect(/^\d+$/.test(id.starttime)).toBe(true);
    // Kernel-derived identity can never equal the stub's synthetic constant:
    // if it did, the stub would be masking the real addon.
    expect(id.bootId).not.toBe(STUB_BOOT_ID);
  });

  it("is stable across repeated reads", () => {
    const again = realProbe(process.pid);
    expect(again.ok).toBe(true);
    if (!again.ok || !selfProbeResult.ok) return;
    expect(identitiesEqual(again.identity, selfProbeResult.identity)).toBe(true);
  });

  it("proves a dead child not_found (reclaimable), never PID-alive", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const pid = child.pid!;
    const live = realProbe(pid);
    expect(live.ok).toBe(true);
    child.kill("SIGKILL");
    await waitForExit(child);
    const dead = realProbe(pid);
    expect(dead).toMatchObject({ ok: false, code: "not_found" });
  });

  it("descriptor round trip entirely through the native probe", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-native-rt-"));
    const io = nativeIo();
    const path = newDescriptorPath(root, io);
    const desc = createOpeningDescriptor(path, io);
    expect(desc.processIdentity.pid).toBe(process.pid);
    expect(loadDescriptor(path, io).ok).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  it("session-owner lease acquire/conflict/release through the native probe", () => {
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-native-owner-"));
    const lease = acquireSessionOwner("native-session", { home, readIdentity: realProbe });
    expect(() => acquireSessionOwner("native-session", { home, readIdentity: realProbe })).toThrow(
      SessionOwnershipConflictError,
    );
    lease.release();
    const again = acquireSessionOwner("native-session", { home, readIdentity: realProbe });
    again.release();
  });
});

describe.skipIf(!selfProbeResult.ok || process.platform !== "linux")(
  "real compiled addon — Linux kernel ground truth",
  () => {
    it("self identity matches the legacy Linux /proc reader exactly (existing descriptors stay valid)", () => {
      const legacy = readProcessIdentityLinux(process.pid);
      expect(legacy).not.toBeNull();
      if (!selfProbeResult.ok) return;
      expect(identitiesEqual(selfProbeResult.identity, legacy!)).toBe(true);
    });

    it("descriptor written by the legacy Linux reader loads under the native probe", () => {
      const root = mkdtempSync(join(tmpdir(), "cc-lhc-native-compat-"));
      const legacy = readProcessIdentityLinux(process.pid)!;
      const legacyIo: DescriptorIo = {
        ...defaultDescriptorIo(),
        readProcessIdentity: () => ({ ok: true, identity: legacy }),
      };
      const path = newDescriptorPath(root, legacyIo);
      createOpeningDescriptor(path, legacyIo);
      const nativeIo: DescriptorIo = { ...defaultDescriptorIo(), readProcessIdentity: realProbe };
      const loaded = loadDescriptor(path, nativeIo);
      expect(loaded.ok).toBe(true);
    });
  },
);
