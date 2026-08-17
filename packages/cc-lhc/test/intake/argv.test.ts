import { describe, expect, it } from "vitest";

import {
  classifyExplicitAutocompact,
  isSessionUuid,
  isUnsupportedSessionChangingFlag,
  parseAutocompactTokens,
} from "../../src/intake/argv.js";
import {
  hasContinueFlag,
  isBareResume,
  normalizeLaunchArgv,
  parseResumeSessionId,
  parseSessionIdFlag,
} from "../../src/intake/launch-session.js";

describe("parseResumeSessionId (post-normalization helper)", () => {
  it("parses --resume <uuid>", () => {
    expect(parseResumeSessionId(["claude", "--resume", "abc-123"])).toBeUndefined();
    expect(parseResumeSessionId(["--resume", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"])).toBe(
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    );
  });

  it("parses --resume=<uuid>", () => {
    expect(parseResumeSessionId(["--resume=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"])).toBe(
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    );
  });

  it("returns undefined when absent", () => {
    expect(parseResumeSessionId(["claude"])).toBeUndefined();
  });
});

describe("hasContinueFlag", () => {
  it("treats -c as boolean continue even with a following positional prompt", () => {
    expect(hasContinueFlag(["-c", "please help"])).toBe(true);
    expect(hasContinueFlag(["--continue"])).toBe(true);
  });
});

describe("isBareResume", () => {
  it("detects bare --resume", () => {
    expect(isBareResume(["--resume"])).toBe(true);
    expect(isBareResume(["--resume", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"])).toBe(false);
  });
});

describe("parseSessionIdFlag", () => {
  it("parses --session-id UUID", () => {
    expect(parseSessionIdFlag(["--session-id", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"])).toBe(
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    );
  });
});

describe("normalizeLaunchArgv", () => {
  it("respects -- passthrough boundary", () => {
    const n = normalizeLaunchArgv(["--model", "sonnet", "--", "--resume", "not-a-selector"]);
    expect(n.selectors).toEqual([]);
    expect(n.passthrough).toEqual(["--", "--resume", "not-a-selector"]);
  });

  it("records continue even with positional after -c", () => {
    const n = normalizeLaunchArgv(["-c", "hello world"]);
    expect(n.selectors).toEqual([{ kind: "continue" }]);
    expect(n.rest).toEqual(["hello world"]);
  });
});

describe("isSessionUuid / unsupported flags", () => {
  it("validates session UUIDs", () => {
    expect(isSessionUuid("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).toBe(true);
    expect(isSessionUuid("not-a-uuid")).toBe(false);
  });

  it("detects unsupported session/cwd flags", () => {
    expect(isUnsupportedSessionChangingFlag("--teleport")).toBe("--teleport");
    expect(isUnsupportedSessionChangingFlag("--worktree")).toBe("--worktree");
    expect(isUnsupportedSessionChangingFlag("--model")).toBeUndefined();
  });

  it("detects the 2.1.233 attribution/topology-breaking flags", () => {
    expect(isUnsupportedSessionChangingFlag("--background")).toBe("--background");
    expect(isUnsupportedSessionChangingFlag("--bg")).toBe("--bg");
    expect(isUnsupportedSessionChangingFlag("--environment")).toBe("--environment");
    expect(isUnsupportedSessionChangingFlag("--no-session-persistence")).toBe("--no-session-persistence");
    expect(isUnsupportedSessionChangingFlag("--environment=ccpool_x")).toBe("--environment");
  });
});

describe("parseAutocompactTokens (LIM-80 Slice 4)", () => {
  it("parses integers and k/m suffixes, case-insensitive", () => {
    expect(parseAutocompactTokens("500000")).toBe(500_000);
    expect(parseAutocompactTokens("500k")).toBe(500_000);
    expect(parseAutocompactTokens("500K")).toBe(500_000);
    expect(parseAutocompactTokens("1m")).toBe(1_000_000);
    expect(parseAutocompactTokens("1M")).toBe(1_000_000);
  });
  it("rejects non-numeric / unsafe forms", () => {
    expect(parseAutocompactTokens("auto")).toBeNull();
    expect(parseAutocompactTokens("5x")).toBeNull();
    expect(parseAutocompactTokens("")).toBeNull();
    expect(parseAutocompactTokens("1.5m")).toBeNull();
    expect(parseAutocompactTokens("99999999999999999999")).toBeNull();
  });
});

describe("classifyExplicitAutocompact (LIM-80 Slice 4, upper=360000)", () => {
  const upper = 360_000;
  const cx = (argv: string[]) => classifyExplicitAutocompact(argv, upper);

  it("absent → absent (default backstop injection applies)", () => {
    expect(cx(["--model", "sonnet"])).toEqual({ kind: "absent" });
  });
  it("auto → refuse", () => {
    expect(cx(["--autocompact", "auto"]).kind).toBe("refuse");
    expect(cx(["--autocompact=auto"]).kind).toBe("refuse");
  });
  it("invalid / unprovable value → refuse", () => {
    expect(cx(["--autocompact", "xyz"]).kind).toBe("refuse");
    expect(cx(["--autocompact="]).kind).toBe("refuse");
  });
  it("missing value (end of argv, or followed by a flag) → refuse", () => {
    expect(cx(["--autocompact"]).kind).toBe("refuse");
    expect(cx(["--autocompact", "--model"]).kind).toBe("refuse");
  });
  it("duplicate → refuse", () => {
    expect(cx(["--autocompact", "500k", "--autocompact", "600k"]).kind).toBe("refuse");
  });
  it("equal to upper → refuse (not strictly above)", () => {
    expect(cx(["--autocompact", "360000"]).kind).toBe("refuse");
    expect(cx(["--autocompact", "360k"]).kind).toBe("refuse");
  });
  it("below upper (but in documented range) → refuse", () => {
    expect(cx(["--autocompact", "200k"]).kind).toBe("refuse");
  });
  it("out of documented 100k–1M range → refuse", () => {
    expect(cx(["--autocompact", "50k"]).kind).toBe("refuse");
    expect(cx(["--autocompact", "2m"]).kind).toBe("refuse");
  });
  it("strictly above upper and in range → accept, space and equals forms, k/m suffix", () => {
    expect(cx(["--autocompact", "500000"])).toEqual({ kind: "accept", tokens: 500_000 });
    expect(cx(["--autocompact=500k"])).toEqual({ kind: "accept", tokens: 500_000 });
    expect(cx(["--autocompact", "1m"])).toEqual({ kind: "accept", tokens: 1_000_000 });
  });
  it("--autocompact after the -- passthrough boundary is ignored (a positional prompt, not a flag)", () => {
    expect(cx(["--model", "sonnet", "--", "--autocompact", "50k"])).toEqual({ kind: "absent" });
  });
});
