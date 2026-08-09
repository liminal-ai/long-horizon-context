import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  EMPTY_PREFIX_SHA256,
  parseStoredVerifiedPrefix,
} from "../../src/intake/prefix-boundary.js";

describe("parseStoredVerifiedPrefix (no normalization)", () => {
  it("accepts exact non-negative integers and 64-hex digest", () => {
    const sha = createHash("sha256").update("x").digest("hex");
    expect(parseStoredVerifiedPrefix(1, 10, sha)).toEqual({
      kind: "verified",
      lineCount: 1,
      byteLength: 10,
      sha256: sha,
    });
  });

  it("accepts consistent empty fence", () => {
    expect(parseStoredVerifiedPrefix(0, 0, EMPTY_PREFIX_SHA256)).toEqual({
      kind: "verified",
      lineCount: 0,
      byteLength: 0,
      sha256: EMPTY_PREFIX_SHA256,
    });
  });

  it("rejects negative line/byte counts (no clamp to zero)", () => {
    expect(parseStoredVerifiedPrefix(-7, 0, EMPTY_PREFIX_SHA256)).toBeNull();
    expect(parseStoredVerifiedPrefix(0, -9, EMPTY_PREFIX_SHA256)).toBeNull();
    expect(parseStoredVerifiedPrefix(-7, -9, EMPTY_PREFIX_SHA256)).toBeNull();
  });

  it("rejects fractional and non-integer values", () => {
    expect(parseStoredVerifiedPrefix(1.5, 10, "ab".repeat(32))).toBeNull();
    expect(parseStoredVerifiedPrefix(1, 10.2, "ab".repeat(32))).toBeNull();
    expect(parseStoredVerifiedPrefix(NaN, 10, "ab".repeat(32))).toBeNull();
    expect(parseStoredVerifiedPrefix(Infinity, 10, "ab".repeat(32))).toBeNull();
  });

  it("rejects unsafe overflow integers", () => {
    expect(parseStoredVerifiedPrefix(Number.MAX_SAFE_INTEGER + 1, 1, "ab".repeat(32))).toBeNull();
  });

  it("rejects malformed digests", () => {
    expect(parseStoredVerifiedPrefix(1, 10, "")).toBeNull();
    expect(parseStoredVerifiedPrefix(1, 10, "not-hex")).toBeNull();
    expect(parseStoredVerifiedPrefix(1, 10, "ab".repeat(31))).toBeNull();
    expect(parseStoredVerifiedPrefix(1, 10, "zz".repeat(32))).toBeNull();
  });

  it("rejects inconsistent zero fences", () => {
    // lines=0 but nonzero bytes
    expect(parseStoredVerifiedPrefix(0, 9, EMPTY_PREFIX_SHA256)).toBeNull();
    // lines=0 but wrong digest
    expect(parseStoredVerifiedPrefix(0, 0, "ab".repeat(32))).toBeNull();
    // lines>0 but zero bytes
    expect(parseStoredVerifiedPrefix(3, 0, EMPTY_PREFIX_SHA256)).toBeNull();
    // forged empty digest with negative (already rejected) — also lines=0 bytes>0
    expect(parseStoredVerifiedPrefix(0, 1, EMPTY_PREFIX_SHA256)).toBeNull();
  });
});
