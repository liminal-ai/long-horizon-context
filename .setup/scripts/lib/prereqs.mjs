// Pure logic behind check-prereqs.mjs, split out so it can be unit-tested
// (packages/cc-lhc-native/test/setup-scripts.test.ts) without probing the
// host machine. No filesystem or process state is touched here except where
// a function takes it as an explicit argument.

export const NODE_FLOOR = { major: 24, minor: 17 };

/** Evaluate a Node version string ("24.18.0") against the tested floor. */
export function evaluateNodeVersion(version) {
  const [maj = 0, min = 0] = String(version)
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  const ok = maj > NODE_FLOOR.major || (maj === NODE_FLOOR.major && min >= NODE_FLOOR.minor);
  const note =
    maj > NODE_FLOOR.major
      ? `found v${version} (untested major — tested floor is ${NODE_FLOOR.major}.${NODE_FLOOR.minor}; report issues)`
      : `found v${version}`;
  return { ok, note };
}

/**
 * Map a platform/arch pair onto the prebuild target set. `targetKeys` comes
 * from packages/cc-lhc-native/targets.json — the single source of truth for
 * what cc-lhc natively supports.
 */
export function targetSupport(platform, arch, targetKeys) {
  const key = `${platform}-${arch}`;
  if (targetKeys.includes(key)) {
    return { ok: true, key };
  }
  return {
    ok: false,
    key,
    detail: `${key} is not a supported cc-lhc target; supported: ${targetKeys.join(", ")}`,
  };
}

/**
 * Auth-probe argv for the real `claude -p` call. `--no-session-persistence`
 * is mandatory: without it every probe writes a session file into the
 * caller's project directory and pollutes the wrapper's resume picker (the
 * exact defect fixed during the 2.1.226 certification). The prompt is a
 * single token with no spaces or shell metacharacters so the argv stays safe
 * under the Windows shell-resolution path.
 */
export function claudeAuthProbeArgs() {
  return ["-p", "--no-session-persistence", "ping"];
}

/**
 * Spawn options for probing a command by name. On Windows, `claude` and
 * `pnpm` are .cmd shims that Node refuses to execFile directly, so probes go
 * through the shell. Callers must only pass argv tokens matching
 * `safeProbeToken` — nothing here escapes shell metacharacters.
 */
export function probeSpawnOptions(platform) {
  return platform === "win32" ? { shell: true } : {};
}

export function safeProbeToken(token) {
  return /^[A-Za-z0-9._:=@/-]+$/.test(token);
}

/**
 * Windows native-Claude contract (mirrors the production resolver in
 * packages/cc-lhc/src/shared/claude-bin.ts, kept dist-free here): cc-lhc's
 * PTY layer (ConPTY) spawns absolute native executables only — a `.cmd`/npm
 * shim would require routing arbitrary argv through cmd.exe, which cc-lhc
 * refuses. Resolve `candidate` (CC_LHC_CLAUDE_BIN or "claude") through
 * PATH/PATHEXT accepting only .exe/.com; report a shim-only PATH with
 * actionable guidance. `isFile` must behave case-insensitively like NTFS.
 */
export function resolveWindowsClaudeExe(candidate, pathValue, pathextValue, isFile) {
  const NATIVE = [".exe", ".com"];
  const SHIMS = [".cmd", ".bat", ".ps1"];
  const guidance = "install native Claude Code (claude.exe) or set CC_LHC_CLAUDE_BIN to its absolute .exe path";
  const ext = (p) => {
    const m = /\.[^.\\/]+$/.exec(p);
    return m ? m[0].toLowerCase() : "";
  };
  if (candidate.includes("\\") || candidate.includes("/") || /^[A-Za-z]:/.test(candidate)) {
    const e = ext(candidate);
    if (NATIVE.includes(e)) {
      return isFile(candidate)
        ? { ok: true, path: candidate }
        : { ok: false, detail: `Claude executable not found at ${candidate} — ${guidance}` };
    }
    if (e === "") {
      for (const nativeExt of NATIVE) {
        if (isFile(candidate + nativeExt)) return { ok: true, path: candidate + nativeExt };
      }
      return { ok: false, detail: `no native executable at ${candidate}(.exe|.com) — ${guidance}` };
    }
    return { ok: false, detail: `${candidate} is not a native executable (${e}) — ${guidance}` };
  }
  const pathext = (pathextValue && pathextValue !== "" ? pathextValue : ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.startsWith("."));
  const dirs = (pathValue ?? "")
    .split(";")
    .map((dir) => dir.trim().replace(/^"(.*)"$/, "$1"))
    .filter((dir) => dir !== "");
  let shimHit;
  for (const dir of dirs) {
    for (const entryExt of pathext) {
      const probe = `${dir}\\${candidate}${entryExt}`;
      if (!isFile(probe)) continue;
      if (NATIVE.includes(entryExt)) return { ok: true, path: probe };
      if (shimHit === undefined && SHIMS.includes(entryExt)) shimHit = probe;
    }
  }
  if (shimHit !== undefined) {
    return {
      ok: false,
      detail: `PATH resolves ${candidate} only to a shell shim (${shimHit}); cc-lhc's PTY needs a native executable — ${guidance}`,
    };
  }
  return { ok: false, detail: `${candidate} not found on PATH — ${guidance}` };
}
