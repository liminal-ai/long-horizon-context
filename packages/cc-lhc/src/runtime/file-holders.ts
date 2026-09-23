/**
 * Which processes (other than this one) hold a file open.
 *
 * The cc-lhc-native `findChildHoldingFile` only searches the direct children
 * of a given pid, so it cannot answer "does anything hold this transcript?".
 * This is the smallest system-wide check:
 *   linux  — scan /proc/<pid>/fd/* symlinks for the file's real path
 *   darwin — `lsof -F pc -- <path>`
 *   other  — unavailable (callers must treat as "cannot prove unheld")
 *
 * Linux limit: processes whose fd table this user cannot read (another user's,
 * without privilege) are invisible and treated as not holding the file.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";

export interface FileHolder {
  pid: number;
  cmd: string;
}

export type FileHoldersResult = { ok: true; holders: FileHolder[] } | { ok: false; reason: string };

export interface FindFileHoldersOptions {
  platform?: NodeJS.Platform;
  /** Linux /proc root (tests). */
  procRoot?: string;
  selfPid?: number;
}

function procCmd(procRoot: string, pid: number): string {
  try {
    const cmdline = readFileSync(join(procRoot, String(pid), "cmdline"), "utf8").replace(/\0+$/, "");
    if (cmdline !== "") return cmdline.split("\0").join(" ");
  } catch {
    // fall through
  }
  try {
    return readFileSync(join(procRoot, String(pid), "comm"), "utf8").trim();
  } catch {
    return "?";
  }
}

function linuxHolders(target: string, procRoot: string, selfPid: number): FileHoldersResult {
  let pids: string[];
  try {
    pids = readdirSync(procRoot).filter((name) => /^\d+$/.test(name));
  } catch (cause) {
    return { ok: false, reason: `cannot list ${procRoot}: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  const holders: FileHolder[] = [];
  for (const name of pids) {
    const pid = Number(name);
    if (pid === selfPid) continue;
    const fdDir = join(procRoot, name, "fd");
    let fds: string[];
    try {
      fds = readdirSync(fdDir);
    } catch {
      continue; // exited, or not ours to inspect
    }
    for (const fd of fds) {
      let link: string;
      try {
        link = readlinkSync(join(fdDir, fd));
      } catch {
        continue;
      }
      if (link === target) {
        holders.push({ pid, cmd: procCmd(procRoot, pid) });
        break;
      }
    }
  }
  return { ok: true, holders };
}

function darwinHolders(target: string, selfPid: number): FileHoldersResult {
  const run = spawnSync("lsof", ["-F", "pc", "--", target], { encoding: "utf8", timeout: 5_000 });
  if (run.error !== undefined) return { ok: false, reason: `lsof failed: ${run.error.message}` };
  // lsof exits 1 with no output when nothing holds the file.
  if (run.status === 1 && run.stdout.trim() === "") return { ok: true, holders: [] };
  if (run.status !== 0) return { ok: false, reason: `lsof exited ${String(run.status)}` };
  const holders: FileHolder[] = [];
  let current: FileHolder | undefined;
  for (const line of run.stdout.split("\n")) {
    if (line.startsWith("p")) {
      const pid = Number(line.slice(1));
      current = Number.isInteger(pid) && pid !== selfPid ? { pid, cmd: "?" } : undefined;
      if (current !== undefined) holders.push(current);
    } else if (line.startsWith("c") && current !== undefined) {
      current.cmd = line.slice(1);
    }
  }
  return { ok: true, holders };
}

export function findFileHolders(path: string, options: FindFileHoldersOptions = {}): FileHoldersResult {
  const platform = options.platform ?? process.platform;
  const selfPid = options.selfPid ?? process.pid;
  let target: string;
  try {
    target = realpathSync(path);
  } catch (cause) {
    return { ok: false, reason: `cannot resolve ${path}: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  if (platform === "linux") return linuxHolders(target, options.procRoot ?? "/proc", selfPid);
  if (platform === "darwin") return darwinHolders(target, selfPid);
  return { ok: false, reason: `open-file holder check unsupported on ${platform}` };
}

export function formatFileHolders(holders: readonly FileHolder[]): string {
  return holders.map((holder) => `pid ${String(holder.pid)} (${holder.cmd})`).join(", ");
}
