/**
 * TC-3.2a/TC-3.2b: the first standalone `--` ends CC-LHC parsing; every later
 * token forwards to Claude unchanged. Exercises the real production parser
 * used by src/cli.ts, not a copy.
 */
import { describe, expect, it } from "vitest";

import { isLhcVersionArgv, parseWrapperArgv } from "../src/cli-args.js";

const ENV: NodeJS.ProcessEnv = {};

function parsedOrThrow(argv: string[]) {
  const result = parseWrapperArgv(argv, ENV);
  if (!result.ok) throw new Error(result.message);
  return result.parsed;
}

describe("wrapper argv `--` boundary", () => {
  it("forwards --lhc-* lookalikes after -- as Claude-side input (TC-3.2a)", () => {
    const parsed = parsedOrThrow(["-p", "--", "--lhc-help", "--lhc-no-inference", "text"]);
    expect(parsed.claudeArgv).toEqual(["-p", "--", "--lhc-help", "--lhc-no-inference", "text"]);
    expect(parsed.noInference).toBe(false);
  });

  it("keeps consuming wrapper flags before -- and stops exactly at it", () => {
    const parsed = parsedOrThrow(["--lhc-no-inference", "--model", "opus", "--", "--lhc-upper-bound-tokens=1"]);
    expect(parsed.noInference).toBe(true);
    expect(parsed.claudeArgv).toEqual(["--model", "opus", "--", "--lhc-upper-bound-tokens=1"]);
    expect(parsed.contextPolicyOverrides).toEqual({});
  });

  it("treats only the first -- as the boundary", () => {
    const parsed = parsedOrThrow(["--", "--lhc-profile=historical", "--", "tail"]);
    expect(parsed.claudeArgv).toEqual(["--", "--lhc-profile=historical", "--", "tail"]);
    expect(parsed.contextPolicyOverrides).toEqual({});
  });

  it("rejects unknown --lhc-* flags before -- with the existing error (TC-3.2b)", () => {
    const result = parseWrapperArgv(["--lhc-bogus", "--", "ok"], ENV);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("Unknown cc-lhc flag: --lhc-bogus");
  });

  it("keeps consuming known wrapper flags exactly as before the correction", () => {
    const parsed = parsedOrThrow([
      "--lhc-upper-bound-tokens=140000",
      "--lhc-lower-bound-tokens=70000",
      "--lhc-auto-compact=off",
      "--lhc-profile=balanced",
      "--lhc-min-runway-tokens=40000",
      "--lhc-no-notifier",
      "--model",
      "opus",
    ]);
    expect(parsed.claudeArgv).toEqual(["--model", "opus"]);
    expect(parsed.notifierDisabled).toBe(true);
    expect(parsed.contextPolicyOverrides).toEqual({
      upperBoundTokens: 140_000,
      lowerBoundTokens: 70_000,
      autoCompact: false,
      profile: "balanced",
      minRunwayTokens: 40_000,
    });
  });

  it("honors CC_LHC_NO_INFERENCE from the environment", () => {
    const result = parseWrapperArgv(["--model", "opus"], { CC_LHC_NO_INFERENCE: "1" });
    expect(result.ok && result.parsed.noInference).toBe(true);
  });
});

describe("--lhc-version argv form", () => {
  it("claims only the exact single-argument invocation", () => {
    expect(isLhcVersionArgv(["--lhc-version"])).toBe(true);
    expect(isLhcVersionArgv(["--lhc-version", "--model", "opus"])).toBe(false);
    expect(isLhcVersionArgv(["--version"])).toBe(false);
    expect(isLhcVersionArgv([])).toBe(false);
  });
});
