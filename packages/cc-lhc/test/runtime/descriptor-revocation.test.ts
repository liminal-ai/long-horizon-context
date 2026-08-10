/**
 * Checked revocation, illegal transitions, publish+unlink double failure.
 */

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertLegalTransition,
  createOpeningDescriptor,
  type DescriptorIo,
  loadDescriptor,
  markClosed,
  markDegraded,
  markReady,
  newDescriptorPath,
  type RuntimeDescriptorV1,
  revokeCapability,
} from "../../src/runtime/descriptor.js";
import { selfOnlyProbe } from "../helpers/identity.js";

function io(opts: { failWrite?: boolean; failUnlink?: boolean } = {}): DescriptorIo {
  const fs = require("node:fs") as typeof import("node:fs");
  return {
    writeFile: (p, d, m) => {
      if (opts.failWrite) throw new Error("write fail");
      fs.writeFileSync(p, d, { encoding: "utf8", mode: m });
    },
    readFile: (p) => fs.readFileSync(p, "utf8"),
    rename: (from, to) => {
      if (opts.failWrite) throw new Error("rename fail");
      fs.renameSync(from, to);
    },
    unlink: (p) => {
      if (opts.failUnlink) throw new Error("unlink fail");
      fs.unlinkSync(p);
    },
    exists: fs.existsSync,
    mkdir: (p) => fs.mkdirSync(p, { recursive: true, mode: 0o700 }),
    chmod: fs.chmodSync,
    readProcessIdentity: selfOnlyProbe(),
    nowMs: () => Date.now(),
    randomId: () => `r-${Math.random().toString(16).slice(2)}`,
    pid: process.pid,
  };
}

function readyDesc(root: string, dIo: DescriptorIo): { path: string; desc: RuntimeDescriptorV1 } {
  const path = newDescriptorPath(root, dIo);
  let desc = createOpeningDescriptor(path, dIo);
  desc = markReady(path, desc, {
    threadId: "th_x",
    registryPath: join(root, "r.sqlite"),
    sessionId: "sid",
    rolloutPath: join(root, "sid.jsonl"),
  });
  return { path, desc };
}

describe("assertLegalTransition", () => {
  it("allows legal transitions", () => {
    expect(() => assertLegalTransition("opening", "ready")).not.toThrow();
    expect(() => assertLegalTransition("ready", "degraded")).not.toThrow();
    expect(() => assertLegalTransition("degraded", "closed")).not.toThrow();
    expect(() => assertLegalTransition("ready", "ready", { sameBinding: true })).not.toThrow();
  });

  it("forbids degraded→ready and closed→ready", () => {
    expect(() => assertLegalTransition("degraded", "ready")).toThrow(/illegal/);
    expect(() => assertLegalTransition("closed", "ready")).toThrow(/illegal/);
  });
});

describe("revokeCapability", () => {
  it("publish non-ready then remove → absent", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-rev-"));
    const dIo = io();
    const { path, desc } = readyDesc(root, dIo);
    const rev = revokeCapability(path, desc, "closed", undefined, dIo);
    expect(rev.ok).toBe(true);
    if (rev.ok) expect(rev.kind).toBe("absent");
    expect(existsSync(path)).toBe(false);
  });

  it("rename/write fail + unlink success → absent", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-rev-wu-"));
    const good = io();
    const { path, desc } = readyDesc(root, good);
    const bad = io({ failWrite: true, failUnlink: false });
    // read/exists still from real fs via bad's exists/unlink using real paths
    const rev = revokeCapability(path, desc, "degraded", "x", {
      ...bad,
      exists: good.exists,
      readFile: good.readFile,
      unlink: good.unlink,
    });
    expect(rev.ok).toBe(true);
    if (rev.ok) expect(rev.kind).toBe("absent");
  });

  it("write fail + unlink fail → fatal (still ready)", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-rev-ff-"));
    const good = io();
    const { path, desc } = readyDesc(root, good);
    const bad = io({ failWrite: true, failUnlink: true });
    const rev = revokeCapability(path, desc, "closed", undefined, {
      ...bad,
      exists: good.exists,
      readFile: good.readFile,
      // unlink throws; exists still true
      unlink: () => {
        throw new Error("unlink fail");
      },
    });
    expect(rev.ok).toBe(false);
    if (!rev.ok) expect(rev.reason).toMatch(/still ready|unproven/);
    expect(existsSync(path)).toBe(true);
    expect(loadDescriptor(path, good).ok).toBe(true);
    const loaded = loadDescriptor(path, good);
    if (loaded.ok) expect(loaded.descriptor.state).toBe("ready");
  });

  it("publish degraded succeeds even if unlink fails → non_ready", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-rev-deg-"));
    const good = io();
    const { path, desc } = readyDesc(root, good);
    const rev = revokeCapability(path, desc, "degraded", "watcher", {
      ...good,
      unlink: () => {
        throw new Error("unlink fail");
      },
    });
    expect(rev.ok).toBe(true);
    if (rev.ok) {
      expect(rev.kind).toBe("non_ready");
      if (rev.kind === "non_ready") expect(rev.state).toBe("degraded");
    }
    expect(existsSync(path)).toBe(true);
    const loaded = loadDescriptor(path, good);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.descriptor.state).toBe("degraded");
  });

  it("markDegraded forbids after closed", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-rev-il-"));
    const dIo = io();
    const { path, desc } = readyDesc(root, dIo);
    const closed = markClosed(path, desc, dIo);
    expect(() => markDegraded(path, closed, "x", dIo)).toThrow(/illegal|revocation failed/);
  });

  it("idempotent ready republish with same binding", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-rev-id-"));
    const dIo = io();
    const { path, desc } = readyDesc(root, dIo);
    const again = markReady(path, desc, {
      threadId: "th_x",
      registryPath: join(root, "r.sqlite"),
      sessionId: "sid",
      rolloutPath: join(root, "sid.jsonl"),
    });
    expect(again.state).toBe("ready");
  });
});
