/** UUID v4-ish shape used for Claude session ids and --session-id. */
export const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSessionUuid(value: string): boolean {
  return SESSION_UUID_RE.test(value);
}

export function isArgvFlagToken(arg: string): boolean {
  return arg.startsWith("-");
}

/**
 * Session/cwd/topology-changing flags a capture-enabled launch refuses (attribution
 * is not modeled for them). Revalidated against Claude Code 2.1.233 `--help`. The
 * 2.1.233 additions `--background`/`--bg` (detached background agent), `--environment`
 * (self-hosted cloud session), and `--no-session-persistence` (no on-disk rollout to
 * capture) each break local durable attribution/topology and are refused here.
 * `--fork-session` keeps its dedicated launch-grammar handling (it is not listed here).
 */
export const UNSUPPORTED_SESSION_CHANGING_FLAGS = [
  "--teleport",
  "--worktree",
  "-w",
  "--from-pr",
  "--cloud",
  "--remote-control",
  "--tmux",
  "--background",
  "--bg",
  "--environment",
  "--no-session-persistence",
] as const;

export type UnsupportedSessionFlag = (typeof UNSUPPORTED_SESSION_CHANGING_FLAGS)[number];

export function isUnsupportedSessionChangingFlag(arg: string): UnsupportedSessionFlag | undefined {
  for (const flag of UNSUPPORTED_SESSION_CHANGING_FLAGS) {
    if (arg === flag || arg.startsWith(`${flag}=`)) return flag;
  }
  return undefined;
}

/**
 * Explicit `--autocompact` classification for a capture-enabled, ARMED LHC launch
 * (LIM-80 Slice 4). Claude Code 2.1.233 documents `--autocompact <auto|tokens>`:
 * `auto`, or an integer token count in **100k–1M** with an optional case-insensitive
 * `k`/`m` suffix. Native compaction at or below the LHC upper trigger would undercut
 * the governor, so the LHC refuses any explicit value it cannot prove is safe. Only a
 * value that parses, is in the documented range, is a safe integer, AND is STRICTLY
 * ABOVE `upperBoundTokens` is accepted (the operator opted into a higher native
 * window). The value is never silently raised or overridden.
 */
export type ExplicitAutocompact =
  | { kind: "absent" }
  | { kind: "accept"; tokens: number }
  | { kind: "refuse"; reason: string };

/** Documented `--autocompact` numeric range for the supported Claude Code (2.1.233). */
export const AUTOCOMPACT_MIN_TOKENS = 100_000;
export const AUTOCOMPACT_MAX_TOKENS = 1_000_000;

/** Parse a documented `--autocompact` token value (`500000`, `500k`, `1m`), case-insensitive. */
export function parseAutocompactTokens(raw: string): number | null {
  const m = /^(\d+)(k|m)?$/i.exec(raw.trim());
  if (m === null) return null;
  const base = Number(m[1]);
  if (!Number.isSafeInteger(base)) return null;
  const suffix = m[2]?.toLowerCase();
  const mult = suffix === "k" ? 1_000 : suffix === "m" ? 1_000_000 : 1;
  const tokens = base * mult;
  return Number.isSafeInteger(tokens) ? tokens : null;
}

export function classifyExplicitAutocompact(argv: readonly string[], upperBoundTokens: number): ExplicitAutocompact {
  // Only tokens BEFORE a bare `--` are flags; a positional prompt after `--` is not.
  const values: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--") break;
    if (arg === "--autocompact") {
      const next = i + 1 < argv.length ? argv[i + 1]! : undefined;
      // A required value that is missing, `--`, or another flag is unprovable.
      const provable = next !== undefined && next !== "--" && !next.startsWith("-");
      values.push(provable ? next! : "");
      if (provable) i += 1;
    } else if (arg.startsWith("--autocompact=")) {
      values.push(arg.slice("--autocompact=".length));
    }
  }
  if (values.length === 0) return { kind: "absent" };
  if (values.length > 1) return { kind: "refuse", reason: "duplicate --autocompact flags" };
  const value = values[0]!;
  if (value === "") return { kind: "refuse", reason: "--autocompact has a missing/unprovable value" };
  if (value.toLowerCase() === "auto") {
    return { kind: "refuse", reason: "--autocompact auto lets native compaction fire below the LHC trigger" };
  }
  const tokens = parseAutocompactTokens(value);
  if (tokens === null) {
    return { kind: "refuse", reason: `--autocompact ${value} is not a valid token count (auto, or 100k–1M)` };
  }
  if (tokens < AUTOCOMPACT_MIN_TOKENS || tokens > AUTOCOMPACT_MAX_TOKENS) {
    return { kind: "refuse", reason: `--autocompact ${value} is outside the documented 100k–1M range` };
  }
  if (tokens <= upperBoundTokens) {
    return {
      kind: "refuse",
      reason: `--autocompact ${tokens} is at/below the LHC upper trigger ${upperBoundTokens}`,
    };
  }
  return { kind: "accept", tokens };
}
