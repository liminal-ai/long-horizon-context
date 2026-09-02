/**
 * Supervised-child control against the real compiled addon (contract 3,
 * LIM-149). Every process here is this test's own child or grandchild.
 * Skipped without an artifact unless CC_LHC_NATIVE_REQUIRE_ADDON=1; the
 * native-platforms matrix sets it, so the macOS and Windows lanes are the
 * real proof of the libproc/sysctl and ntdll/Restart Manager paths.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createProcessControl,
  exactProcessControl,
  loadIdentityAddon,
  normalizeChildExitResult,
  normalizeControlResult,
  normalizeHolderResult,
  readExactProcessIdentity,
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

it("process control addon availability contract", () => {
  if (requireAddon)
    expect(addonLoad, "CC_LHC_NATIVE_REQUIRE_ADDON=1 but the addon did not load").toMatchObject({ ok: true });
});

describe("normalizers fail closed", () => {
  it("control results", () => {
    expect(normalizeControlResult({ ok: true, pid: 5 }, 5)).toEqual({ ok: true, pid: 5 });
    expect(normalizeControlResult({ ok: true, pid: 6 }, 5)).toMatchObject({ ok: false, code: "native_error" });
    expect(normalizeControlResult({ ok: false, code: "not_found", message: "x" }, 5)).toEqual({
      ok: false,
      code: "not_found",
      message: "x",
    });
    expect(normalizeControlResult({ ok: false, code: "bogus" }, 5)).toMatchObject({ ok: false, code: "native_error" });
    expect(normalizeControlResult(null, 5)).toMatchObject({ ok: false, code: "native_error" });
  });

  it("child exit results", () => {
    expect(normalizeChildExitResult({ ok: true, pid: 5, state: "running" }, 5)).toEqual({
      ok: true,
      pid: 5,
      state: "running",
    });
    expect(normalizeChildExitResult({ ok: true, pid: 5, state: "exited", code: 3 }, 5)).toEqual({
      ok: true,
      pid: 5,
      state: "exited",
      code: 3,
    });
    expect(normalizeChildExitResult({ ok: true, pid: 5, state: "signaled", signal: 9 }, 5)).toEqual({
      ok: true,
      pid: 5,
      state: "signaled",
      signal: 9,
    });
    for (const bad of [
      { ok: true, pid: 5, state: "exited" },
      { ok: true, pid: 5, state: "exited", code: -1 },
      { ok: true, pid: 5, state: "signaled", signal: 0 },
      { ok: true, pid: 5, state: "done" },
      { ok: true, pid: 7, state: "running" },
      [],
    ]) {
      expect(normalizeChildExitResult(bad, 5), JSON.stringify(bad)).toMatchObject({ ok: false, code: "native_error" });
    }
    expect(normalizeChildExitResult({ ok: false, code: "identity_changed", message: "m" }, 5)).toEqual({
      ok: false,
      code: "identity_changed",
      message: "m",
    });
  });

  it("holder results", () => {
    expect(normalizeHolderResult({ ok: true, parentPid: 1, path: "/p", pid: 9, matches: 1 }, 1, "/p")).toEqual({
      ok: true,
      parentPid: 1,
      path: "/p",
      pid: 9,
      matches: 1,
    });
    expect(normalizeHolderResult({ ok: true, parentPid: 1, path: "/p", pid: null, matches: 2 }, 1, "/p")).toEqual({
      ok: true,
      parentPid: 1,
      path: "/p",
      pid: null,
      matches: 2,
    });
    for (const bad of [
      { ok: true, parentPid: 2, path: "/p", pid: null, matches: 0 },
      { ok: true, parentPid: 1, path: "/q", pid: null, matches: 0 },
      { ok: true, parentPid: 1, path: "/p", pid: 9, matches: 2 },
      { ok: true, parentPid: 1, path: "/p", pid: 0, matches: 1 },
      { ok: true, parentPid: 1, path: "/p", pid: null, matches: -1 },
    ]) {
      expect(normalizeHolderResult(bad, 1, "/p"), JSON.stringify(bad)).toMatchObject({
        ok: false,
        code: "native_error",
      });
    }
  });

  it("guards arguments before touching the addon", () => {
    const control = createProcessControl({ existing: [] } as never);
    expect(control.pause(0)).toMatchObject({ ok: false, code: "invalid_pid" });
    expect(control.readChildExit(5, "12a")).toMatchObject({ ok: false, code: "invalid_pid" });
    expect(control.findChildHoldingFile(5, "")).toMatchObject({ ok: false, code: "invalid_path" });
  });
});

const real = addonLoad.ok ? describe : describe.skip;

/** A child of this test that spawns one grandchild writing to `output`, then stays alive. */
function spawnSupervisor(output: string, grandchildExitCode: number, grandchildMs: number): ChildProcess {
  const script = `
    const { spawn } = require("node:child_process");
    const { openSync } = require("node:fs");
    const fd = openSync(process.argv[1], "a");
    const g = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(${grandchildExitCode}), ${grandchildMs})"], {
      stdio: ["ignore", fd, "ignore"],
    });
    process.stdout.write(String(g.pid) + "\\n");
    setInterval(() => process.stdout.write("tick\\n"), 25);
  `;
  return spawn(process.execPath, ["-e", script, output], { stdio: ["ignore", "pipe", "inherit"] });
}

