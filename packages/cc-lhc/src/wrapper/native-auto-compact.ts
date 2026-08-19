/**
 * Native Claude auto-compact policy for managed children (R8 + addendum, R12).
 *
 * cc-lhc owns compaction for a managed session, so every managed Claude child
 * launches with Claude's own automatic compaction off. The mechanism is the
 * per-child environment variable `DISABLE_AUTO_COMPACT`, verified in the
 * installed 2.1.232/2.1.233/2.1.234 binaries as:
 *
 *   if (env.DISABLE_COMPACT) return false;
 *   if (env.DISABLE_AUTO_COMPACT) return false;
 *   return setting("autoCompactEnabled", true).value
 *
 * so it overrides the `autoCompactEnabled` setting and touches no settings
 * file. `DISABLE_COMPACT` is deliberately NOT used: it would also remove
 * manual `/compact`, which stays available to the user (R8).
 *
 * R12: an explicit user `--autocompact` is the user's own Claude-level
 * authority. The flag passes through verbatim and cc-lhc omits its injected
 * disable for that launch, so the flag stays semantically real; the launch
 * records an anomaly notice instead of rejecting or stripping it.
 */

export const NATIVE_AUTO_COMPACT_DISABLE_ENV = "DISABLE_AUTO_COMPACT";
const NATIVE_AUTO_COMPACT_DISABLE_VALUE = "1";

/** Anomaly notice text for a launch that carries the user's own `--autocompact`. */
export const NATIVE_AUTOCOMPACT_OVERRIDE_ANOMALY =
  "ANOMALY: launch carries an explicit --autocompact; native auto-compact stays enabled for this Claude child " +
  "(cc-lhc omitted DISABLE_AUTO_COMPACT). LHC compaction continues normally.";

/**
 * True when the launch argv itself supplies native `--autocompact` before the
 * `--` passthrough boundary (space or `=` form).
 */
export function argvSuppliesNativeAutocompact(argv: readonly string[]): boolean {
  for (const arg of argv) {
    if (arg === "--") return false;
    if (arg === "--autocompact" || arg.startsWith("--autocompact=")) return true;
  }
  return false;
}

/**
 * Child environment for a managed Claude child. Adds the disable by default;
 * omits it when the user supplied their own `--autocompact` (R12).
 */
export function nativeAutoCompactChildEnv(
  baseEnv: Record<string, string>,
  userSuppliedAutocompact: boolean,
): Record<string, string> {
  if (userSuppliedAutocompact) return { ...baseEnv };
  return { ...baseEnv, [NATIVE_AUTO_COMPACT_DISABLE_ENV]: NATIVE_AUTO_COMPACT_DISABLE_VALUE };
}
