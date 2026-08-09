/**
 * Wrapper integration: descriptor env, guidance, spawn throw, lifecycle revoke.
 */

import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { injectRetrievalGuidance } from "../../src/retrieval/guidance.js";
import {
  closeAndRemove,
  createOpeningDescriptor,
  loadDescriptor,
  markReady,
  newDescriptorPath,
  revokeDescriptor,
  RUNTIME_DESCRIPTOR_ENV,
  type DescriptorIo,
} from "../../src/runtime/descriptor.js";
import { readProcessIdentityLinux } from "../../src/runtime/process-identity.js";
import { run } from "../../src/wrapper/run.js";

function io(): DescriptorIo {
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
    readProcessIdentity: (pid) => (pid === process.pid ? self : null),
    nowMs: () => Date.now(),
    randomId: () => `w-${Math.random().toString(16).slice(2)}`,
    pid: process.pid,
  };
}

describe("wrapper descriptor lifecycle (unit seams)", () => {
  it("spawn throw path: opening descriptor is revoked", async () => {
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-wrap-spawn-"));
    process.env.CC_LHC_HOME = home;
    const path = newDescriptorPath(home, io());
    createOpeningDescriptor(path, io());
    expect(existsSync(path)).toBe(true);
    // Simulate post-create spawn failure cleanup
    closeAndRemove(path, undefined, io());
    expect(existsSync(path)).toBe(false);
    expect(loadDescriptor(path, io()).ok).toBe(false);
  });

  it("child exit revoke before drain: no ready file remains", () => {
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-wrap-exit-"));
    const dIo = io();
    const path = newDescriptorPath(home, dIo);
    let d = createOpeningDescriptor(path, dIo);
    d = markReady(path, d, {
      threadId: "th_x",
      registryPath: join(home, "r.sqlite"),
      sessionId: "s",
      rolloutPath: join(home, "s.jsonl"),
    });
    expect(loadDescriptor(path, dIo).ok).toBe(true);
    // Synchronous revoke (as teardown does before await stop)
    revokeDescriptor(path, d, dIo);
    expect(existsSync(path)).toBe(false);
    void d;
  });

  it("guidance inject leaves post-- prompt data", () => {
    const r = injectRetrievalGuidance(["-p", "hi", "--", "do not touch --append-system-prompt"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.argv[r.argv.length - 1]).toBe("do not touch --append-system-prompt");
  });

  it("run with throwing spawnPty revokes descriptor and rethrows", async () => {
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-wrap-run-"));
    process.env.CC_LHC_HOME = home;
    const runtimeDir = join(home, "runtime");
    await expect(
      run(["--session-id", "11111111-1111-1111-1111-111111111111", "-p", "x"], {
        noCapture: false,
        noInference: true,
        claudeBin: "/bin/true",
        spawnPty: () => {
          throw new Error("spawn boom");
        },
        stdin: { isTTY: false, on() {}, removeListener() {}, setRawMode() {} } as unknown as NodeJS.ReadStream,
        stdout: {
          isTTY: false,
          columns: 80,
          rows: 24,
          write() {
            return true;
          },
        } as unknown as NodeJS.WriteStream,
        stderr: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WriteStream,
        wrapperLog: {
          path: join(home, "w.log"),
          info() {},
          warn() {},
          warningCount: () => 0,
        },
      }),
    ).rejects.toThrow(/spawn boom/);
    // No leftover ready descriptors
    if (existsSync(runtimeDir)) {
      const { readdirSync } = require("node:fs") as typeof import("node:fs");
      const left = readdirSync(runtimeDir).filter((n) => n.endsWith(".json"));
      expect(left).toEqual([]);
    }
  });
});
