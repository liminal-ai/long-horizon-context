import { describe, expect, it } from "vitest";

import { CC_LHC_HELP, isLhcHelpArgv } from "../src/help.js";

describe("cc-lhc help surface", () => {
  it("claims only the wrapper-specific help flag", () => {
    expect(isLhcHelpArgv(["--lhc-help"])).toBe(true);
    expect(isLhcHelpArgv(["--help"])).toBe(false);
    expect(isLhcHelpArgv(["--lhc-help", "--model", "sonnet"])).toBe(false);
  });

  it("lists commands, flags, environment, and the control panel", () => {
    for (const required of [
      "get-turns",
      "--from TOKENS",
      "get-messages",
      "backfill-labels",
      "--lhc-no-capture",
      "--lhc-no-inference",
      "--lhc-no-notifier",
      "--lhc-auto-compact=on|off",
      "--lhc-observe-only",
      "CC_LHC_HOME",
      "CC_LHC_CLAUDE_BIN",
      "CC_LHC_INPUT_DEBUG=FILE",
      "CC_LHC_RUNTIME_DESCRIPTOR",
      "ctrl-]",
      "bounds <lower> <upper>",
    ]) {
      expect(CC_LHC_HELP).toContain(required);
    }
    expect(CC_LHC_HELP).toContain("--help, pass through to Claude");
  });
});
