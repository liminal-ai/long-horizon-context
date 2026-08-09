/**
 * Slice 2 correction: descriptor lifecycle + OS process identity ownership.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertReadyBinding,
  closeAndRemove,
  createOpeningDescriptor,
  loadDescriptor,
  markDegraded,
  markReady,
  newDescriptorPath,
  publishAtomic,
  revokeDescriptor,
  type DescriptorIo,
  type RuntimeDescriptorV1,
} from "../../src/runtime/descriptor.js";
import type { ProcessIdentity } from "../../src/runtime/process-identity.js";
import { readProcessIdentityLinux } from "../../src/runtime/process-identity.js";

function realIo(opts: {
  aliveIdentity?: ProcessIdentity | null | ((pid: number) => ProcessIdentity | null);
} = {}): DescriptorIo {
  const fs = require("node:fs") as typeof import("node:fs");
  const self = readProcessIdentityLinux(process.pid)!;
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
    readProcessIdentity: (pid) => {
      if (opts.aliveIdentity === undefined) {
        return pid === process.pid ? self : null;
      }
      if (typeof opts.aliveIdentity === "function") return opts.aliveIdentity(pid);
      return opts.aliveIdentity;
    },
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
    expect(statMode(path)).toBe(0o600);
    const loaded = loadDescriptor(path, io);
    expect(loaded.ok).toBe(true);
  });

  it("PID reuse with different starttime is stale", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-desc-reuse-"));
    const self = readProcessIdentityLinux(process.pid)!;
    const ioCreate = realIo({ aliveIdentity: self });
    const path = newDescriptorPath(root, ioCreate);
    createOpeningDescriptor(path, ioCreate);
    // Same pid, different starttime (reuse)
    const ioLoad = realIo({
      aliveIdentity: { ...self, starttime: String(Number(self.starttime) + 1) },
    });
    const loaded = loadDescriptor(path, ioLoad);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.reason).toMatch(/identity mismatch|stale/);
  });

  it("boot mismatch is stale", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-desc-boot-"));
    const self = readProcessIdentityLinux(process.pid)!;
    const ioCreate = realIo({ aliveIdentity: self });
    const path = newDescriptorPath(root, ioCreate);
    createOpeningDescriptor(path, ioCreate);
    const ioLoad = realIo({
      aliveIdentity: { ...self, bootId: "00000000-0000-0000-0000-000000000000" },
    });
    expect(loadDescriptor(path, ioLoad).ok).toBe(false);
  });

  it("forged nonce/time alone does not pass without identity match", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-desc-forge-"));
    const self = readProcessIdentityLinux(process.pid)!;
    const io = realIo({ aliveIdentity: self });
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

  it("missing/unreadable identity refuses (no PID-alive fallback)", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-desc-noid-"));
    const self = readProcessIdentityLinux(process.pid)!;
    const ioCreate = realIo({ aliveIdentity: self });
    const path = newDescriptorPath(root, ioCreate);
    createOpeningDescriptor(path, ioCreate);
    const ioLoad = realIo({ aliveIdentity: null });
    const loaded = loadDescriptor(path, ioLoad);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.reason).toMatch(/cannot establish current OS process identity/);
  });

  it("createOpeningDescriptor throws when identity unavailable", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-desc-throw-"));
    const io = realIo({ aliveIdentity: null });
    const path = newDescriptorPath(root, io);
    expect(() => createOpeningDescriptor(path, io)).toThrow(/cannot establish OS process identity/);
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
