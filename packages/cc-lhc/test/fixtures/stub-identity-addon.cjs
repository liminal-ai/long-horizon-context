/**
 * Deterministic, platform-neutral stand-in for the compiled cc_lhc_identity
 * addon, loaded through the documented CC_LHC_IDENTITY_ADDON test seam so
 * suites that run production-default code paths (wrapper run(), thread-owner
 * defaults, retrieval subprocesses) stay toolchain-free on native Linux,
 * macOS, and Windows.
 *
 * TEST-ONLY liveness mechanism: process.kill(pid, 0) — an existence probe on
 * every supported platform (ESRCH = no such process). The identity itself is
 * synthetic and a pure function of pid, so independent processes (e.g. a
 * retrieval subprocess validating a descriptor its parent wrote) compute the
 * same identity without any shared platform state. This deliberately cannot
 * detect PID reuse; invariant tests that need mismatching incarnations inject
 * probes instead. The real compiled addon is exercised by
 * test/runtime/native-identity.test.ts, which bypasses this seam.
 */

"use strict";

const { statSync } = require("node:fs");

const STUB_BOOT_ID = "cc-lhc-stub-boot-id-0000";

function syntheticStarttime(pid) {
  return String(1_000_000_000 + pid);
}

module.exports = {
  platform: process.platform,
  identityContractVersion: 3,
  stubBootId: STUB_BOOT_ID,
  syntheticStarttime,
  readProcessIdentity(pid) {
    if (!Number.isInteger(pid) || pid <= 0) {
      return { ok: false, code: "invalid_pid", message: `invalid pid ${String(pid)}` };
    }
    try {
      process.kill(pid, 0);
    } catch (cause) {
      const code = cause && cause.code;
      if (code === "ESRCH") {
        return { ok: false, code: "not_found", message: `no process with pid ${pid}` };
      }
      if (code === "EPERM" || code === "EACCES") {
        return { ok: false, code: "access_denied", message: `access denied probing pid ${pid}` };
      }
      return { ok: false, code: "native_error", message: String(cause) };
    }
    return { ok: true, pid, bootId: STUB_BOOT_ID, starttime: syntheticStarttime(pid) };
  },
  /**
   * TEST-ONLY file identity from Node's stat. On win32 Node's st_ino IS the
   * volume's 64-bit file index, so the index64 tag is truthful there; POSIX
   * keeps the addon's ino tag. Never id128 — the stub cannot read one.
   */
  readFileIdentity(path) {
    if (typeof path !== "string" || path === "" || path.includes("\0")) {
      return { ok: false, code: "invalid_path", message: "invalid path" };
    }
    try {
      const st = statSync(path, { bigint: true });
      if (!st.isFile()) return { ok: false, code: "not_a_file", message: "not a regular file" };
      const fileId =
        process.platform === "win32" ? `index64:${st.ino.toString()}` : `ino:${st.ino.toString()}`;
      return { ok: true, path, volumeId: st.dev.toString(), fileId };
    } catch (cause) {
      const code = cause && cause.code;
      if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, code: "not_found", message: "no such file" };
      if (code === "EACCES" || code === "EPERM") return { ok: false, code: "access_denied", message: "access denied" };
      return { ok: false, code: "native_error", message: String(cause) };
    }
  },
  /**
   * TEST-ONLY supervised-child control. Pause/resume use the POSIX signals
   * the real addon uses (no stand-in exists on win32, so the stub fails
   * closed there); the exit reader and file-holder lookup have no portable
   * stand-in and fail closed — suites that exercise them inject seams.
   */
  pauseProcess(pid) {
    return signalControl(pid, "SIGSTOP");
  },
  resumeProcess(pid) {
    return signalControl(pid, "SIGCONT");
  },
  readChildExit(pid) {
    return { ok: false, code: "native_error", message: `stub cannot read child exit for pid ${String(pid)}` };
  },
  findChildHoldingFile(parentPid, path) {
    return { ok: true, parentPid, path, pid: null, matches: 0 };
  },
};

function signalControl(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, code: "invalid_pid", message: `invalid pid ${String(pid)}` };
  }
  if (process.platform === "win32") {
    return { ok: false, code: "native_error", message: "stub has no win32 suspend/resume" };
  }
  try {
    process.kill(pid, signal);
  } catch (cause) {
    const code = cause && cause.code;
    if (code === "ESRCH") return { ok: false, code: "not_found", message: `no process with pid ${pid}` };
    if (code === "EPERM") return { ok: false, code: "access_denied", message: `access denied for pid ${pid}` };
    return { ok: false, code: "native_error", message: String(cause) };
  }
  return { ok: true, pid };
}
