import { describe, expect, it } from "vitest";

import {
  identitiesEqual,
  parseProcStatStarttime,
  parseStoredProcessIdentity,
  readProcessIdentityLinux,
} from "../../src/runtime/process-identity.js";

describe("parseProcStatStarttime", () => {
  it("parses plain comm", () => {
    // synthetic: pid (comm) state ... starttime at field 22
    const fields = [
      "R",
      "1",
      "1",
      "1",
      "0",
      "-1",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "20",
      "0",
      "1",
      "0",
      "12345",
    ];
    const stat = `42 (bash) ${fields.join(" ")}`;
    expect(parseProcStatStarttime(stat)).toBe("12345");
  });

  it("parses comm with spaces and closing paren", () => {
    const after = Array.from({ length: 20 }, (_, i) => (i === 19 ? "999888" : "0"));
    const stat = `7 (my cool) app) ${after.join(" ")}`;
    expect(parseProcStatStarttime(stat)).toBe("999888");
  });

  it("rejects short/malformed", () => {
    expect(parseProcStatStarttime("1 (x) R")).toBeNull();
    expect(parseProcStatStarttime("no-parens")).toBeNull();
  });
});

// The /proc reference reader is Linux-only by definition; on other platforms
// it must return null (fail closed), which is asserted separately below.
describe.skipIf(process.platform !== "linux")("readProcessIdentityLinux (Linux reference)", () => {
  it("reads self identity", () => {
    const id = readProcessIdentityLinux(process.pid);
    expect(id).not.toBeNull();
    expect(id!.pid).toBe(process.pid);
    expect(id!.bootId.length).toBeGreaterThan(8);
    expect(/^\d+$/.test(id!.starttime)).toBe(true);
  });

  it("null for impossible pid", () => {
    expect(readProcessIdentityLinux(-1)).toBeNull();
    expect(readProcessIdentityLinux(2_147_000_000)).toBeNull();
  });
});

describe.skipIf(process.platform === "linux")("readProcessIdentityLinux (non-Linux)", () => {
  it("returns null off Linux instead of guessing", () => {
    expect(readProcessIdentityLinux(process.pid)).toBeNull();
  });
});

describe("identity value semantics (platform neutral)", () => {
  it("identitiesEqual requires exact match", () => {
    const a = { pid: 1, bootId: "boot", starttime: "10" };
    expect(identitiesEqual(a, { ...a })).toBe(true);
    expect(identitiesEqual(a, { ...a, starttime: "11" })).toBe(false);
    expect(identitiesEqual(a, { ...a, bootId: "other" })).toBe(false);
  });

  it("parseStoredProcessIdentity validates shape", () => {
    expect(parseStoredProcessIdentity({ pid: 1, bootId: "b", starttime: "2" })).toEqual({
      pid: 1,
      bootId: "b",
      starttime: "2",
    });
    expect(parseStoredProcessIdentity({ pid: 1, bootId: "b", starttime: "x" })).toBeNull();
    expect(parseStoredProcessIdentity(null)).toBeNull();
  });
});
