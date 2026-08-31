#!/usr/bin/env node
/**
 * Synthetic "old child" (stand-in for the Claude Code PTY process).
 *
 * Spawned under node-pty as the run() old child. Launches attached and
 * detached candidates, writes a pid manifest, ignores POSIX SIGTERM so
 * production terminateChild escalates to forceKillChildTree.
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (typeof dir !== "string" || dir.length === 0) {
  process.stderr.write("old-child: missing control directory\n");
  process.exit(2);
}

const plan = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8"));
const workerPath = plan.workerPath;
const orphanLauncherPath = plan.orphanLauncherPath;
const lifetimeMs = String(plan.lifetimeMs ?? 60_000);

if (process.platform !== "win32") {
  process.on("SIGTERM", () => {});
  process.on("SIGHUP", () => {});
}

function spawnWorker(launch, outputPath) {
  const stdio = "ignore";
  const windowsHide = true;
  if (launch === "attached") {
    return spawn(process.execPath, [workerPath, outputPath, lifetimeMs], {
      detached: false,
      stdio,
      windowsHide,
    });
  }
  if (launch === "detached_stdio_ignore") {
    const child = spawn(process.execPath, [workerPath, outputPath, lifetimeMs], {
      detached: true,
      stdio: "ignore",
      windowsHide,
    });
    child.unref();
    return child;
  }
  if (launch === "detached_stdio_pipe") {
    const child = spawn(process.execPath, [workerPath, outputPath, lifetimeMs], {
      detached: true,
      stdio: "pipe",
      windowsHide,
    });
    child.stdout?.resume();
    child.stderr?.resume();
    return child;
  }
  if (launch === "orphaned_intermediate") {
    const pidPath = `${outputPath}.orphan-pid`;
    const launcher = spawn(
      process.execPath,
      [orphanLauncherPath, workerPath, outputPath, pidPath, lifetimeMs],
      { detached: false, stdio: "ignore", windowsHide },
    );
    return { launcher, pidPath };
  }
  throw new Error(`unknown launch ${launch}`);
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // Main-thread Atomics.wait is unavailable; spin the remainder.
    }
  }
}

function waitForFile(path, timeoutMs) {
  const start = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - start > timeoutMs) return false;
    sleepSync(20);
  }
  return true;
}

const processes = [];
for (const candidate of plan.candidates) {
  const launched = spawnWorker(candidate.launch, candidate.outputPath);
  if ("pidPath" in launched) {
    const launcherPid = launched.launcher.pid ?? null;
    const ok = waitForFile(launched.pidPath, 5_000);
    const workerPid = ok ? Number.parseInt(readFileSync(launched.pidPath, "utf8").trim(), 10) : null;
    processes.push({
      id: candidate.id,
      launch: candidate.launch,
      pid: Number.isSafeInteger(workerPid) ? workerPid : null,
      intermediatePid: launcherPid,
    });
  } else {
    processes.push({
      id: candidate.id,
      launch: candidate.launch,
      pid: launched.pid ?? null,
      intermediatePid: null,
    });
  }
}

const manifest = {
  oldChildPid: process.pid,
  processes,
};
writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest)}\n`);

setInterval(() => {}, 1000);
setTimeout(() => process.exit(0), Number.parseInt(lifetimeMs, 10) + 15_000).unref?.();
