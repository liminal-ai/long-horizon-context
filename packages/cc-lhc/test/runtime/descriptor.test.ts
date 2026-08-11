/**
 * Slice 2 correction: descriptor lifecycle + OS process identity ownership.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertReadyBinding,
  closeAndRemove,
  createOpeningDescriptor,
  type DescriptorIo,
  loadDescriptor,
  markDegraded,
  markReady,
  newDescriptorPath,
  publishAtomic,
  revokeDescriptor,
} from "../../src/runtime/descriptor.js";
import { type ProbeProcessIdentity, ProcessIdentityUnavailableError } from "../../src/runtime/process-identity.js";
import { aliveResult, indeterminateResult, notFoundResult, selfIdentity, selfOnlyProbe } from "../helpers/identity.js";

function realIo(opts: { probe?: ProbeProcessIdentity } = {}): DescriptorIo {
  const fs = require("node:fs") as typeof import("node:fs");
  return {
    writeFile: (p, d, m) => fs.writeFileSync(p, d, { encoding: "utf8", mode: m }),
    readFile: (p) => fs.readFileSync(p, "utf8"),
    rename: fs.renameSync,
    unlink: (p) => {
      try {
        fs.unlinkSync(p);
      } catch {
        // ignore
      }
    },
    exists: fs.existsSync,
    mkdir: (p) => fs.mkdirSync(p, { recursive: true, mode: 0o700 }),
    chmod: fs.chmodSync,
    readProcessIdentity: opts.probe ?? selfOnlyProbe(),
    nowMs: () => 1_700_000_000_000,
    randomId: () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    pid: process.pid,
  };
}

describe("runtime descriptor identity", () => {
  it("creates opening descriptor mode 0600 with processIdentity", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-desc-"));
    const io = realIo();
    const path = newDescriptorPath(root, io);
    const desc = createOpeningDescriptor(path, io);
    expect(desc.state).toBe("opening");
    expect(desc.processIdentity.pid).toBe(process.pid);
    expect(desc.processIdentity.starttime).toMatch(/^\d+$/);
    // Confidentiality contract is platform-split: POSIX enforces the exact
    // 0600 mode; Windows has no meaningful POSIX mode bits, so no mode is
    // asserted there — the enforced contract is the in-profile location
    // policy (resolveCcLhcHome, covered in test/intake/paths.test.ts) plus
    // the profile's default ACLs. No bespoke DACL is installed or claimed.
    if (process.platform !== "win32") {
      expect(statMode(path)).toBe(0o600);
    }
    const loaded = loadDescriptor(path, io);
    expect(loaded.ok).toBe(true);
  });

  it("PID reuse with different starttime is stale", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-desc-reuse-"));
    const self = selfIdentity();
    const ioCreate = realIo({ probe: () => aliveResult(self) });
    const path = newDescriptorPath(root, ioCreate);
    createOpeningDescriptor(path, ioCreate);
    // Same pid, different starttime (reuse)
    const ioLoad = realIo({
      probe: () => aliveResult({ ...self, starttime: String(Number(self.starttime) + 1) }),
    });
    const loaded = loadDescriptor(path, ioLoad);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.reason).toMatch(/identity mismatch|stale/);
  });

  it("boot mismatch is stale", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-desc-boot-"));
    const self = selfIdentity();
    const ioCreate = realIo({ probe: () => aliveResult(self) });
    const path = newDescriptorPath(root, ioCreate);
    createOpeningDescriptor(path, ioCreate);
    const ioLoad = realIo({
      probe: () => aliveResult({ ...self, bootId: "00000000-0000-0000-0000-000000000000" }),
    });
    expect(loadDescriptor(path, ioLoad).ok).toBe(false);
  });

  it("forged nonce/time alone does not pass without identity match", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-desc-forge-"));
    const self = selfIdentity();
    const io = realIo({ probe: () => aliveResult(self) });
    const path = newDescriptorPath(root, io);
    const desc = createOpeningDescriptor(path, io);
    // Tamper incarnation and wrapperStartedAtMs but keep processIdentity
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    raw.incarnation = "forged-nonce-value-xxxxx";
    raw.wrapperStartedAtMs = 1;
    writeFileSync(path, JSON.stringify(raw), { mode: 0o600 });
    // Still ok if identity matches
    expect(loadDescriptor(path, io).ok).toBe(true);
    // Forge processIdentity starttime
    raw.processIdentity = { ...desc.processIdentity, starttime: "1" };
    writeFileSync(path, JSON.stringify(raw), { mode: 0o600 });
    expect(loadDescriptor(path, io).ok).toBe(false);
  });

  it("kernel-proven not_found owner refuses as stale", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-desc-dead-"));
    const self = selfIdentity();
    const ioCreate = realIo({ probe: () => aliveResult(self) });
    const path = newDescriptorPath(root, ioCreate);
    createOpeningDescriptor(path, ioCreate);
    const ioLoad = realIo({ probe: (pid) => notFoundResult(pid) });
    const loaded = loadDescriptor(path, ioLoad);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.reason).toMatch(/stale.*not found/);
  });

  it("indeterminate identity refuses without claiming stale and leaves the file (no PID-alive fallback)", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-desc-noid-"));
    const self = selfIdentity();
    const ioCreate = realIo({ probe: () => aliveResult(self) });
    const path = newDescriptorPath(root, ioCreate);
    createOpeningDescriptor(path, ioCreate);
    const ioLoad = realIo({ probe: () => indeterminateResult("access_denied: kernel refused") });
    const loaded = loadDescriptor(path, ioLoad);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.reason).toMatch(/cannot establish current OS process identity/);
      expect(loaded.reason).not.toMatch(/stale/);
    }
    // Fail closed means refuse only — the descriptor must not be touched.
    expect(existsSync(path)).toBe(true);
  });

  it("createOpeningDescriptor throws typed error when identity unavailable", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-desc-throw-"));
    const io = realIo({ probe: () => indeterminateResult("addon_unavailable: no artifact") });
    const path = newDescriptorPath(root, io);
    expect(() => createOpeningDescriptor(path, io)).toThrow(ProcessIdentityUnavailableError);
    expect(() => createOpeningDescriptor(path, io)).toThrow(/cannot establish OS process identity.*no artifact/);
  });

  it("atomic publish leaves no partial final file on write failure", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-desc-atom-"));
    const path = join(root, "d.json");
    let writes = 0;
    const io: DescriptorIo = {
      ...realIo(),
      writeFile: (p, data, mode) => {
        writes += 1;
        if (writes === 1) throw new Error("disk full");
        writeFileSync(p, data, { encoding: "utf8", mode });
      },
    };
    expect(() => publishAtomic(path, '{"x":1}\n', io)).toThrow(/disk full/);
    expect(existsSync(path)).toBe(false);
  });

  it("markDegraded publish failure + successful unlink → safe absent", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-desc-degfail-"));
    const ioBase = realIo();
    const path = newDescriptorPath(root, ioBase);
    let desc = createOpeningDescriptor(path, ioBase);
    desc = markReady(path, desc, {
      threadId: "th_x",
      registryPath: join(root, "r.sqlite"),
      sessionId: "sid",
      rolloutPath: join(root, "sid.jsonl"),
    });
    let renames = 0;
    const ioFail: DescriptorIo = {
      ...ioBase,
      rename: () => {
        renames += 1;
        throw new Error("rename fail");
      },
    };
    // Checked revoke: publish fails, unlink succeeds → proven absent (no throw)
    const out = markDegraded(path, desc, "x", ioFail);
    expect(out.state).toBe("degraded");
    expect(existsSync(path)).toBe(false);
    expect(renames).toBeGreaterThanOrEqual(1);
  });

  it("revokeDescriptor removes ready file", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-desc-rev-"));
    const io = realIo();
    const path = newDescriptorPath(root, io);
    let desc = createOpeningDescriptor(path, io);
    desc = markReady(path, desc, {
      threadId: "th_x",
      registryPath: join(root, "r.sqlite"),
      sessionId: "sid",
      rolloutPath: join(root, "sid.jsonl"),
    });
    revokeDescriptor(path, undefined, io);
    expect(existsSync(path)).toBe(false);
    expect(assertReadyBinding(desc).ok).toBe(true); // in-memory only
  });

  it("closeAndRemove unlinks", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-desc-close-"));
    const io = realIo();
    const path = newDescriptorPath(root, io);
    const desc = createOpeningDescriptor(path, io);
    closeAndRemove(path, desc, io);
    expect(existsSync(path)).toBe(false);
  });
});

function statMode(path: string): number {
  return require("node:fs").statSync(path).mode & 0o777;
}
