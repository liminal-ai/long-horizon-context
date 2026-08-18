/**
 * Wrapper integration: descriptor env, guidance, spawn throw, lifecycle revoke.
 */

import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { injectRetrievalGuidance } from "../../src/retrieval/guidance.js";
import {
  closeAndRemove,
  createOpeningDescriptor,
  type DescriptorIo,
  loadDescriptor,
  markReady,
  newDescriptorPath,
  revokeDescriptor,
} from "../../src/runtime/descriptor.js";
import { createNativeIdentityProbe } from "../../src/runtime/native-identity.js";
import { run } from "../../src/wrapper/run.js";
import { selfOnlyProbe } from "../helpers/identity.js";

function io(): DescriptorIo {
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
    readProcessIdentity: selfOnlyProbe(),
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

  it("startup on a supported platform with no prebuild fails with an actionable error, never degrades", async () => {
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-wrap-noaddon-"));
    process.env.CC_LHC_HOME = home;
    // Real native probe against a package root that has a valid targets
    // manifest but no artifact; env:{} bypasses the test-suite addon stub so
    // this is the true production loading path.
    const bareRoot = mkdtempSync(join(tmpdir(), "cc-lhc-noartifact-"));
    const here = dirname(fileURLToPath(import.meta.url));
    copyFileSync(join(here, "../../../cc-lhc-native/targets.json"), join(bareRoot, "targets.json"));
    const dIo: DescriptorIo = {
      ...io(),
      readProcessIdentity: createNativeIdentityProbe({ packageRoot: bareRoot, env: {} }),
    };
    let spawned = 0;
    let stderrText = "";
    const code = await run(["--session-id", "22222222-2222-2222-2222-222222222222", "-p", "x"], {
      noInference: true,
      claudeBin: "/bin/true",
      descriptorIo: dIo,
      spawnPty: (() => {
        spawned += 1;
        throw new Error("must not spawn");
      }) as never,
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
        write(chunk: string) {
          stderrText += String(chunk);
          return true;
        },
      } as unknown as NodeJS.WriteStream,
      wrapperLog: {
        path: join(home, "w.log"),
        info() {},
        warn() {},
        warningCount: () => 0,
      },
    });
    expect(code).toBe(2);
    expect(spawned).toBe(0);
    // Actionable: names the addon problem and the remediation, no silent
    // degradation to PID-only or Linux-only identity.
    expect(stderrText).toMatch(/cannot establish OS process identity/);
    expect(stderrText).toMatch(/addon_unavailable|no addon artifact/);
    expect(stderrText).toContain("pnpm --config.verify-deps-before-run=false --filter cc-lhc-native run build:native");
    // No descriptor may remain claimable.
    const runtimeDir = join(home, "runtime");
    if (existsSync(runtimeDir)) {
      const { readdirSync } = require("node:fs") as typeof import("node:fs");
      expect(readdirSync(runtimeDir).filter((n) => n.endsWith(".json"))).toEqual([]);
    }
  });
});
