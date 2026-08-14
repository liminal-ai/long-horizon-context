import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import {
  forceKillChildTree,
  requestPtyTermination,
  runTaskkillTree,
  type SpawnTaskkill,
} from "../../src/wrapper/child-termination.js";

describe("requestPtyTermination", () => {
  it("uses a signal on POSIX and no signal on Windows", () => {
    const posixKill = vi.fn();
    const windowsKill = vi.fn();
    expect(requestPtyTermination({ pid: 10, kill: posixKill }, "linux", "SIGTERM").method).toBe("pty_signal");
    expect(posixKill).toHaveBeenCalledWith("SIGTERM");
    expect(requestPtyTermination({ pid: 11, kill: windowsKill }, "win32", "SIGTERM").method).toBe("pty_close");
    expect(windowsKill).toHaveBeenCalledWith();
  });

  it("reports an attempted failure without throwing", () => {
    const outcome = requestPtyTermination(
      {
        pid: 10,
        kill: () => {
          throw new Error("gone");
        },
      },
      "win32",
      "SIGKILL",
    );
    expect(outcome).toEqual({ method: "none", attempted: ["pty_close"] });
  });
});

describe("forceKillChildTree", () => {
  it("uses asynchronous taskkill on Windows and never a process group", async () => {
    const killGroup = vi.fn();
    const closePty = vi.fn();
    const taskkill = vi.fn(async () => true);
    const outcome = await forceKillChildTree(22, {
      platform: "win32",
      selfPid: 99,
      killGroup,
      closePty,
      taskkill,
    });
    expect(outcome).toEqual({ method: "taskkill", attempted: ["taskkill"] });
    expect(taskkill).toHaveBeenCalledWith(22);
    expect(killGroup).not.toHaveBeenCalled();
    expect(closePty).not.toHaveBeenCalled();
  });

  it("falls back to the supported no-signal PTY close on Windows", async () => {
    const closePty = vi.fn();
    const outcome = await forceKillChildTree(22, {
      platform: "win32",
      selfPid: 99,
      killGroup: vi.fn(),
      closePty,
      taskkill: async () => false,
    });
    expect(outcome).toEqual({ method: "pty_close", attempted: ["taskkill", "pty_close"] });
    expect(closePty).toHaveBeenCalledOnce();
  });

  it("uses a POSIX process group with a PTY signal fallback", async () => {
    const closePty = vi.fn();
    const direct = await forceKillChildTree(22, {
      platform: "linux",
      selfPid: 99,
      killGroup: vi.fn(),
      closePty,
      taskkill: vi.fn(),
    });
    expect(direct.method).toBe("process_group");

    const fallback = await forceKillChildTree(22, {
      platform: "darwin",
      selfPid: 99,
      killGroup: () => {
        throw new Error("ESRCH");
      },
      closePty,
      taskkill: vi.fn(),
    });
    expect(fallback).toEqual({ method: "pty_signal", attempted: ["process_group", "pty_signal"] });
    expect(closePty).toHaveBeenCalledOnce();
  });

  it("refuses unsafe PIDs", async () => {
    const deps = {
      platform: "win32" as const,
      selfPid: 99,
      killGroup: vi.fn(),
      closePty: vi.fn(),
      taskkill: vi.fn(async () => true),
    };
    for (const pid of [0, -1, 99, Number.NaN]) {
      expect(await forceKillChildTree(pid, deps)).toEqual({ method: "none", attempted: [] });
    }
    expect(deps.taskkill).not.toHaveBeenCalled();
  });
});

describe("runTaskkillTree", () => {
  it("spawns taskkill with the exact process-tree arguments", async () => {
    const child = new EventEmitter() as ChildProcess;
    child.kill = vi.fn();
    const spawn = vi.fn((() => {
      queueMicrotask(() => child.emit("close", 0));
      return child;
    }) as SpawnTaskkill);
    await expect(runTaskkillTree(123, 100, spawn)).resolves.toBe(true);
    expect(spawn).toHaveBeenCalledWith("taskkill", ["/PID", "123", "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  });

  it("times out without blocking the event loop", async () => {
    const child = new EventEmitter() as ChildProcess;
    child.kill = vi.fn();
    const spawn = (() => child) as SpawnTaskkill;
    await expect(runTaskkillTree(123, 5, spawn)).resolves.toBe(false);
    expect(child.kill).toHaveBeenCalledOnce();
  });
});
