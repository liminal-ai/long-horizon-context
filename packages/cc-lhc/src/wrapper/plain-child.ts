import { type ChildProcess, spawn as defaultSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { constants } from "node:os";

import type { IPty } from "@lydell/node-pty";

/** SIGHUP is what a closed pty delivered; Claude reaps its tool shells on it. */
export const PARENT_DEATH_SIGNAL = "SIGHUP";
export const WATCHDOG_POLL_MS = 250;
export const WATCHDOG_KILL_AFTER_MS = 5_000;

const SETPRIV_CANDIDATES = ["/usr/bin/setpriv", "/bin/setpriv"];

export const WATCHDOG_SOURCE = `
const [wrapper, child] = process.argv.slice(1, 3).map(Number);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const poll = ${WATCHDOG_POLL_MS}, killAfter = ${WATCHDOG_KILL_AFTER_MS};
let wrapperGone = false;
if (process.argv[3] === "pipe") {
  const gone = () => { wrapperGone = true; };
  process.stdin.on("data", () => {});
  process.stdin.on("end", gone);
  process.stdin.on("close", gone);
  process.stdin.on("error", gone);
}
const timer = setInterval(() => {
  if (!alive(child)) process.exit(0);
  if (!wrapperGone && alive(wrapper)) return;
  clearInterval(timer);
  if (process.platform === "win32") {
    try { require("node:child_process").spawnSync("taskkill", ["/PID", String(child), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch {}
    process.exit(0);
  }
  try { process.kill(child, "${PARENT_DEATH_SIGNAL}"); } catch {}
  const deadline = Date.now() + killAfter;
  setInterval(() => {
    if (!alive(child)) process.exit(0);
    if (Date.now() < deadline) return;
    try { process.kill(child, "SIGKILL"); } catch {}
    process.exit(0);
  }, poll);
}, poll);
`;

export type ParentDeathCoupling = "pdeathsig" | "watchdog" | "job";

export interface PlainChildOptions {
  cwd: string;
  env: Record<string, string>;
  platform?: NodeJS.Platform;
  spawn?: typeof defaultSpawn;
  setprivPath?: string | null;
  wrapperPid?: number;
  bindToWrapperJob?: (pid: number) => { ok: true } | { ok: false; reason: string };
  onCoupling?: (coupling: ParentDeathCoupling, detail?: string) => void;
}

export type PlainChildSpawn = (file: string, args: string[], options: PlainChildOptions) => IPty;

export function findSetpriv(): string | null {
  return SETPRIV_CANDIDATES.find((path) => existsSync(path)) ?? null;
}

type ExitListener = (event: { exitCode: number; signal?: number }) => void;

export const spawnPlainChild: PlainChildSpawn = (file, args, options) => {
  const platform = options.platform ?? process.platform;
  const spawn = options.spawn ?? defaultSpawn;
  const setpriv =
    platform === "linux" ? (options.setprivPath === undefined ? findSetpriv() : options.setprivPath) : null;

  const [program, argv]: [string, string[]] =
    setpriv !== null ? [setpriv, ["--pdeathsig", "HUP", "--", file, ...args]] : [file, args];
  const child: ChildProcess = spawn(program, argv, {
    cwd: options.cwd,
    env: options.env,
    stdio: "inherit",
    windowsHide: true,
  });
  child.on("error", () => {});
  if (child.pid === undefined) {
    throw new Error(`cc-lhc: could not start ${file}`);
  }
  const pid = child.pid;

  let jobDetail: string | undefined;
  let jobBound = false;
  if (platform === "win32" && options.bindToWrapperJob !== undefined) {
    const bound = options.bindToWrapperJob(pid);
    if (bound.ok) jobBound = true;
    else jobDetail = `job bind failed: ${bound.reason}`;
  }

  if (setpriv !== null) {
    options.onCoupling?.("pdeathsig");
  } else {
    const watchdog = spawn(
      process.execPath,
      ["-e", WATCHDOG_SOURCE, String(options.wrapperPid ?? process.pid), String(pid), "pipe"],
      {
        stdio: ["pipe", "ignore", "ignore"],
        detached: true,
        windowsHide: true,
      },
    );
    watchdog.on("error", () => {});
    watchdog.stdin?.on("error", () => {});
    (watchdog.stdin as { unref?: () => void } | null)?.unref?.();
    watchdog.unref();
    options.onCoupling?.(jobBound ? "job" : "watchdog", jobDetail);
  }

  const exitListeners: ExitListener[] = [];
  let exitEvent: { exitCode: number; signal?: number } | undefined;
  child.on("exit", (code, signal) => {
    exitEvent = { exitCode: code ?? 0, ...(signal === null ? {} : { signal: constants.signals[signal] }) };
    for (const listener of exitListeners) listener(exitEvent);
  });

  const handle = {
    pid,
    process: file,
    onData: () => ({ dispose: () => {} }),
    onExit: (listener: ExitListener) => {
      if (exitEvent !== undefined) listener(exitEvent);
      else exitListeners.push(listener);
      return { dispose: () => {} };
    },
    kill: (signal?: string) => {
      if (platform === "win32") {
        try {
          spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on(
            "error",
            () => {},
          );
        } catch {}
        return;
      }
      child.kill((signal ?? "SIGHUP") as NodeJS.Signals);
    },
    write: () => {},
    resize: () => {},
    pause: () => {},
    resume: () => {},
  };
  return handle as unknown as IPty;
};
