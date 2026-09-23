/**
 * One-shot (`-p`) launches run Claude as a plain child process (gorilla F1+F8).
 *
 * A one-shot has no Control Panel, no typed input to route and no mid-turn
 * handoff (its compaction seam is the next invocation), so the pty bought it
 * nothing and cost it the stdio contract of `claude -p`: stderr merged into
 * stdout, CRLF line ends, cursor escapes, and piped stdin never reaching Claude
 * because it saw a TTY. Here Claude inherits the wrapper's stdin, stdout and
 * stderr unchanged; capture still reads the transcript file.
 *
 * The pty also gave parent-death coupling for free: a SIGKILLed wrapper closed
 * the pty and Claude got SIGHUP, which makes it reap its tool shells and exit.
 * A plain child keeps running instead, writing the thread with no lease holder.
 * So parent death is coupled explicitly, with the same signal:
 *  - Linux: `setpriv --pdeathsig HUP` execs Claude with PR_SET_PDEATHSIG set.
 *  - elsewhere, or without setpriv: a small detached watchdog polls the wrapper
 *    and sends SIGHUP (then SIGKILL after WATCHDOG_KILL_AFTER_MS) once it is gone.
 *
 * The returned handle implements the part of node-pty's `IPty` the wrapper
 * uses for a routed child (pid, onData, onExit, kill, write, resize); data and
 * resize are no-ops because the child writes to the terminal directly.
 */

import { type ChildProcess, spawn as defaultSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { constants } from "node:os";

import type { IPty } from "@lydell/node-pty";

/** SIGHUP is what a closed pty delivered; Claude reaps its tool shells on it. */
export const PARENT_DEATH_SIGNAL = "SIGHUP";
/** Watchdog: how often it checks, and how long Claude gets before SIGKILL. */
export const WATCHDOG_POLL_MS = 250;
export const WATCHDOG_KILL_AFTER_MS = 5_000;

const SETPRIV_CANDIDATES = ["/usr/bin/setpriv", "/bin/setpriv"];

/**
 * The watchdog body, run as `node -e WATCHDOG_SOURCE <wrapperPid> <childPid>`.
 * It exits as soon as the child is gone, so it never signals a reused pid for
 * longer than one poll interval.
 */
export const WATCHDOG_SOURCE = `
const [wrapper, child] = process.argv.slice(1).map(Number);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const poll = ${WATCHDOG_POLL_MS}, killAfter = ${WATCHDOG_KILL_AFTER_MS};
const timer = setInterval(() => {
  if (!alive(child)) process.exit(0);
  if (alive(wrapper)) return;
  clearInterval(timer);
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

export type ParentDeathCoupling = "pdeathsig" | "watchdog";

export interface PlainChildOptions {
  cwd: string;
  env: Record<string, string>;
  platform?: NodeJS.Platform;
  /** Test seam; production uses node's spawn. */
  spawn?: typeof defaultSpawn;
  /** Test seam; production probes the usual util-linux paths. */
  setprivPath?: string | null;
  /** Test seam: the wrapper pid the watchdog watches. */
  wrapperPid?: number;
  /** Notified once with the coupling actually in force. */
  onCoupling?: (coupling: ParentDeathCoupling) => void;
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
  // A spawn failure is reported through `pid === undefined` below; the error
  // event must still have a listener or it would crash the wrapper.
  child.on("error", () => {});
  if (child.pid === undefined) {
    throw new Error(`cc-lhc: could not start ${file}`);
  }
  const pid = child.pid;

  if (setpriv !== null) {
    options.onCoupling?.("pdeathsig");
  } else {
    const watchdog = spawn(
      process.execPath,
      ["-e", WATCHDOG_SOURCE, String(options.wrapperPid ?? process.pid), String(pid)],
      {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      },
    );
    watchdog.unref();
    options.onCoupling?.("watchdog");
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
      child.kill((signal ?? "SIGHUP") as NodeJS.Signals);
    },
    write: () => {},
    resize: () => {},
    pause: () => {},
    resume: () => {},
  };
  return handle as unknown as IPty;
};
