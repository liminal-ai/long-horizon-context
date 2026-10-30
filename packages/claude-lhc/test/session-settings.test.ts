import { describe, expect, test } from "vitest";
import { formatCompactRuntimeNote } from "../src/session.ts";
import { seedTokenFamilyFromStartModel } from "../src/token-family.ts";

describe("compact runtime note", () => {
  test("appends family slug and source to the existing note text", () => {
    const note = formatCompactRuntimeNote({
      trigger: "auto",
      preTokens: 508_000,
      totalTokens: 181_000,
      lowerBound: 180_000,
      compactPoint: 12,
      coveredFrom: 3,
      degradedCount: 1,
      gapsCount: 0,
      bands: { brief: { entries: 2, tokens: 4000 } },
      family: seedTokenFamilyFromStartModel("claude-sonnet-5"),
    });
    expect(note).toBe(
      '[lhc compact:auto] provider context 508000 tokens; rebuilt view 181000 tokens (target 180000); compact point 12, covered from 3; degraded 1, gaps 0; bands {"brief":{"entries":2,"tokens":4000}}; family claude-2026 (model)',
    );
    expect(note).toMatch(/; family claude-2026 \(model\)$/);
  });

  test("provider-fallback seed is printed as the source", () => {
    const note = formatCompactRuntimeNote({
      trigger: "manual",
      preTokens: 10,
      totalTokens: 8,
      lowerBound: 180_000,
      compactPoint: 0,
      coveredFrom: 0,
      degradedCount: 0,
      gapsCount: 0,
      bands: {},
      family: seedTokenFamilyFromStartModel(""),
    });
    expect(note.endsWith("; family claude-2026 (provider-fallback)")).toBe(true);
  });
});
