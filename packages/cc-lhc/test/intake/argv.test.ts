import { describe, expect, it } from "vitest";

import { hasContinueFlag, parseResumeSessionId } from "../../src/intake/argv.js";

describe("parseResumeSessionId", () => {
  it("returns the session id after --resume", () => {
    expect(parseResumeSessionId(["claude", "--resume", "abc-123"])).toBe("abc-123");
  });

  it("returns the session id from --resume=<id>", () => {
    expect(parseResumeSessionId(["claude", "--resume=abc-123"])).toBe("abc-123");
  });

  it("returns undefined when --resume is absent", () => {
    expect(parseResumeSessionId(["claude"])).toBeUndefined();
  });

  it("treats bare --resume followed by another flag as picker mode", () => {
    expect(parseResumeSessionId(["claude", "--resume", "--continue"])).toBeUndefined();
  });
});

describe("hasContinueFlag", () => {
  it("detects --continue", () => {
    expect(hasContinueFlag(["claude", "--continue"])).toBe(true);
    expect(hasContinueFlag(["claude"])).toBe(false);
  });
});
