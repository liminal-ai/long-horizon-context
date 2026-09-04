/**
 * Supervised-child control over the native addon (identity contract 3,
 * LIM-149).
 *
 * During Smart Compact the wrapper replaces its Claude child and keeps the
 * old child paused as the supervisor of its own still-running background
 * tasks, so each task's real exit outcome survives the replacement. These
 * four calls are the whole portable surface for that:
 *
 *   pause / resume            — stop or continue every thread of the child
 *   readChildExit             — the uncollected exit record of a task whose
 *                               supervisor is paused (running | exited code |
 *                               signaled), gated on the recorded starttime
 *   findChildHoldingFile      — which direct child of a pid holds a file open
 *
 * Every target is a child the wrapper spawned; callers gate on exact identity
 * before calling. Failures are results, never throws, so callers fail closed.
 */

import {
  AddonArtifactMissingError,
  AddonContractError,
  type LoaderSeams,
  loadIdentityAddon,
  type NativeIdentityAddon,
  UnsupportedPlatformTargetError,
} from "./loader.js";

export type ProcessControlFailureCode =
  | "invalid_pid"
  | "invalid_path"
  | "not_found"
  | "identity_changed"
  | "access_denied"
  | "native_error"
  | "unsupported_platform"
  | "addon_unavailable";

export type ProcessControlFailure = { ok: false; code: ProcessControlFailureCode; message: string };

export type ControlResult = { ok: true; pid: number } | ProcessControlFailure;

export type ChildExitState =
  | { state: "running" }
  | { state: "exited"; code: number }
  | { state: "signaled"; signal: number };

export type ReadChildExitResult = ({ ok: true; pid: number } & ChildExitState) | ProcessControlFailure;

export type FindChildHoldingFileResult =
  | { ok: true; parentPid: number; path: string; pid: number | null; matches: number; detail?: string }
  | ProcessControlFailure;

export interface ProcessControl {
  pause(pid: number): ControlResult;
  resume(pid: number): ControlResult;
  readChildExit(pid: number, starttime: string): ReadChildExitResult;
  findChildHoldingFile(parentPid: number, path: string): FindChildHoldingFileResult;
}

const NATIVE_FAILURE_CODES: ReadonlySet<string> = new Set([
  "invalid_pid",
  "invalid_path",
  "not_found",
  "identity_changed",
  "access_denied",
  "native_error",
]);

function failure(code: ProcessControlFailureCode, message: string): ProcessControlFailure {
  return { ok: false, code, message };
}

function nativeFailure(obj: Record<string, unknown>): ProcessControlFailure {
  const code =
    typeof obj.code === "string" && NATIVE_FAILURE_CODES.has(obj.code)
      ? (obj.code as ProcessControlFailureCode)
      : "native_error";
  const message = typeof obj.message === "string" && obj.message !== "" ? obj.message : code;
  return failure(code, message);
}

function asObject(raw: unknown): Record<string, unknown> | null {
  return raw === null || typeof raw !== "object" || Array.isArray(raw) ? null : (raw as Record<string, unknown>);
}

function validPid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Validate a pause/resume result; fail closed on any malformed shape. */
export function normalizeControlResult(raw: unknown, pid: number): ControlResult {
  const obj = asObject(raw);
  if (obj === null) return failure("native_error", "addon returned a non-object result");
  if (obj.ok === true) {
    if (obj.pid !== pid) return failure("native_error", "addon echoed a mismatched pid");
    return { ok: true, pid };
  }
  if (obj.ok === false) return nativeFailure(obj);
  return failure("native_error", "addon result missing ok discriminant");
}

/** Validate a readChildExit result; fail closed on any malformed shape. */
export function normalizeChildExitResult(raw: unknown, pid: number): ReadChildExitResult {
  const obj = asObject(raw);
  if (obj === null) return failure("native_error", "addon returned a non-object result");
  if (obj.ok === true) {
    if (obj.pid !== pid) return failure("native_error", "addon echoed a mismatched pid");
    if (obj.state === "running") return { ok: true, pid, state: "running" };
    if (obj.state === "exited") {
      if (typeof obj.code !== "number" || !Number.isSafeInteger(obj.code) || obj.code < 0) {
        return failure("native_error", "addon returned an invalid exit code");
      }
      return { ok: true, pid, state: "exited", code: obj.code };
    }
    if (obj.state === "signaled") {
      if (typeof obj.signal !== "number" || !Number.isSafeInteger(obj.signal) || obj.signal <= 0) {
        return failure("native_error", "addon returned an invalid signal");
      }
      return { ok: true, pid, state: "signaled", signal: obj.signal };
    }
    return failure("native_error", "addon returned an unknown child state");
  }
  if (obj.ok === false) return nativeFailure(obj);
  return failure("native_error", "addon result missing ok discriminant");
}

