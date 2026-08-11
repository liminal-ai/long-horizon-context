/**
 * Claude executable resolution.
 *
 * POSIX: unchanged pass-through — `CC_LHC_CLAUDE_BIN` or bare `claude`; the
 * PTY layer resolves names via execvp PATH semantics.
 *
 * Windows: ConPTY (node-pty) spawns native PE executables only — it rejects
 * bare names and cannot run `.cmd`/`.bat` npm shims without routing arbitrary
 * argv through cmd.exe quoting, which cc-lhc refuses to do. Production must
 * therefore hand node-pty an ABSOLUTE path to a native executable. The
 * resolver below implements PATH/PATHEXT search restricted to native
 * extensions, fails closed with actionable guidance when PATH exposes only a
 * `.cmd`/npm shim, and holds `CC_LHC_CLAUDE_BIN` to the same contract.
 *
 * CI proves the resolver plus the real ConPTY absolute-exe transport
 * (test/wrapper/run-real-pty.test.ts). It cannot prove a real Claude launch
 * (Claude is absent on runners) — that stays on the XP4 real-machine smoke.
 */

import { existsSync, statSync } from "node:fs";
import { win32 as winPath } from "node:path";

/** Extensions ConPTY can execute directly (native PE images). */
export const WINDOWS_NATIVE_EXECUTABLE_EXTENSIONS = [".exe", ".com"] as const;

/** Shim extensions that would require cmd.exe/PowerShell interpretation. */
const WINDOWS_SHIM_EXTENSIONS = [".cmd", ".bat", ".ps1"] as const;

export type ClaudeBinResolution = { ok: true; path: string } | { ok: false; reason: string };

export interface WindowsClaudeBinSeams {
  /** PATH value (';'-separated). */
  pathValue?: string | undefined;
  /** PATHEXT value (';'-separated); Windows default order used when absent. */
  pathextValue?: string | undefined;
  /** File-existence probe (must behave case-insensitively like NTFS). */
  isFile?: (path: string) => boolean;
}

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.JS;.WSF;.MSC";

function defaultIsFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function lowerExt(path: string): string {
  return winPath.extname(path).toLowerCase();
}

function isNativeExt(ext: string): boolean {
  return (WINDOWS_NATIVE_EXECUTABLE_EXTENSIONS as readonly string[]).includes(ext);
}

const GUIDANCE =
  "install native Claude Code (claude.exe) or set CC_LHC_CLAUDE_BIN to its absolute .exe path";

/**
 * Resolve the Claude executable on Windows to an absolute native executable.
 * Pure given seams — unit-testable on every platform.
 *
 * `candidate` is CC_LHC_CLAUDE_BIN when set, else "claude". A candidate that
 * already names a path (absolute or containing separators) is validated
 * directly (native extension required; extension-less candidates try the
 * native extensions). A bare name is searched through PATH in directory
 * order; within each directory, PATHEXT order decides — but only native
 * extensions are acceptable, and shim-only hits fail closed with guidance.
 */
export function resolveWindowsClaudeBin(
  candidate: string,
  seams: WindowsClaudeBinSeams = {},
): ClaudeBinResolution {
  const isFile = seams.isFile ?? defaultIsFile;
  const hasPathParts = candidate.includes("\\") || candidate.includes("/") || winPath.isAbsolute(candidate);

  if (hasPathParts) {
    const absolute = winPath.resolve(candidate);
    const ext = lowerExt(absolute);
    if (isNativeExt(ext)) {
      if (isFile(absolute)) return { ok: true, path: absolute };
      return { ok: false, reason: `Claude executable not found at ${absolute} — ${GUIDANCE}` };
    }
    if (ext === "") {
      for (const nativeExt of WINDOWS_NATIVE_EXECUTABLE_EXTENSIONS) {
        if (isFile(absolute + nativeExt)) return { ok: true, path: absolute + nativeExt };
      }
      return { ok: false, reason: `no native executable at ${absolute}(.exe|.com) — ${GUIDANCE}` };
    }
    return {
      ok: false,
      reason:
        `${absolute} is not a native executable (${ext}); cc-lhc will not route argv through ` +
        `cmd.exe to run shims — ${GUIDANCE}`,
    };
  }

  const pathextRaw = seams.pathextValue !== undefined && seams.pathextValue !== "" ? seams.pathextValue : DEFAULT_PATHEXT;
  const pathext = pathextRaw
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => ext.startsWith("."));
  const dirs = (seams.pathValue ?? "")
    .split(";")
    .map((dir) => dir.trim().replace(/^"(.*)"$/, "$1"))
    .filter((dir) => dir !== "");

  let shimHit: string | undefined;
  const candidateExt = lowerExt(candidate);
  for (const dir of dirs) {
    if (candidateExt !== "") {
      const direct = winPath.join(dir, candidate);
      if (isFile(direct)) {
        if (isNativeExt(candidateExt)) return { ok: true, path: winPath.resolve(direct) };
        if (shimHit === undefined && (WINDOWS_SHIM_EXTENSIONS as readonly string[]).includes(candidateExt)) {
          shimHit = direct;
        }
      }
    }
    for (const ext of pathext) {
      const probe = winPath.join(dir, candidate + ext);
      if (!isFile(probe)) continue;
      if (isNativeExt(ext)) return { ok: true, path: winPath.resolve(probe) };
      if (shimHit === undefined && (WINDOWS_SHIM_EXTENSIONS as readonly string[]).includes(ext)) {
        shimHit = probe;
      }
    }
  }
  if (shimHit !== undefined) {
    return {
      ok: false,
      reason:
        `PATH resolves ${candidate} only to a shell shim (${shimHit}); ConPTY needs a native ` +
        `executable and cc-lhc will not route argv through cmd.exe — ${GUIDANCE}`,
    };
  }
  return { ok: false, reason: `${candidate} not found on PATH — ${GUIDANCE}` };
}

export class ClaudeBinResolutionError extends Error {}

/**
 * Production entrypoint used by the wrapper and the inference adapter.
 * POSIX behavior is unchanged. On Windows this throws
 * ClaudeBinResolutionError with actionable guidance when no absolute native
 * executable can be resolved.
 */
export function resolveClaudeBin(): string {
  const override = process.env.CC_LHC_CLAUDE_BIN;
  const candidate = override !== undefined && override !== "" ? override : "claude";
  if (process.platform !== "win32") return candidate;
  const resolved = resolveWindowsClaudeBin(candidate, {
    pathValue: process.env.PATH ?? process.env.Path,
    pathextValue: process.env.PATHEXT,
  });
  if (!resolved.ok) throw new ClaudeBinResolutionError(`cc-lhc: ${resolved.reason}`);
  return resolved.path;
}
