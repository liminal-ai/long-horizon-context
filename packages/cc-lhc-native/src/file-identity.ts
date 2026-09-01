/**
 * Exact file identity over the native addon (LIM-145 Windows background-shell
 * adoption).
 *
 * The identity of a file is read from the opened file object, never derived
 * from the path or from Node's stat on Windows:
 *
 *   linux/darwin: volumeId = st_dev, fileId = "ino:<st_ino>"
 *   win32       : volumeId = volume serial, fileId = "id128:<hex>" (NTFS/ReFS
 *                 128-bit file id) or "index64:<n>" on volumes without one
 *
 * Equality is exact string equality of both parts; the fileId tag keeps an
 * index64 value from ever matching an id128 one. Failures are results.
 */

import {
  AddonArtifactMissingError,
  AddonContractError,
  type LoaderSeams,
  loadIdentityAddon,
  type NativeIdentityAddon,
  UnsupportedPlatformTargetError,
} from "./loader.js";

export interface ExactFileIdentity {
  platform: "linux" | "darwin" | "win32";
  path: string;
  volumeId: string;
  fileId: string;
}

export type FileIdentityFailureCode =
  | "invalid_path"
  | "not_found"
  | "access_denied"
  | "not_a_file"
  | "native_error"
  | "unsupported_platform"
  | "addon_unavailable";

export type ReadFileIdentityResult =
  | { ok: true; identity: ExactFileIdentity }
  | { ok: false; code: FileIdentityFailureCode; message: string };

const NATIVE_FAILURE_CODES: ReadonlySet<string> = new Set([
  "invalid_path",
  "not_found",
  "access_denied",
  "not_a_file",
  "native_error",
]);
const IDENTITY_PLATFORMS: ReadonlySet<string> = new Set(["linux", "darwin", "win32"]);
const FILE_ID_PATTERN = /^(?:ino:\d{1,20}|id128:[0-9a-f]{32}|index64:\d{1,20})$/;

function failure(code: FileIdentityFailureCode, message: string): ReadFileIdentityResult {
  return { ok: false, code, message };
}

/** Validate raw addon output; fail closed on any malformed shape. */
export function normalizeNativeFileResult(
  raw: unknown,
  path: string,
  platform: ExactFileIdentity["platform"],
): ReadFileIdentityResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return failure("native_error", "addon returned a non-object result");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.ok === true) {
    if (obj.path !== path) return failure("native_error", "addon echoed a mismatched path");
    if (typeof obj.volumeId !== "string" || !/^\d{1,20}$/.test(obj.volumeId)) {
      return failure("native_error", "addon returned an invalid volumeId");
    }
    if (typeof obj.fileId !== "string" || !FILE_ID_PATTERN.test(obj.fileId)) {
      return failure("native_error", "addon returned an invalid fileId");
    }
    return { ok: true, identity: { platform, path, volumeId: obj.volumeId, fileId: obj.fileId } };
  }
  if (obj.ok === false) {
    const code =
      typeof obj.code === "string" && NATIVE_FAILURE_CODES.has(obj.code)
        ? (obj.code as FileIdentityFailureCode)
        : "native_error";
    const message = typeof obj.message === "string" && obj.message !== "" ? obj.message : code;
    return failure(code, message);
  }
  return failure("native_error", "addon result missing ok discriminant");
}

export type ExactFileIdentityReader = (path: string) => ReadFileIdentityResult;

/** Build a reader over the native addon; loader failures become per-call fail-closed results. */
export function createExactFileIdentityReader(seams: LoaderSeams = {}): ExactFileIdentityReader {
  let cached: { addon: NativeIdentityAddon; platform: ExactFileIdentity["platform"] } | null = null;
  let loadFailure: ReadFileIdentityResult | null = null;
  return (path: string): ReadFileIdentityResult => {
    if (typeof path !== "string" || path === "" || path.includes("\0")) {
      return failure("invalid_path", "path must be a non-empty string without NUL");
    }
    if (loadFailure !== null) return loadFailure;
    if (cached === null) {
      try {
        const loaded = loadIdentityAddon(seams);
        if (!IDENTITY_PLATFORMS.has(loaded.addon.platform)) {
          loadFailure = failure("addon_unavailable", `addon reports unknown platform ${loaded.addon.platform}`);
          return loadFailure;
        }
        cached = { addon: loaded.addon, platform: loaded.addon.platform as ExactFileIdentity["platform"] };
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
      raw = cached.addon.readFileIdentity(path);
    } catch (cause) {
      return failure("native_error", cause instanceof Error ? cause.message : String(cause));
    }
    return normalizeNativeFileResult(raw, path, cached.platform);
  };
}

let defaultReader: ExactFileIdentityReader | null = null;

/** Production-default reader: real platform, real manifest, real artifact. */
export function readExactFileIdentity(path: string): ReadFileIdentityResult {
  if (defaultReader === null) defaultReader = createExactFileIdentityReader();
  return defaultReader(path);
}

export function exactFileIdentitiesEqual(a: ExactFileIdentity, b: ExactFileIdentity): boolean {
  return a.platform === b.platform && a.volumeId === b.volumeId && a.fileId === b.fileId;
}