function firstLine(child: ChildProcess): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    const onData = (chunk: Buffer): void => {
      buf += String(chunk);
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        child.stdout?.off("data", onData);
        resolve(buf.slice(0, nl));
      }
    };
    child.stdout?.on("data", onData);
  });
}

async function until<T>(read: () => T, done: (value: T) => boolean, capMs: number): Promise<T> {
  const start = Date.now();
  let value = read();
  while (!done(value) && Date.now() - start < capMs) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    value = read();
  }
  return value;
}

real("supervised-child control against real children", () => {
  const dirs: string[] = [];
  const children: ChildProcess[] = [];
  afterEach(async () => {
    const control = exactProcessControl();
    for (const child of children.splice(0)) {
      if (child.pid !== undefined) control.resume(child.pid);
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-control-"));
    dirs.push(dir);
    return dir;
  }

  it("finds the direct child holding the output file, by the opened file object", async () => {
    const output = join(scratch(), "task.output");
    writeFileSync(output, "");
    const supervisor = spawnSupervisor(output, 0, 20_000);
    children.push(supervisor);
    const grandchild = Number(await firstLine(supervisor));
    const control = exactProcessControl();
    const found = await until(
      () => control.findChildHoldingFile(supervisor.pid as number, output),
      (r) => r.ok && r.pid !== null,
      5_000,
    );
    expect(found).toMatchObject({ ok: true, pid: grandchild, matches: 1 });
    // From this test's own vantage the direct child holding the file is the
    // supervisor (it opened the fd it handed down), never the grandchild.
    expect(control.findChildHoldingFile(process.pid, output)).toMatchObject({
      ok: true,
      pid: supervisor.pid,
      matches: 1,
    });
    const other = join(scratch(), "other.output");
    writeFileSync(other, "x");
    expect(control.findChildHoldingFile(supervisor.pid as number, other)).toMatchObject({ ok: true, pid: null });
    expect(control.findChildHoldingFile(supervisor.pid as number, join(scratch(), "missing"))).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("a paused supervisor keeps its finished task's real exit code readable; resume releases it", async () => {
    const output = join(scratch(), "task.output");
    writeFileSync(output, "");
    const supervisor = spawnSupervisor(output, 3, 700);
    children.push(supervisor);
    const grandchild = Number(await firstLine(supervisor));
    const identity = readExactProcessIdentity(grandchild);
    if (!identity.ok) throw new Error(`grandchild identity: ${identity.message}`);
    const control = exactProcessControl();
    expect(control.pause(supervisor.pid as number)).toEqual({ ok: true, pid: supervisor.pid });
    expect(control.readChildExit(grandchild, identity.identity.starttime)).toMatchObject({
      ok: true,
      state: "running",
    });
    const exited = await until(
      () => control.readChildExit(grandchild, identity.identity.starttime),
      (r) => !(r.ok && r.state === "running"),
      10_000,
    );
    expect(exited).toEqual({ ok: true, pid: grandchild, state: "exited", code: 3 });
    // Still readable moments later: nothing collected it while paused.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(control.readChildExit(grandchild, identity.identity.starttime)).toEqual(exited);
    expect(control.readChildExit(grandchild, "1")).toMatchObject({ ok: false, code: "identity_changed" });
    expect(control.resume(supervisor.pid as number)).toEqual({ ok: true, pid: supervisor.pid });
    const collected = await until(
      () => control.readChildExit(grandchild, identity.identity.starttime),
      (r) => !r.ok,
      5_000,
    );
    expect(collected).toMatchObject({ ok: false, code: "not_found" });
  });

  it("pause stops the child's own activity; resume restores it", async () => {
    const output = join(scratch(), "task.output");
    writeFileSync(output, "");
    const supervisor = spawnSupervisor(output, 0, 20_000);
    children.push(supervisor);
    await firstLine(supervisor);
    let ticks = 0;
    supervisor.stdout?.on("data", (chunk: Buffer) => {
      ticks += String(chunk).split("tick").length - 1;
    });
    const control = exactProcessControl();
    expect(control.pause(supervisor.pid as number)).toEqual({ ok: true, pid: supervisor.pid });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const frozenAt = ticks;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(ticks).toBe(frozenAt);
    expect(control.resume(supervisor.pid as number)).toEqual({ ok: true, pid: supervisor.pid });
    await until(
      () => ticks,
      (n) => n > frozenAt,
      5_000,
    );
    expect(ticks).toBeGreaterThan(frozenAt);
  });

  it("no such process and a dead pid fail closed", () => {
    const control = exactProcessControl();
    expect(control.pause(2_147_483_000)).toMatchObject({ ok: false });
    expect(control.readChildExit(2_147_483_000, "1")).toMatchObject({ ok: false });
  });
});
