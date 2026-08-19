/**
 * What cc-lhc does when replacements repeatedly will not run (R6 and its
 * amendment, R16).
 *
 * Ordinary spawn trouble is discovered while the old session is still live and
 * untouched, so it costs nothing and is simply retried at the next settled
 * seam. What this module names is the case that does not resolve by retrying:
 * something about the rebuilt rollout itself the installed Claude will not
 * load, so every future seam would rebuild it and fail the same way.
 *
 * The diagnosis is explicitly a BEST GUESS, and says so wherever it is
 * surfaced. cc-lhc cannot observe "Claude rejected the file" — that would
 * require parsing the terminal, which this host never treats as canonical. All
 * it has is observable viability: the child survived, and the session file was
 * written. Repeated failure of that evidence is inference, not proof.
 *
 * Nothing here ends anything. The old session stays live and captured, the
 * operator keeps a working Claude, and manual compact still runs. What changes
 * is that automatic swaps stop instead of failing quietly on every seam, two
 * things happen in their place, and both persist:
 *
 *  - a standing, unmissable alarm the operator cannot miss or dismiss; and
 *  - R16's active survival relaunch — the old session is relaunched WITHOUT
 *    cc-lhc's injected native-auto-compact disable, so Claude's own compaction
 *    keeps it alive in degraded form instead of riding to the provider's hard
 *    cutoff. It has to happen then and there: the child that is running still
 *    carries the disable, so waiting for an incidental relaunch would not do it.
 */

/**
 * How many swaps whose replacement never became viable, in one wrapper
 * lifetime, before the alarm goes up and the old session is relaunched for
 * survival.
 *
 * An internal implementation constant, not a policy knob: it is not read from
 * argv, the environment, or any config file, and the wrapper exposes it only as
 * a test seam. What the story negotiates is that the retrying is *bounded* —
 * cheap retries first, then a loud, honest stop to retrying rather than a quiet
 * loop. The specific number is this module's business.
 *
 * It is greater than one on purpose: a swap that fails for a transient reason
 * must get at least one free retry at a later settled seam before cc-lhc
 * concludes anything about the installed Claude.
 */
export const NONVIABLE_SWAPS_BEFORE_ALARM = 3;

export interface ReplacementNonviabilityInput {
  rebuiltSessionId: string;
  oldSessionId: string;
  nonviableSwaps: number;
  lastReason: string;
}

/** The standing alarm, as displayed in the terminal, the log and the panel. */
export function formatReplacementNonviabilityAlarm(input: ReplacementNonviabilityInput): string[] {
  return [
    "ALARM: cc-lhc rebuilt sessions are not loading — likely a compatibility problem with the " +
      "installed Claude version.",
    `Replacement ${input.rebuiltSessionId} repeatedly failed to become viable ` +
      `(${input.nonviableSwaps} swap(s); last: ${input.lastReason}).`,
    "This is a best guess inferred from observable viability (process survival, session file writing). " +
      "cc-lhc cannot observe whether Claude rejected the rebuilt file and never parses the terminal to find out.",
    `Session ${input.oldSessionId} stays live and capture keeps running; only the automatic child swap stops. ` +
      "Manual compact still runs.",
  ];
}

/** What the wrapper did about keeping the old session alive (R16). */
export function formatSurvivalRelaunchNotice(oldSessionId: string, relaunched: boolean): string {
  return relaunched
    ? `cc-lhc relaunched session ${oldSessionId} without the injected DISABLE_AUTO_COMPACT so Claude's own ` +
        "automatic compaction can keep it alive in degraded form."
    : `cc-lhc could not relaunch session ${oldSessionId} without the injected DISABLE_AUTO_COMPACT; the ` +
        "running child still carries it, so native auto-compact will not rescue this session.";
}
