/**
 * Slice 2: strict parser + overhead arithmetic (ASCII/multibyte ceilings).
 */

import { describe, expect, it } from "vitest";

import {
  CERTIFIED_STDOUT_CEILING_BYTES,
  envStdoutCeiling,
  framingOverheadBytes,
  planByteBudget,
} from "../../src/retrieval/budget.js";
import { assembleEnvelope, recallClose, recallOpen } from "../../src/retrieval/format.js";
import { parseRetrievalArgv } from "../../src/retrieval/parse.js";

describe("parseRetrievalArgv", () => {
  it("parses a single-id get-turns continuation with --from (TC-3.3a)", () => {
    const r = parseRetrievalArgv(["get-turns", "--from", "8000", "t211"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.request.op).toBe("get-turns");
    expect(r.request.ids).toEqual(["t211"]);
    expect(r.request.fromToken).toBe(8000);
  });

  it("parses get-messages and --from= (TC-3.3b)", () => {
    const r = parseRetrievalArgv(["get-messages", "--from=0", "m1"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.request.uniqueIds).toEqual(["m1"]);
  });

  it("rejects --from with more than one unique id before any retrieval call (TC-3.3c)", () => {
    for (const argv of [
      ["get-turns", "--from", "8000", "t211", "t212"],
      ["get-messages", "--from=10", "m1", "m2", "m1"],
    ]) {
      const r = parseRetrievalArgv(argv);
      expect(r.ok, argv.join(" ")).toBe(false);
      if (!r.ok) expect(r.reason).toContain("single-id continuation");
    }
  });

  it("normalizes a repeated identical id with --from to one continuation target (TC-3.3d)", () => {
    const r = parseRetrievalArgv(["get-turns", "--from", "500", "t7", "t7"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.request.uniqueIds).toEqual(["t7"]);
    expect(r.request.fromToken).toBe(500);
  });

  it("rejects a repeated --from flag as malformed", () => {
    expect(parseRetrievalArgv(["get-turns", "--from", "1", "--from", "2", "t1"]).ok).toBe(false);
    expect(parseRetrievalArgv(["get-turns", "--from=1", "--from=2", "t1"]).ok).toBe(false);
  });

  it("rejects unknown op, flags, empty ids, wrong kind, bad from", () => {
    expect(parseRetrievalArgv([]).ok).toBe(false);
    expect(parseRetrievalArgv(["get-turnz", "t1"]).ok).toBe(false);
    expect(parseRetrievalArgv(["get-turns", "--nope", "t1"]).ok).toBe(false);
    expect(parseRetrievalArgv(["get-turns"]).ok).toBe(false);
    expect(parseRetrievalArgv(["get-turns", "m1"]).ok).toBe(false);
    expect(parseRetrievalArgv(["get-messages", "t1"]).ok).toBe(false);
    expect(parseRetrievalArgv(["get-turns", "--from", "-1", "t1"]).ok).toBe(false);
    expect(parseRetrievalArgv(["get-turns", "--from", "1.5", "t1"]).ok).toBe(false);
    expect(parseRetrievalArgv(["get-turns", "--from", "08", "t1"]).ok).toBe(false);
  });

  it("dedupes for unique count; refuses >32 unique", () => {
    const dups = parseRetrievalArgv(["get-turns", "t1", "t1", "t2"]);
    expect(dups.ok).toBe(true);
    if (dups.ok) {
      expect(dups.request.ids).toHaveLength(3);
      expect(dups.request.uniqueIds).toEqual(["t1", "t2"]);
    }
    const many = Array.from({ length: 33 }, (_, i) => `t${i + 1}`);
    const over = parseRetrievalArgv(["get-turns", ...many]);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toMatch(/too many ids/);
  });

  it("allows exactly 32 unique ids", () => {
    const ids = Array.from({ length: 32 }, (_, i) => `t${i + 1}`);
    const r = parseRetrievalArgv(["get-turns", ...ids]);
    expect(r.ok).toBe(true);
  });
});

describe("planByteBudget", () => {
  it("reserves framing+receipts under certified ceiling", () => {
    const plan = planByteBudget("get-turns", 1);
    expect(plan.stdoutCeiling).toBe(CERTIFIED_STDOUT_CEILING_BYTES);
    expect(plan.sdkByteBudget).not.toBeNull();
    expect(plan.sdkByteBudget!).toBeLessThan(plan.stdoutCeiling);
    expect(plan.reservedOverhead + plan.sdkByteBudget!).toBe(plan.stdoutCeiling);
  });

  it("env ceiling clamps downward only", () => {
    const down = planByteBudget("get-messages", 2, 10_000);
    expect(down.stdoutCeiling).toBe(10_000);
    const ignoreUp = planByteBudget("get-messages", 2, 100_000);
    expect(ignoreUp.stdoutCeiling).toBe(CERTIFIED_STDOUT_CEILING_BYTES);
  });

  it("framing bytes match format.ts open+close", () => {
    const op = "get-turns" as const;
    const measured =
      Buffer.byteLength(recallOpen(op), "utf8") + Buffer.byteLength(recallClose(op), "utf8");
    expect(framingOverheadBytes(op)).toBe(measured);
  });

  it("envStdoutCeiling parses positive ints only", () => {
    expect(envStdoutCeiling({ BASH_MAX_OUTPUT_LENGTH: "12000" })).toBe(12_000);
    expect(envStdoutCeiling({ BASH_MAX_OUTPUT_LENGTH: "0" })).toBeUndefined();
    expect(envStdoutCeiling({ BASH_MAX_OUTPUT_LENGTH: "abc" })).toBeUndefined();
    expect(envStdoutCeiling({})).toBeUndefined();
    // Undocumented alias must not enlarge/select ceiling
    expect(envStdoutCeiling({ CC_LHC_BASH_MAX_OUTPUT_LENGTH: "12000" } as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("multibyte content counted in final envelope bytes", () => {
    const body = "日本語🦀".repeat(10);
    const env = assembleEnvelope("get-messages", [`<m1>\n${body}\n</m1>`], [], []);
    expect(Buffer.byteLength(env, "utf8")).toBeGreaterThan(env.length);
  });
});
