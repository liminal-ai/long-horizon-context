/**
 * Deterministic, platform-neutral stand-in for the compiled cc_lhc_identity
 * addon, loaded through the documented CC_LHC_IDENTITY_ADDON test seam so
 * suites that run production-default code paths (wrapper run(), session-owner
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

const STUB_BOOT_ID = "cc-lhc-stub-boot-id-0000";

function syntheticStarttime(pid) {
  return String(1_000_000_000 + pid);
}

module.exports = {
  platform: process.platform,
  identityContractVersion: 1,
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
};
