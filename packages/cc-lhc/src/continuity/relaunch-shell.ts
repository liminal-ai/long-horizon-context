/**
 * The shell that runs a relaunched Monitor command (LIM-145).
 *
 * A Monitor's `command` is a shell string as Claude Code runs it: through the
 * POSIX shell on Linux/macOS and through Git Bash on Windows — the same
 * resolution Claude Code 2.1.252 applies to its own shell tool, hooks, and
 * status-line commands (LIM-144 D8): `CLAUDE_CODE_GIT_BASH_PATH` when it names
 * an existing file, then the Git for Windows install locations, then `bash.exe`
 * on PATH. PowerShell and cmd.exe are never substituted: the command was
 * written for bash.
 */

import { existsSync } from "node:fs";
import { win32 as winPath } from "node:path";

export interface RelaunchShell {
  program: string;
  args: (command: string) => string[];
}

export type RelaunchShellResolution = { ok: true; shell: RelaunchShell } | { ok: false; reason: "git_bash_not_found" };

const GIT_BASH_INSTALL_PATHS = ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"];

function bashShell(program: string): RelaunchShell {
  return { program, args: (command) => ["-c", command] };
}

export function resolveRelaunchShell(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): RelaunchShellResolution {
  if (platform !== "win32") return { ok: true, shell: bashShell("/bin/sh") };
  const configured = env.CLAUDE_CODE_GIT_BASH_PATH;
  if (configured !== undefined && configured !== "" && exists(configured))
    return { ok: true, shell: bashShell(configured) };
  for (const candidate of GIT_BASH_INSTALL_PATHS) {
    if (exists(candidate)) return { ok: true, shell: bashShell(candidate) };
  }
  for (const dir of (env.PATH ?? env.Path ?? "").split(winPath.delimiter)) {
    if (dir === "") continue;
    const candidate = winPath.join(dir, "bash.exe");
    if (exists(candidate)) return { ok: true, shell: bashShell(candidate) };
  }
  return { ok: false, reason: "git_bash_not_found" };
}
