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
 *  - elsewhere, or without setpriv: a small detached watchdog sends SIGHUP
 *    (then SIGKILL after WATCHDOG_KILL_AFTER_MS) once the wrapper is gone. It
 *    learns that from a pipe only the wrapper holds open: the kernel closes it
 *    when the wrapper dies, however it dies, so EOF on the watchdog's stdin is
 *    the signal. Polling the wrapper pid alone cannot see that death while the
 *    wrapper's own parent has not reaped it: `kill(pid, 0)` succeeds on a
 *    zombie (macOS gorilla report: 2/2 delayed-reap trials left Claude running).
 *
 * Windows has no SIGHUP (libuv answers ENOSYS for it) and no process groups, so
 * termination there is what closing the ConPTY did: `taskkill /T /F` on Claude's
 * process tree, from `kill()` and from the watchdog alike. That alone is not
 * enough: Claude exits by itself once the wrapper is gone, and Windows does
 * not end orphaned children, so its tool processes (shells, conhost, node)
 * outlived a killed wrapper (Windows ARM gorilla report, 2/2). So on Windows
 * Claude is also bound to a kill-on-close job object whose only handle the
 * wrapper holds (`bindToWrapperJob`, the native addon): when the wrapper exits
 * or dies, Windows ends every process in the job, whether or not Claude
 * exited first. The watchdog still runs, as the fallback when binding fails.
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
 * The watchdog body, run as `node -e WATCHDOG_SOURCE <wrapperPid> <childPid> [pipe]`.
 * With `pipe`, its stdin is the wrapper's end of a pipe and EOF there means the
 * wrapper is gone; the pid poll stays as a second trigger. It exits as soon as
 * the child is gone, so it never signals a reused pid for longer than one poll
 * interval.
 */
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
  /** Test seam; production uses node's spawn. */
  spawn?: typeof defaultSpawn;
  /** Test seam; production probes the usual util-linux paths. */
  setprivPath?: string | null;
  /** Test seam: the wrapper pid the watchdog watches. */
  wrapperPid?: number;
  /**
   * Windows: put Claude (and so every process it spawns afterwards) in the
   * wrapper's kill-on-close job. Injected, so this module stays free of the
   * native addon; absent, Windows falls back to the watchdog alone.
   */
  bindToWrapperJob?: (pid: number) => { ok: true } | { ok: false; reason: string };
  /** Notified once with the coupling actually in force (and why a job bind failed). */
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
  // A spawn failure is reported through `pid === undefined` below; the error
  // event must still have a listener or it would crash the wrapper.
  child.on("error", () => {});
  if (child.pid === undefined) {
    throw new Error(`cc-lhc: could not start ${file}`);
  }
  const pid = child.pid;

  // Bind before anything else: a descendant Claude spawns before this call
  // is outside the job (Claude takes far longer than this to start a tool).
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
    // The watchdog's stdin is a pipe whose write end only this process holds
    // (node opens it close-on-exec, and Claude was spawned before it). Nothing
    // is ever written; the end closing is the wrapper-death signal.
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
    // Neither the watchdog nor its pipe may keep the wrapper's event loop alive.
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
        // No SIGHUP and no process groups: close the tree, as the ConPTY did.
        // (Inline rather than child-termination's helper: this module stays
        // free of relative imports so the real-process tests can run it as is.)
        try {
          spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on(
            "error",
            () => {},
          );
        } catch {
          // Nothing more to try; the watchdog still covers wrapper death.
        }
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
