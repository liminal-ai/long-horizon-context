/**
 * Host projection: initial zero-served slices → actionable budget unserved.
 */

import { describe, expect, it } from "vitest";

import {
  assembleEnvelope,
  isInitialZeroServedBudgetRefusal,
  projectServedForEnvelope,
  sliceFooter,
  turnSection,
  unservedLine,
} from "../../src/retrieval/format.js";

describe("initial zero-served budget refusal projection", () => {
  it("detects from=0,to=0,total>0 only", () => {
    expect(isInitialZeroServedBudgetRefusal({ fromToken: 0, toToken: 0, totalTokens: 65 })).toBe(
      true,
    );
    expect(isInitialZeroServedBudgetRefusal({ fromToken: 0, toToken: 0, totalTokens: 0 })).toBe(
      false,
    );
    expect(isInitialZeroServedBudgetRefusal({ fromToken: 100, toToken: 100, totalTokens: 200 })).toBe(
      false,
    );
    expect(isInitialZeroServedBudgetRefusal({ fromToken: 0, toToken: 50, totalTokens: 200 })).toBe(
      false,
    );
    expect(isInitialZeroServedBudgetRefusal(undefined)).toBe(false);
  });

  it("projects zero-served second entity to Pull it separately line", () => {
    const projected = projectServedForEnvelope(
      "get-turns",
      [
        {
          id: "t1",
          text: "BODY",
          slice: { fromToken: 0, toToken: 100, totalTokens: 500 },
        },
        {
          id: "t2",
          text: "",
          slice: { fromToken: 0, toToken: 0, totalTokens: 65 },
        },
      ],
      [{ id: "t999", reason: "not_found" }],
      (e) => turnSection(e.text),
    );

    expect(projected.sections).toEqual([turnSection("BODY")]);
    expect(projected.footers).toHaveLength(1);
    expect(projected.footers[0]).toMatch(/Next slice:/);
    expect(projected.footers[0]).not.toMatch(/nothing at token offset 0/);

    expect(projected.unserved).toEqual([
      { id: "t999", reason: "not_found" },
      { id: "t2", reason: "budget", tokens: 65 },
    ]);

    const line = unservedLine("get-turns", { id: "t2", reason: "budget", tokens: 65 });
    expect(line).toBe(
      "not served: t2 (65 tok — call budget spent). Pull it separately: cc-lhc get-turns t2",
    );

    const envelope = assembleEnvelope(
      "get-turns",
      projected.sections,
      projected.footers,
      projected.unserved,
    );
    expect(envelope).toContain(line);
    expect(envelope).not.toContain("nothing at token offset 0");
  });

  it("does not mislabel nonzero exhausted offset", () => {
    const slice = { fromToken: 4750, toToken: 4750, totalTokens: 6016 };
    expect(isInitialZeroServedBudgetRefusal(slice)).toBe(false);
    const projected = projectServedForEnvelope(
      "get-turns",
      [{ id: "t1", text: "", slice }],
      [],
      (e) => turnSection(e.text),
    );
    expect(projected.unserved).toEqual([]);
    expect(projected.footers[0]).toBe(sliceFooter("get-turns", "t1", slice));
    expect(projected.footers[0]).toMatch(/nothing at token offset 4750/);
  });

  it("does not mislabel totalTokens=0 empty content", () => {
    const slice = { fromToken: 0, toToken: 0, totalTokens: 0 };
    expect(isInitialZeroServedBudgetRefusal(slice)).toBe(false);
    const projected = projectServedForEnvelope(
      "get-messages",
      [{ id: "m1", text: "", slice }],
      [],
      (e) => `<${e.id}>\n${e.text}\n</${e.id}>`,
    );
    expect(projected.unserved).toEqual([]);
    expect(projected.footers[0]).toMatch(/nothing at token offset 0 — total size 0 tok/);
  });
});
