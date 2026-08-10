/**
 * Tests against the real compiled addon — the production-default path with no
 * injected seams. Skipped when no artifact is present unless
 * CC_LHC_NATIVE_REQUIRE_ADDON=1 (CI matrix sets it so a missing build step
 * fails loudly instead of skipping silently).
 */

import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  createExactIdentityReader,
  exactIdentitiesEqual,
  loadIdentityAddon,
  readExactProcessIdentity,
  toPortableProcessIdentity,
} from "../src/index.js";

const requireAddon = process.env.CC_LHC_NATIVE_REQUIRE_ADDON === "1";

const addonLoad = ((): { ok: true; source: string } | { ok: false; message: string } => {
  try {
    const loaded = loadIdentityAddon();
    return { ok: true, source: loaded.source };
  } catch (cause) {
    return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
  }
})();

it("addon availability contract", () => {
  if (requireAddon) {
    expect(addonLoad, "CC_LHC_NATIVE_REQUIRE_ADDON=1 but the addon did not load").toMatchObject({
      ok: true,
    });
  }
});

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
  });
}

describe.skipIf(!addonLoad.ok)("native identity (compiled addon, production defaults)", () => {
  it("reads self identity exactly", () => {
    const result = readExactProcessIdentity(process.pid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.platform).toBe(process.platform);
    expect(result.identity.pid).toBe(process.pid);
    expect(result.identity.bootId.length).toBeGreaterThanOrEqual(8);
    expect(/^\d+$/.test(result.identity.starttime)).toBe(true);
  });

  it("is stable across repeated reads of the same process", () => {
    const a = readExactProcessIdentity(process.pid);
    const b = readExactProcessIdentity(process.pid);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(exactIdentitiesEqual(a.identity, b.identity)).toBe(true);
  });

  it("reads a live child and refuses it after exit (no PID-alive fallback)", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    expect(child.pid).toBeDefined();
    const pid = child.pid!;
    const live = readExactProcessIdentity(pid);
    expect(live.ok).toBe(true);
    if (live.ok) {
      expect(live.identity.pid).toBe(pid);
    }
    child.kill("SIGKILL");
    await waitForExit(child);
    const dead = readExactProcessIdentity(pid);
    expect(dead).toMatchObject({ ok: false, code: "not_found" });
  });

  it("returns not_found for a pid that cannot exist", () => {
    expect(readExactProcessIdentity(2_147_000_000)).toMatchObject({ ok: false, code: "not_found" });
  });

  it("rejects invalid pids without consulting the kernel", () => {
    expect(readExactProcessIdentity(0)).toMatchObject({ ok: false, code: "invalid_pid" });
    expect(readExactProcessIdentity(-5)).toMatchObject({ ok: false, code: "invalid_pid" });
    expect(readExactProcessIdentity(1.25)).toMatchObject({ ok: false, code: "invalid_pid" });
  });

  it("projects to the portable descriptor schema", () => {
    const result = readExactProcessIdentity(process.pid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const portable = toPortableProcessIdentity(result.identity);
    expect(portable).toEqual({
      pid: result.identity.pid,
      bootId: result.identity.bootId,
      starttime: result.identity.starttime,
    });
    expect(Object.keys(portable)).toEqual(["pid", "bootId", "starttime"]);
  });

  it("seam-built reader with production defaults agrees with the default reader", () => {
    const read = createExactIdentityReader();
    const a = read(process.pid);
    const b = readExactProcessIdentity(process.pid);
    expect(a).toEqual(b);
  });
});

describe.skipIf(!addonLoad.ok || process.platform !== "linux")("linux parity with kernel ground truth", () => {
  it("bootId matches /proc/sys/kernel/random/boot_id exactly", () => {
    const expected = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const result = readExactProcessIdentity(process.pid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.bootId).toBe(expected);
  });

  it("starttime matches field 22 of /proc/self/stat exactly", () => {
    const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const fields = stat
      .slice(close + 1)
      .trim()
      .split(/\s+/);
    const expected = fields[19]!;
    expect(/^\d+$/.test(expected)).toBe(true);
    const result = readExactProcessIdentity(process.pid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.starttime).toBe(expected);
  });
});
