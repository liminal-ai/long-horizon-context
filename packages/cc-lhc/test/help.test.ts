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
      "--lhc-no-inference",
      "--lhc-no-notifier",
      "--lhc-auto-compact=on|off",
      "CC_LHC_HOME",
      "CC_LHC_CLAUDE_BIN",
      "CC_LHC_INPUT_DEBUG=FILE",
      "CC_LHC_RUNTIME_DESCRIPTOR",
      "BASH_MAX_OUTPUT_LENGTH",
      "XDG_CONFIG_HOME",
      "ctrl-]",
      "bounds <lower> <upper>",
    ]) {
      expect(CC_LHC_HELP).toContain(required);
    }
    expect(CC_LHC_HELP).toContain("--help, are forwarded");
  });

  it("advertises no capture-disabled or observe-only mode", () => {
    // Plain `claude` is the passthrough; cc-lhc has no product mode with its
    // core function switched off, and no live flag whose meaning is "do not
    // compact".
    expect(CC_LHC_HELP).not.toContain("--lhc-no-capture");
    expect(CC_LHC_HELP).not.toContain("--lhc-observe-only");
    expect(CC_LHC_HELP).not.toContain("--lhc-retry-growth-tokens");
  });
});
