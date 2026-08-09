import { describe, expect, it } from "vitest";

import { isSessionUuid, isUnsupportedSessionChangingFlag } from "../../src/intake/argv.js";
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
});
