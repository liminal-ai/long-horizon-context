import { describe, expect, it } from "vitest";
import { extensionFlagValuesFromLaunch, LHC_FLAG_CONTINUE, LHC_FLAG_THREAD } from "../../src/index.js";
import { launcherHelpText, parseLauncherArgv, piSessionFlagsConflict } from "../../src/launcher/parse-args.js";

describe("launcher parseLauncherArgv", () => {
  it("strips explicit LHC flags and validates attach modes", () => {
    const parsed = parseLauncherArgv(["--lhc-thread", "th_abc", "--model", "anthropic/claude", "--lhc-continue"]);
    expect(parsed.launchRead).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "conflicting_lhc_launch_flags" }),
    });
    expect(parsed.piArgv).toEqual(["--model", "anthropic/claude"]);
  });

  it("passes through attach flags to PI argv after stripping", () => {
    const parsed = parseLauncherArgv(["--lhc-thread", "th_abc", "--model", "anthropic/claude"]);
    expect(parsed.launchRead).toEqual({ ok: true, value: { thread: "th_abc" } });
    expect(parsed.piArgv).toEqual(["--model", "anthropic/claude"]);
    if (!parsed.launchRead.ok) throw new Error("expected ok launch read");
    const flags = extensionFlagValuesFromLaunch(parsed.launchRead.value);
    expect(flags.get(LHC_FLAG_THREAD)).toBe("th_abc");
  });

  it("supports --lhc-thread=id form", () => {
    const parsed = parseLauncherArgv(["--lhc-thread=th_xyz", "hello"]);
    expect(parsed.launchRead).toEqual({ ok: true, value: { thread: "th_xyz" } });
    expect(parsed.piArgv).toEqual(["hello"]);
  });

  it("fails loud when thread attach modes conflict", () => {
    const parsed = parseLauncherArgv(["--lhc-thread", "th_a", "--lhc-continue"]);
    expect(parsed.launchRead.ok).toBe(false);
  });

  it("sets showLauncherHelp for --lhc-help", () => {
    expect(parseLauncherArgv(["--lhc-help"]).showLauncherHelp).toBe(true);
  });

  it("rejects PI session attach flags on the launcher path", () => {
    expect(piSessionFlagsConflict(["--session", "abc"])).toBe("--session");
    expect(piSessionFlagsConflict(["--resume"])).toBe("--resume");
    expect(piSessionFlagsConflict(["--model", "x"])).toBeNull();
  });

  it("documents launcher flags", () => {
    expect(launcherHelpText()).toContain("--lhc-thread");
    expect(launcherHelpText()).toContain(LHC_FLAG_CONTINUE);
    expect(launcherHelpText()).toContain("--print");
    expect(launcherHelpText()).toContain("--mode json");
    expect(launcherHelpText()).not.toContain("proof-context");
    expect(launcherHelpText()).not.toMatch(/--print, -p, --mode/);
  });
});
