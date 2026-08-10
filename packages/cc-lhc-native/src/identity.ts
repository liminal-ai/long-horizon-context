/**
 * Normalized exact process identity over the native addon.
 *
 * Every platform yields the same shape — pid + bootId + starttime, with
 * starttime always a digits-only decimal string — so the existing cc-lhc
 * descriptor/owner schema (pid, bootId, starttime) carries it unchanged.
 * Unit semantics differ per platform and equality is only ever exact string
 * comparison, never arithmetic:
 *
 *   linux : starttime = clock ticks since boot; bootId = per-boot UUID
 *   darwin: starttime = microseconds since epoch (kernel timeval);
 *           bootId = kern.bootsessionuuid per-boot UUID
 *   win32 : starttime = creation FILETIME (100ns units since 1601, absolute);
 *           bootId = constant, uniqueness carried by pid + exact FILETIME
 *
 * All failures are results, not throws, so callers fail closed uniformly:
 * no PID-alive fallback, no seconds-resolution weakening.
 */

import {
  AddonArtifactMissingError,
  AddonContractError,
  type LoaderSeams,
  loadIdentityAddon,
  type NativeIdentityAddon,
  UnsupportedPlatformTargetError,
} from "./loader.js";

export type IdentityPlatform = "linux" | "darwin" | "win32";

export interface ExactProcessIdentity {
  platform: IdentityPlatform;
  pid: number;
  bootId: string;
  starttime: string;
}

export type IdentityFailureCode =
  | "invalid_pid"
  | "not_found"
  | "access_denied"
  | "native_error"
  | "unsupported_platform"
  | "addon_unavailable";

export type ReadIdentityResult =
  | { ok: true; identity: ExactProcessIdentity }
  | { ok: false; code: IdentityFailureCode; message: string };

const NATIVE_FAILURE_CODES: ReadonlySet<string> = new Set([
  "invalid_pid",
  "not_found",
  "access_denied",
  "native_error",
]);

const IDENTITY_PLATFORMS: ReadonlySet<string> = new Set(["linux", "darwin", "win32"]);

function failure(code: IdentityFailureCode, message: string): ReadIdentityResult {
  return { ok: false, code, message };
}

/**
 * Validate raw addon output; fail closed (native_error) on any malformed
 * shape rather than trusting the artifact.
 */
export function normalizeNativeResult(raw: unknown, pid: number, platform: IdentityPlatform): ReadIdentityResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return failure("native_error", "addon returned a non-object result");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.ok === true) {
    if (typeof obj.pid !== "number" || !Number.isInteger(obj.pid) || obj.pid !== pid) {
      return failure("native_error", "addon echoed a mismatched pid");
    }
    if (typeof obj.bootId !== "string" || obj.bootId.length < 8) {
      return failure("native_error", "addon returned an invalid bootId");
    }
    if (typeof obj.starttime !== "string" || !/^\d{1,20}$/.test(obj.starttime)) {
      return failure("native_error", "addon returned a non-numeric starttime");
    }
    return { ok: true, identity: { platform, pid, bootId: obj.bootId, starttime: obj.starttime } };
  }
  if (obj.ok === false) {
    const code =
      typeof obj.code === "string" && NATIVE_FAILURE_CODES.has(obj.code)
        ? (obj.code as IdentityFailureCode)
        : "native_error";
    const message = typeof obj.message === "string" && obj.message !== "" ? obj.message : code;
    return failure(code, message);
  }
  return failure("native_error", "addon result missing ok discriminant");
}

export type ExactIdentityReader = (pid: number) => ReadIdentityResult;

/**
 * Build a reader over the native addon. Loading happens once, lazily; loader
 * failures surface as per-call fail-closed results (unsupported_platform for
 * targets outside the manifest, addon_unavailable for missing/invalid
 * artifacts), never as throws, so integration code has one uniform contract.
 */
export function createExactIdentityReader(seams: LoaderSeams = {}): ExactIdentityReader {
  let cached: { addon: NativeIdentityAddon; platform: IdentityPlatform } | null = null;
  let loadFailure: ReadIdentityResult | null = null;

  return (pid: number): ReadIdentityResult => {
    if (!Number.isInteger(pid) || pid <= 0 || pid > Number.MAX_SAFE_INTEGER) {
      return failure("invalid_pid", `pid must be a positive integer, got ${String(pid)}`);
    }
    if (loadFailure !== null) return loadFailure;
    if (cached === null) {
      try {
        const loaded = loadIdentityAddon(seams);
        if (!IDENTITY_PLATFORMS.has(loaded.addon.platform)) {
          loadFailure = failure("addon_unavailable", `addon reports unknown platform ${loaded.addon.platform}`);
          return loadFailure;
        }
        cached = { addon: loaded.addon, platform: loaded.addon.platform as IdentityPlatform };
      } catch (cause) {
        if (cause instanceof UnsupportedPlatformTargetError) {
          loadFailure = failure("unsupported_platform", cause.message);
        } else if (cause instanceof AddonArtifactMissingError || cause instanceof AddonContractError) {
          loadFailure = failure("addon_unavailable", cause.message);
        } else {
          loadFailure = failure("addon_unavailable", cause instanceof Error ? cause.message : String(cause));
        }
        return loadFailure;
      }
    }
    let raw: unknown;
    try {
      raw = cached.addon.readProcessIdentity(pid);
    } catch (cause) {
      return failure("native_error", cause instanceof Error ? cause.message : String(cause));
    }
    return normalizeNativeResult(raw, pid, cached.platform);
  };
}

let defaultReader: ExactIdentityReader | null = null;

/** Production-default reader: real platform, real manifest, real artifact. */
export function readExactProcessIdentity(pid: number): ReadIdentityResult {
  if (defaultReader === null) {
    defaultReader = createExactIdentityReader();
  }
  return defaultReader(pid);
}

export function exactIdentitiesEqual(a: ExactProcessIdentity, b: ExactProcessIdentity): boolean {
  return a.platform === b.platform && a.pid === b.pid && a.bootId === b.bootId && a.starttime === b.starttime;
}

/**
 * Project to the schema cc-lhc descriptors/owners already store
 * (pid + bootId + starttime, stable key order). starttime stays a digits-only
 * string on every platform, so parseStoredProcessIdentity keeps working
 * unchanged; XP2 may additionally persist the platform tag.
 */
export function toPortableProcessIdentity(id: ExactProcessIdentity): {
  pid: number;
  bootId: string;
  starttime: string;
} {
  return { pid: id.pid, bootId: id.bootId, starttime: id.starttime };
}
