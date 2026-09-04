/**
 * Exact file identity against the real compiled addon (LIM-145 Windows
 * background-shell adoption). Skipped without an artifact unless
 * CC_LHC_NATIVE_REQUIRE_ADDON=1; the native-platforms matrix sets it, so the
 * Windows lanes are the real proof of the Win32 file-id path.
 */

import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createExactFileIdentityReader,
  exactFileIdentitiesEqual,
  loadIdentityAddon,
  normalizeNativeFileResult,
  readExactFileIdentity,
} from "../src/index.js";

const requireAddon = process.env.CC_LHC_NATIVE_REQUIRE_ADDON === "1";

const addonLoad = ((): { ok: true } | { ok: false; message: string } => {
  try {
    loadIdentityAddon();
    return { ok: true };
  } catch (cause) {
    return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
  }
})();

it("file identity addon availability contract", () => {
  if (requireAddon)
    expect(addonLoad, "CC_LHC_NATIVE_REQUIRE_ADDON=1 but the addon did not load").toMatchObject({ ok: true });
});

describe("normalizeNativeFileResult fails closed", () => {
  it("accepts only the documented shape", () => {
    expect(normalizeNativeFileResult({ ok: true, path: "/p", volumeId: "1", fileId: "ino:2" }, "/p", "linux")).toEqual({
      ok: true,
      identity: { platform: "linux", path: "/p", volumeId: "1", fileId: "ino:2" },
    });
    expect(
      normalizeNativeFileResult(
        { ok: true, path: "/p", volumeId: "1", fileId: `id128:${"ab".repeat(16)}` },
        "/p",
        "win32",
      ).ok,
    ).toBe(true);
    expect(
      normalizeNativeFileResult({ ok: true, path: "/p", volumeId: "1", fileId: "index64:7" }, "/p", "win32").ok,
    ).toBe(true);
    for (const bad of [
      null,
      [],
      { ok: true, path: "/other", volumeId: "1", fileId: "ino:2" },
      { ok: true, path: "/p", volumeId: 1, fileId: "ino:2" },
      { ok: true, path: "/p", volumeId: "1", fileId: "2" },
      { ok: true, path: "/p", volumeId: "1", fileId: "id128:zz" },
      { ok: "yes" },
    ]) {
      expect(normalizeNativeFileResult(bad, "/p", "linux")).toMatchObject({ ok: false, code: "native_error" });
    }
    expect(normalizeNativeFileResult({ ok: false, code: "not_a_file", message: "dir" }, "/p", "linux")).toEqual({
      ok: false,
      code: "not_a_file",
      message: "dir",
    });
    expect(normalizeNativeFileResult({ ok: false, code: "weird" }, "/p", "linux")).toMatchObject({
      ok: false,
      code: "native_error",
    });
  });
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "cc-lhc-file-identity-"));
  dirs.push(dir);
  return dir;
}

describe.skipIf(!addonLoad.ok)("native file identity (compiled addon, production defaults)", () => {
  it("reads a file's identity from the opened object and is stable across re-reads and appends", () => {
    const dir = scratch();
    const path = join(dir, "task.output");
    writeFileSync(path, "line 1\n");
    const first = readExactFileIdentity(path);
    expect(first.ok, JSON.stringify(first)).toBe(true);
    if (!first.ok) return;
    expect(first.identity.platform).toBe(process.platform);
    expect(first.identity.path).toBe(path);
    expect(first.identity.volumeId).toMatch(/^\d+$/);
    expect(first.identity.fileId).toMatch(
      process.platform === "win32" ? /^(id128:[0-9a-f]{32}|index64:\d+)$/ : /^ino:\d+$/,
    );
    appendFileSync(path, "line 2\n");
    const again = readExactFileIdentity(path);
    expect(again.ok && exactFileIdentitiesEqual(first.identity, again.identity)).toBe(true);
    // A seam-built reader with production defaults agrees with the default reader.
    const seamRead = createExactFileIdentityReader()(path);
    expect(seamRead.ok && exactFileIdentitiesEqual(first.identity, seamRead.identity)).toBe(true);
  });

  it("a replaced file at the same path is a different identity; the held original keeps its own", () => {
    const dir = scratch();
    const path = join(dir, "task.output");
    writeFileSync(path, "original\n");
    const original = readExactFileIdentity(path);
    expect(original.ok).toBe(true);
    if (!original.ok) return;
    // Hold the original under another name so its object cannot be recycled, then reuse the path.
    const held = join(dir, "task.output.held");
    renameSync(path, held);
    writeFileSync(path, "replacement\n");
    const replacement = readExactFileIdentity(path);
    expect(replacement.ok).toBe(true);
    if (!replacement.ok) return;
    expect(exactFileIdentitiesEqual(original.identity, replacement.identity)).toBe(false);
    const heldRead = readExactFileIdentity(held);
    expect(
      heldRead.ok &&
        heldRead.identity.volumeId === original.identity.volumeId &&
        heldRead.identity.fileId === original.identity.fileId,
    ).toBe(true);
  });

  it("refuses what is not a regular file and reports a missing path as not_found", () => {
    const dir = scratch();
    expect(readExactFileIdentity(join(dir, "absent.output"))).toMatchObject({ ok: false, code: "not_found" });
    expect(readExactFileIdentity(join(dir, "absent", "deeper.output"))).toMatchObject({ ok: false, code: "not_found" });
    mkdirSync(join(dir, "a-dir"));
    expect(readExactFileIdentity(join(dir, "a-dir"))).toMatchObject({ ok: false, code: "not_a_file" });
    expect(readExactFileIdentity("")).toMatchObject({ ok: false, code: "invalid_path" });
    expect(readExactFileIdentity("a\0b")).toMatchObject({ ok: false, code: "invalid_path" });
  });
});

describe.skipIf(!addonLoad.ok || process.platform === "win32")("POSIX parity with stat(2)", () => {
  it("volumeId is st_dev and fileId is the inode Node reports", () => {
    const dir = scratch();
    const path = join(dir, "parity.output");
    writeFileSync(path, "x");
    const st = statSync(path, { bigint: true });
    const read = readExactFileIdentity(path);
    expect(read.ok && read.identity).toMatchObject({ volumeId: st.dev.toString(), fileId: `ino:${st.ino.toString()}` });
  });
});

describe.skipIf(!addonLoad.ok || process.platform !== "win32")(
  "win32: identity is the Win32 file object id, not Node's dev/ino",
  () => {
    it("prefers the 128-bit FileIdInfo on NTFS/ReFS and never reports an inode", () => {
      const dir = scratch();
      const path = join(dir, "win.output");
      writeFileSync(path, "x");
      const read = readExactFileIdentity(path);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.identity.fileId.startsWith("ino:")).toBe(false);
      expect(read.identity.fileId).toMatch(/^(id128:[0-9a-f]{32}|index64:\d+)$/);
      expect(BigInt(read.identity.volumeId)).toBeGreaterThan(0n);
    });
  },
);
