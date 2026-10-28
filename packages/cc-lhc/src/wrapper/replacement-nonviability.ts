export const NONVIABLE_SWAPS_BEFORE_ALARM = 3;

export interface ReplacementNonviabilityInput {
  rebuiltSessionId: string;
  oldSessionId: string;
  nonviableSwaps: number;
  lastReason: string;
}

export function formatReplacementNonviabilityAlarm(input: ReplacementNonviabilityInput): string[] {
  return [
    "ALARM: cc-lhc rebuilt sessions are not loading — likely a compatibility problem with the " +
      "installed Claude version.",
    `Replacement ${input.rebuiltSessionId} repeatedly failed to become viable ` +
      `(${input.nonviableSwaps} swap(s); last: ${input.lastReason}).`,
    "This is a best guess inferred from observable viability (process survival, session file writing). " +
      "cc-lhc cannot observe whether Claude rejected the rebuilt file and never parses the terminal to find out.",
    `Session ${input.oldSessionId} stays live and capture keeps running; only the automatic child swap stops. ` +
      "Manual Smart Compact still runs.",
  ];
}

export function formatSurvivalRelaunchNotice(oldSessionId: string, relaunched: boolean): string {
  return relaunched
    ? `cc-lhc relaunched session ${oldSessionId} without the injected DISABLE_AUTO_COMPACT so Claude native Compact ` +
        "can keep it alive in degraded form."
    : `cc-lhc could not relaunch session ${oldSessionId} without the injected DISABLE_AUTO_COMPACT; the ` +
        "running child still carries it, so Claude native Compact will not rescue this session.";
}
