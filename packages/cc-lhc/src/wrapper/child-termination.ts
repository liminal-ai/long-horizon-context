import { type ChildProcess, spawn as defaultSpawn } from "node:child_process";

/** The subset of node-pty used by the termination policy. */
export interface TerminablePty {
  pid: number;
  kill(signal?: string): void;
}

export type TerminationMethod = "pty_close" | "pty_signal" | "process_group" | "taskkill" | "none";

export interface TerminationAttempt {
  method: TerminationMethod;
  attempted: TerminationMethod[];
}

/**
 * Ask the PTY backend to close the child.
 *
 * The Windows backend rejects every signal argument. Its supported operation
 * is `kill()` with no argument, which closes the ConPTY and asks its agent to
 * terminate the attached process tree. POSIX retains normal signal semantics.
 */
export function requestPtyTermination(
  pty: TerminablePty,
  platform: NodeJS.Platform,
  signal: NodeJS.Signals,
): TerminationAttempt {
  try {
    if (platform === "win32") {
      pty.kill();
      return { method: "pty_close", attempted: ["pty_close"] };
    }
    pty.kill(signal);
    return { method: "pty_signal", attempted: ["pty_signal"] };
  } catch {
    return {
      method: "none",
      attempted: [platform === "win32" ? "pty_close" : "pty_signal"],
    };
  }
}

export type SpawnTaskkill = (
  command: string,
  args: readonly string[],
  options: { windowsHide: true; stdio: "ignore" },
) => ChildProcess;

/** Run taskkill without blocking PTY output, exit events, or buffered stdin. */
export function runTaskkillTree(
  pid: number,
  timeoutMs = 2_000,
  spawnTaskkill: SpawnTaskkill = defaultSpawn as SpawnTaskkill,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };

    let child: ChildProcess;
    try {
      child = spawnTaskkill("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {
      resolve(false);
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // The close/error event may already be in flight.
      }
      finish(false);
    }, timeoutMs);
    timer.unref?.();
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
  });
}

export interface ForceKillDeps {
  platform: NodeJS.Platform;
  selfPid: number;
  killGroup(pid: number): void;
  closePty(): void;
  taskkill(pid: number): Promise<boolean>;
}

/**
 * Escalate to a platform-supported forced process-tree termination.
 * The caller's exit observer, not this return value, proves child exit.
 */
export async function forceKillChildTree(pid: number, deps: ForceKillDeps): Promise<TerminationAttempt> {
  const attempted: TerminationMethod[] = [];
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === deps.selfPid) {
    return { method: "none", attempted };
  }

  if (deps.platform === "win32") {
    attempted.push("taskkill");
    try {
      if (await deps.taskkill(pid)) return { method: "taskkill", attempted };
    } catch {
      // Fall through to the only node-pty operation supported on Windows.
    }
    attempted.push("pty_close");
    try {
      deps.closePty();
      return { method: "pty_close", attempted };
    } catch {
      return { method: "none", attempted };
    }
  }

  attempted.push("process_group");
  try {
    deps.killGroup(pid);
    return { method: "process_group", attempted };
  } catch {
    attempted.push("pty_signal");
    try {
      deps.closePty();
      return { method: "pty_signal", attempted };
    } catch {
      return { method: "none", attempted };
    }
  }
}
