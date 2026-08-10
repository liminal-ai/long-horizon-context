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
