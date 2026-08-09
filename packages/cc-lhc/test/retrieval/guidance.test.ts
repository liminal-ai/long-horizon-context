import { describe, expect, it } from "vitest";

import {
  injectRetrievalGuidance,
  RETRIEVAL_SYSTEM_GUIDANCE,
  splitAtDoubleDash,
} from "../../src/retrieval/guidance.js";

describe("injectRetrievalGuidance argv grammar", () => {
  it("static guidance forbids pipe/head truncation of bounded retrieval", () => {
    expect(RETRIEVAL_SYSTEM_GUIDANCE).toMatch(/Do not pipe, redirect, head, tail, or otherwise truncate/);
    expect(RETRIEVAL_SYSTEM_GUIDANCE).toMatch(/already bounded/);
    expect(RETRIEVAL_SYSTEM_GUIDANCE).toMatch(/call budget spent/);
  });

  it("inserts before bare -- and leaves post-- intact", () => {
    const r = injectRetrievalGuidance(["--model", "sonnet", "--", "literal --append-system-prompt x"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { before, after } = splitAtDoubleDash(r.argv);
    expect(before).toContain("--append-system-prompt");
    expect(after).toEqual(["literal --append-system-prompt x"]);
    expect(r.argv.indexOf("--")).toBeLessThan(r.argv.length - 1);
    // Guidance body includes no-pipe sentence
    const gIdx = before.indexOf("--append-system-prompt");
    expect(before[gIdx + 1]).toContain("Do not pipe, redirect, head, tail");
  });

  it("does not rewrite post-- lookalike tokens", () => {
    const r = injectRetrievalGuidance(["--", "--append-system-prompt", "PROMPT_DATA"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.argv.slice(r.argv.indexOf("--") + 1)).toEqual([
      "--append-system-prompt",
      "PROMPT_DATA",
    ]);
    // Guidance appears only before --
    expect(r.argv[0]).toBe("--append-system-prompt");
  });

  it("merges equals form", () => {
    const r = injectRetrievalGuidance(["--append-system-prompt=hello", "-p", "hi"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const eq = r.argv.find((a) => a.startsWith("--append-system-prompt="));
    expect(eq).toMatch(/^--append-system-prompt=hello\n\n/);
  });

  it("merges space form", () => {
    const r = injectRetrievalGuidance(["--append-system-prompt", "base", "-p", "x"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const idx = r.argv.indexOf("--append-system-prompt");
    expect(r.argv[idx + 1]).toMatch(/^base\n\n/);
  });

  it("refuses duplicate flags", () => {
    const r = injectRetrievalGuidance([
      "--append-system-prompt",
      "a",
      "--append-system-prompt",
      "b",
    ]);
    expect(r.ok).toBe(false);
  });

  it("refuses missing value", () => {
    expect(injectRetrievalGuidance(["--append-system-prompt"]).ok).toBe(false);
  });

  it("refuses value-starting-with-dash", () => {
    expect(injectRetrievalGuidance(["--append-system-prompt", "--model"]).ok).toBe(false);
  });

  it("handles no options argv", () => {
    const r = injectRetrievalGuidance([]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.argv[0]).toBe("--append-system-prompt");
  });
});
