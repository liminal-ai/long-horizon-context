import { describe, expect, it } from "vitest";

import {
  hasResumeLastIntent,
  parseCodexResumeIntent,
  resumeSessionIdFromIntent,
} from "../../src/intake/argv.js";

const SESSION_A = "550e8400-e29b-41d4-a716-446655440001";
const SESSION_B = "550e8400-e29b-41d4-a716-446655440002";

describe("parseCodexResumeIntent", () => {
  it("returns resume-id for resume <uuid>", () => {
    expect(parseCodexResumeIntent(["resume", SESSION_A])).toEqual({
      kind: "resume-id",
      sessionId: SESSION_A,
    });
  });

  it("returns resume-last for resume --last", () => {
    expect(parseCodexResumeIntent(["resume", "--last"])).toEqual({ kind: "resume-last" });
  });

  it("returns resume-id for exec resume <uuid>", () => {
    expect(parseCodexResumeIntent(["exec", "resume", SESSION_B])).toEqual({
      kind: "resume-id",
      sessionId: SESSION_B,
    });
  });

  it("returns resume-last for exec resume --last", () => {
    expect(parseCodexResumeIntent(["exec", "resume", "--last"])).toEqual({ kind: "resume-last" });
  });

  it("tolerates interspersed flags before resume", () => {
    expect(parseCodexResumeIntent(["--model", "gpt-5.5", "resume", SESSION_A])).toEqual({
      kind: "resume-id",
      sessionId: SESSION_A,
    });
  });

  it("tolerates interspersed flags between resume and the session id", () => {
    expect(parseCodexResumeIntent(["resume", "-c", "sandbox_mode=read-only", SESSION_A])).toEqual({
      kind: "resume-id",
      sessionId: SESSION_A,
    });
  });

  it("tolerates flags between exec and resume", () => {
    expect(parseCodexResumeIntent(["exec", "--model", "gpt-5.5", "resume", SESSION_B])).toEqual({
      kind: "resume-id",
      sessionId: SESSION_B,
    });
  });

  it("returns none for a plain run", () => {
    expect(parseCodexResumeIntent(["run", "fix the tests"])).toEqual({ kind: "none" });
  });

  it("returns none for garbage argv", () => {
    expect(parseCodexResumeIntent(["resume", "not-a-uuid"])).toEqual({ kind: "none" });
    expect(parseCodexResumeIntent(["resume", "--continue"])).toEqual({ kind: "none" });
    expect(parseCodexResumeIntent(["resume"])).toEqual({ kind: "none" });
  });

  it("exposes helpers for session wiring", () => {
    const intent = parseCodexResumeIntent(["resume", SESSION_A]);
    expect(resumeSessionIdFromIntent(intent)).toBe(SESSION_A);
    expect(hasResumeLastIntent(intent)).toBe(false);
    expect(hasResumeLastIntent(parseCodexResumeIntent(["resume", "--last"]))).toBe(true);
    expect(resumeSessionIdFromIntent(parseCodexResumeIntent(["run"]))).toBeUndefined();
  });
});
