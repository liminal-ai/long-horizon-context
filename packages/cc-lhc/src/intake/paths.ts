import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, posix as posixPath, win32 as winPath } from "node:path";

export function isWithinProfile(candidate: string, profileRoot: string, platform: NodeJS.Platform): boolean {
  const pathMod = platform === "win32" ? winPath : posixPath;
  const norm = (p: string): string => {
    const resolved = pathMod.resolve(p);
    const trimmed = resolved.length > 1 ? resolved.replace(/[\\/]+$/, "") : resolved;
    return platform === "win32" ? trimmed.toLowerCase() : trimmed;
  };
  const child = norm(candidate);
  const root = norm(profileRoot);
  if (child === root) return true;
  return child.startsWith(root + pathMod.sep);
}

/**
 * Canonicalize a host path for containment judgment by realpathing its
 * deepest EXISTING ancestor and reattaching the rest. On Windows this
 * expands 8.3 short names (`C:\Users\RUNNER~1`) and links to their real
 * spelling so lexical containment cannot be fooled by an alias of an
 * in-profile (or out-of-profile) location. Falls back to the input when
 * nothing exists.
 */
export function canonicalizeForContainment(path: string): string {
  let current = path;
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(current), ...[...tail].reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      tail.push(basename(current));
      current = parent;
    }
  }
}

export type CcLhcHomeResolution = { ok: true; path: string } | { ok: false; reason: string };

export function resolveCcLhcHome(
  override: string | undefined,
  homeDir: string,
  platform: NodeJS.Platform,
  canonicalize: (path: string) => string = (path) => path,
): CcLhcHomeResolution {
  const pathMod = platform === "win32" ? winPath : posixPath;
  if (override === undefined || override === "") {
    return { ok: true, path: pathMod.join(homeDir, ".cc-lhc") };
  }
  const resolved = pathMod.resolve(override);
  if (platform === "win32" && !isWithinProfile(canonicalize(resolved), canonicalize(homeDir), "win32")) {
    return {
      ok: false,
      reason:
        `CC_LHC_HOME=${override} resolves outside the user profile (${homeDir}). On Windows the ` +
        `runtime descriptor's confidentiality relies on the profile's default ACLs (no bespoke DACL ` +
        `is installed), so cc-lhc refuses a home outside it — use a directory under your profile`,
    };
  }
  return { ok: true, path: resolved };
}

export function ccLhcHome(): string {
  const resolution = resolveCcLhcHome(process.env.CC_LHC_HOME, homedir(), process.platform, canonicalizeForContainment);
  if (!resolution.ok) throw new Error(`cc-lhc: ${resolution.reason}`);
  return resolution.path;
}

export function defaultRegistryPath(): string {
  return join(ccLhcHome(), "registry.sqlite");
}

export function defaultLineageDbPath(): string {
  return join(ccLhcHome(), "cc-lhc.sqlite");
}

export function defaultThreadFilePath(): string {
  const dir = join(ccLhcHome(), "threads");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${randomUUID()}.sqlite`);
}

export function captureThreadRef(
  threadId: string,
  registryPath: string = defaultRegistryPath(),
): {
  threadId: string;
  registryPath: string;
} {
  return { threadId, registryPath };
}