/** Validate a findChildHoldingFile result; fail closed on any malformed shape. */
export function normalizeHolderResult(raw: unknown, parentPid: number, path: string): FindChildHoldingFileResult {
  const obj = asObject(raw);
  if (obj === null) return failure("native_error", "addon returned a non-object result");
  if (obj.ok === true) {
    if (obj.parentPid !== parentPid) return failure("native_error", "addon echoed a mismatched parent pid");
    if (obj.path !== path) return failure("native_error", "addon echoed a mismatched path");
    if (typeof obj.matches !== "number" || !Number.isSafeInteger(obj.matches) || obj.matches < 0) {
      return failure("native_error", "addon returned an invalid match count");
    }
    const detail = typeof obj.detail === "string" && obj.detail !== "" ? { detail: obj.detail } : {};
    if (obj.pid === null) return { ok: true, parentPid, path, pid: null, matches: obj.matches, ...detail };
    if (!validPid(obj.pid) || obj.matches !== 1) {
      return failure("native_error", "addon returned an invalid holder pid");
    }
    return { ok: true, parentPid, path, pid: obj.pid, matches: 1, ...detail };
  }
  if (obj.ok === false) return nativeFailure(obj);
  return failure("native_error", "addon result missing ok discriminant");
}

/** Build the control surface over the native addon; loader failures become per-call fail-closed results. */
export function createProcessControl(seams: LoaderSeams = {}): ProcessControl {
  let cached: NativeIdentityAddon | null = null;
  let loadFailure: ProcessControlFailure | null = null;
  const addon = (): NativeIdentityAddon | ProcessControlFailure => {
    if (loadFailure !== null) return loadFailure;
    if (cached !== null) return cached;
    try {
      cached = loadIdentityAddon(seams).addon;
      return cached;
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
  };
  const call = <T>(
    fn: (a: NativeIdentityAddon) => unknown,
    normalize: (raw: unknown) => T,
    onThrow: (f: ProcessControlFailure) => T,
  ): T => {
    const loaded = addon();
    if ("ok" in loaded) return onThrow(loaded);
    let raw: unknown;
    try {
      raw = fn(loaded);
    } catch (cause) {
      return onThrow(failure("native_error", cause instanceof Error ? cause.message : String(cause)));
    }
    return normalize(raw);
  };
  const pidGuard = (pid: number): ProcessControlFailure | null =>
    validPid(pid) ? null : failure("invalid_pid", "pid must be a positive safe integer");
  return {
    pause(pid) {
      return (
        pidGuard(pid) ??
        call(
          (a) => a.pauseProcess(pid),
          (raw) => normalizeControlResult(raw, pid),
          (f) => f,
        )
      );
    },
    resume(pid) {
      return (
        pidGuard(pid) ??
        call(
          (a) => a.resumeProcess(pid),
          (raw) => normalizeControlResult(raw, pid),
          (f) => f,
        )
      );
    },
    readChildExit(pid, starttime) {
      const guard = pidGuard(pid);
      if (guard !== null) return guard;
      if (typeof starttime !== "string" || !/^\d{1,30}$/.test(starttime)) {
        return failure("invalid_pid", "starttime must be a digits-only string");
      }
      return call(
        (a) => a.readChildExit(pid, starttime),
        (raw) => normalizeChildExitResult(raw, pid),
        (f) => f,
      );
    },
    findChildHoldingFile(parentPid, path) {
      const guard = pidGuard(parentPid);
      if (guard !== null) return guard;
      if (typeof path !== "string" || path === "" || path.includes("\0")) {
        return failure("invalid_path", "path must be a non-empty string without NUL");
      }
      return call(
        (a) => a.findChildHoldingFile(parentPid, path),
        (raw) => normalizeHolderResult(raw, parentPid, path),
        (f) => f,
      );
    },
  };
}

let defaultControl: ProcessControl | null = null;

/** Production-default control surface: real platform, real manifest, real artifact. */
export function exactProcessControl(): ProcessControl {
  if (defaultControl === null) defaultControl = createProcessControl();
  return defaultControl;
}
