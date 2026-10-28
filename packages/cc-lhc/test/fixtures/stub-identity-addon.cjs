"use strict";

const { statSync } = require("node:fs");

const STUB_BOOT_ID = "cc-lhc-stub-boot-id-0000";

function syntheticStarttime(pid) {
  return String(1_000_000_000 + pid);
}

module.exports = {
  platform: process.platform,
  identityContractVersion: 4,
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
  bindChildToWrapperJob() {
    return { ok: false, code: "unsupported", message: "stub has no process-tree job" };
  },
  listFileHolders() {
    return { ok: false, code: "unsupported", message: "stub has no holder list" };
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
