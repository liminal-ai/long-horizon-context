import { describe, expect, it } from "vitest";

import {
  formatReplacementNonviabilityAlarm,
  formatSurvivalRelaunchNotice,
  NONVIABLE_SWAPS_BEFORE_ALARM,
} from "../../src/wrapper/replacement-nonviability.js";

const ALARM = formatReplacementNonviabilityAlarm({
  rebuiltSessionId: "new-2222",
  oldSessionId: "old-1111",
  nonviableSwaps: 3,
  lastReason: "attempt 1: candidate no_output",
}).join("\n");

describe("the bound on retrying a swap that will not run", () => {
  it("leaves at least one free retry before cc-lhc concludes anything", () => {
    expect(NONVIABLE_SWAPS_BEFORE_ALARM).toBeGreaterThan(1);
    expect(Number.isInteger(NONVIABLE_SWAPS_BEFORE_ALARM)).toBe(true);
  });
});

describe("the standing alarm", () => {
  it("names the likely cause and the evidence it was inferred from", () => {
    expect(ALARM).toContain("cc-lhc rebuilt sessions are not loading");
    expect(ALARM).toContain("likely a compatibility problem with the installed Claude version");
    expect(ALARM).toContain("repeatedly failed to become viable");
    expect(ALARM).toContain("3 swap(s); last: attempt 1: candidate no_output");
  });

  it("states that it is a best guess, not proof Claude rejected the file", () => {
    expect(ALARM).toContain("best guess");
    expect(ALARM).toContain("cannot observe whether Claude rejected the rebuilt file");
    expect(ALARM).toContain("never parses the terminal");
  });

  it("says what is still working, and never claims anything ended", () => {
    expect(ALARM).toContain("Session old-1111 stays live and capture keeps running");
    expect(ALARM).toContain("Manual Smart Compact still runs");
    expect(ALARM).not.toContain("/smart-compact");
    expect(ALARM).toContain("only the automatic child swap stops");
    for (const ended of ["terminal state", "dead", "unrecoverable", "gave up", "wall"]) {
      expect(ALARM.toLowerCase()).not.toContain(ended);
    }
  });
});

describe("the survival relaunch notice", () => {
  it("says the old session was relaunched without the injected disable", () => {
    const notice = formatSurvivalRelaunchNotice("old-1111", true);
    expect(notice).toContain("relaunched session old-1111 without the injected DISABLE_AUTO_COMPACT");
    expect(notice).toContain("keep it alive in degraded form");
  });

  it("is honest when the relaunch did not happen, and says what that costs", () => {
    const notice = formatSurvivalRelaunchNotice("old-1111", false);
    expect(notice).toContain("could not relaunch session old-1111");
    expect(notice).toContain("running child still carries it");
    expect(notice).toContain("Claude native Compact will not rescue this session");
  });
});
