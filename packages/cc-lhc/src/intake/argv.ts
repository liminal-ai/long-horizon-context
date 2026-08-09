/** UUID v4-ish shape used for Claude session ids and --session-id. */
export const SESSION_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSessionUuid(value: string): boolean {
  return SESSION_UUID_RE.test(value);
}

export function isArgvFlagToken(arg: string): boolean {
  return arg.startsWith("-");
}

/**
 * Session/cwd-changing flags inventory for Claude Code 2.1.226.
 * Capture-enabled launch refuses these unless an explicit attribution model exists.
 */
export const UNSUPPORTED_SESSION_CHANGING_FLAGS = [
  "--teleport",
  "--worktree",
  "-w",
  "--from-pr",
  "--cloud",
  "--remote-control",
  "--tmux",
] as const;

export type UnsupportedSessionFlag = (typeof UNSUPPORTED_SESSION_CHANGING_FLAGS)[number];

export function isUnsupportedSessionChangingFlag(arg: string): UnsupportedSessionFlag | undefined {
  for (const flag of UNSUPPORTED_SESSION_CHANGING_FLAGS) {
    if (arg === flag || arg.startsWith(`${flag}=`)) return flag;
  }
  return undefined;
}
