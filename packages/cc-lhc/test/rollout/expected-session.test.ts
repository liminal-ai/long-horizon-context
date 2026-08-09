import { describe, expect, it } from "vitest";

import { attributeLineSession } from "../../src/rollout/expected-session.js";

const CURRENT = "03c76ca8-427f-4a12-82c2-74496ed92c02";
const ORIGIN = "6ea2a00a-fbf9-40c6-96c8-8e8d737593c4";

describe("attributeLineSession (dual-field corpus semantics)", () => {
  it("uses sessionId as current when both fields present and matching expected", () => {
    const attr = attributeLineSession(CURRENT, CURRENT, ORIGIN);
    expect(attr.conflict).toBe(false);
    expect(attr.currentSessionId).toBe(CURRENT);
    expect(attr.originSessionId).toBe(ORIGIN);
  });

  it("does not treat differing session_id alone as a conflict", () => {
    const attr = attributeLineSession(CURRENT, CURRENT, ORIGIN);
    expect(attr.conflict).toBe(false);
    expect(attr.observed).toBeUndefined();
  });

  it("conflicts when sessionId disagrees with expected filename session", () => {
    const attr = attributeLineSession(ORIGIN, CURRENT, ORIGIN);
    expect(attr.conflict).toBe(true);
    expect(attr.observed).toBe(CURRENT);
    expect(attr.currentSessionId).toBe(CURRENT);
  });

  it("uses session_id as current only when sessionId is absent", () => {
    const attr = attributeLineSession(ORIGIN, undefined, ORIGIN);
    expect(attr.conflict).toBe(false);
    expect(attr.currentSessionId).toBe(ORIGIN);
    expect(attr.originSessionId).toBeUndefined();
  });

  it("conflicts when sole session_id disagrees with expected", () => {
    const attr = attributeLineSession(CURRENT, undefined, ORIGIN);
    expect(attr.conflict).toBe(true);
    expect(attr.observed).toBe(ORIGIN);
  });

  it("is ok when both fields equal the expected id", () => {
    const attr = attributeLineSession(CURRENT, CURRENT, CURRENT);
    expect(attr.conflict).toBe(false);
    expect(attr.originSessionId).toBeUndefined();
  });
});
