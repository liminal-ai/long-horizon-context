import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  computeVerifiedPrefixBoundary,
  verifyPrefixBoundaryOnDisk,
} from "../../src/intake/prefix-boundary.js";

describe("prefix boundary", () => {
  it("computes digest over exact serialized prefix bytes", () => {
    const prefix = '{"type":"user","uuid":"a"}\n{"type":"assistant","uuid":"b"}\n';
    const b = computeVerifiedPrefixBoundary(prefix, 2);
    expect(b.kind).toBe("verified");
    expect(b.lineCount).toBe(2);
    expect(b.byteLength).toBe(Buffer.byteLength(prefix, "utf8"));
    expect(b.sha256).toBe(createHash("sha256").update(prefix, "utf8").digest("hex"));
  });

  it("verifies matching on-disk prefix and rejects short/mismatch", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-pfx-"));
    const path = join(dir, "s.jsonl");
    const prefix = '{"type":"user","uuid":"a","message":{"role":"user","content":"hi"}}\n';
    const receipt = '{"type":"user","uuid":"r","message":{"role":"user","content":"[runtime note] x"}}\n';
    writeFileSync(path, prefix + receipt);
    const boundary = computeVerifiedPrefixBoundary(prefix, 1);
    expect(verifyPrefixBoundaryOnDisk(path, boundary).ok).toBe(true);

    writeFileSync(path, prefix.slice(0, 10));
    expect(verifyPrefixBoundaryOnDisk(path, boundary).ok).toBe(false);

    writeFileSync(path, '{"type":"user","uuid":"Z","message":{"role":"user","content":"nope"}}\n' + receipt);
    expect(verifyPrefixBoundaryOnDisk(path, boundary).ok).toBe(false);
  });
});
