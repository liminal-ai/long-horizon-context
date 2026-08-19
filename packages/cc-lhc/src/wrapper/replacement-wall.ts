/**
 * The one accepted terminal state of the swap: replacements that repeatedly
 * will not run (R6 and its amendment, R16).
 *
 * Ordinary spawn trouble is discovered while the old session is still live and
 * untouched, so it costs nothing and is simply retried at the next settled
 * seam. What this module names is the case that does not resolve by retrying:
 * something about the rebuilt rollout itself the installed Claude will not
 * load, so every future seam would rebuild it and fail the same way.
 *
 * The wall is explicitly a BEST GUESS, and says so wherever it is surfaced.
 * cc-lhc cannot observe "Claude rejected the file" — that would require parsing
 * the terminal, which this host never treats as canonical. All it has is
 * observable viability: the child survived, and the session file was written.
 * Repeated failure of that evidence is inference, not proof.
 *
 * When the wall is reached the answer is never a quiet retry loop and never a
 * rollback (nothing was switched away from). It is a standing, unmissable alarm
 * plus R16's active survival relaunch: the old session is relaunched WITHOUT
 * cc-lhc's injected native-auto-compact disable, so Claude's own compaction
 * keeps it alive in degraded form instead of riding to the provider's hard
 * cutoff. Waiting for an incidental relaunch would not do that — the running
 * child still carries the disable.
 */

/** Nonviable swaps in one wrapper lifetime before the wall is declared. */
export const DEFAULT_NONVIABLE_SWAP_LIMIT = 3;

export interface ReplacementWallInput {
  rebuiltSessionId: string;
  oldSessionId: string;
  nonviableSwaps: number;
  lastReason: string;
}

/** The standing alarm, as displayed in the terminal, the log and the panel. */
export function formatReplacementWallAlarm(input: ReplacementWallInput): string[] {
  return [
    "ALARM: cc-lhc rebuilt sessions are not loading — likely a compatibility problem with the " +
      "installed Claude version.",
    `Replacement ${input.rebuiltSessionId} repeatedly failed to become viable ` +
      `(${input.nonviableSwaps} swap(s); last: ${input.lastReason}).`,
    "This is a best guess inferred from observable viability (process survival, session file writing). " +
      "cc-lhc cannot observe whether Claude rejected the rebuilt file and never parses the terminal to find out.",
    `Session ${input.oldSessionId} stays live and capture keeps running; only the child swap is unavailable.`,
  ];
}

/** What the wrapper did about survival once the wall was declared (R16). */
export function formatSurvivalRelaunchNotice(oldSessionId: string, relaunched: boolean): string {
  return relaunched
    ? `cc-lhc relaunched session ${oldSessionId} without the injected DISABLE_AUTO_COMPACT so Claude's own ` +
        "automatic compaction can keep it alive in degraded form."
    : `cc-lhc could not relaunch session ${oldSessionId} without the injected DISABLE_AUTO_COMPACT; the ` +
        "running child still carries it, so native auto-compact will not rescue this session.";
}
