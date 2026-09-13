import { describe, expect, test } from "vitest";
import { ClaudeLhcSession, formatCompactRuntimeNote, takeHostCompactSettings } from "../src/session.ts";
import { seedTokenFamilyFromStartModel } from "../src/token-family.ts";

const silentIo = {
  emit(): void {},
  request: async () => ({}),
  end(): void {},
  fail(): void {},
  log(): void {},
};

describe("takeHostCompactSettings", () => {
  test("missing autoCompactWindow is rejected with the setting named", () => {
    expect(() => takeHostCompactSettings({})).toThrow(/autoCompactWindow/);
    expect(() => takeHostCompactSettings({ lhcLowerBound: 180_000 })).toThrow(
      "autoCompactWindow is required and must be a finite number",
    );
  });

  test("missing lhcLowerBound is rejected with the setting named", () => {
    expect(() => takeHostCompactSettings({ autoCompactWindow: 500_000 })).toThrow(
      "lhcLowerBound is required and must be a finite number",
    );
  });

  test("non-finite values are rejected with the setting named", () => {
    expect(() => takeHostCompactSettings({ autoCompactWindow: Number.NaN, lhcLowerBound: 180_000 })).toThrow(
      /autoCompactWindow/,
    );
    expect(() =>
      takeHostCompactSettings({ autoCompactWindow: 500_000, lhcLowerBound: Number.POSITIVE_INFINITY }),
    ).toThrow(/lhcLowerBound/);
  });

  test("bound >= trigger is rejected naming lhcLowerBound", () => {
    expect(() => takeHostCompactSettings({ autoCompactWindow: 150_000, lhcLowerBound: 150_000 })).toThrow(
      "lhcLowerBound must be less than autoCompactWindow",
    );
    expect(() => takeHostCompactSettings({ autoCompactWindow: 150_000, lhcLowerBound: 180_000 })).toThrow(
      /lhcLowerBound/,
    );
  });

  test("child settings no longer contain lhcLowerBound or autoCompactWindow", () => {
    const input = { autoCompactWindow: 500_000, lhcLowerBound: 180_000, other: true };
    const taken = takeHostCompactSettings(input);
    expect(taken.autoCompactTrigger).toBe(500_000);
    expect(taken.lhcLowerBound).toBe(180_000);
    expect(taken.childSettings).toEqual({ other: true });
    expect(taken.childSettings).not.toHaveProperty("lhcLowerBound");
    expect(taken.childSettings).not.toHaveProperty("autoCompactWindow");
    expect(input).toEqual({ autoCompactWindow: 500_000, lhcLowerBound: 180_000, other: true });
  });
});

describe("start() rejects invalid compact settings", () => {
  test("names autoCompactWindow when it is missing", async () => {
    const session = new ClaudeLhcSession(silentIo);
    await expect(session.start({ settings: { lhcLowerBound: 180_000 } })).rejects.toThrow(/autoCompactWindow/);
  });

  test("names lhcLowerBound when it is missing", async () => {
    const session = new ClaudeLhcSession(silentIo);
    await expect(session.start({ settings: { autoCompactWindow: 500_000 } })).rejects.toThrow(/lhcLowerBound/);
  });

  test("rejects bound >= trigger", async () => {
    const session = new ClaudeLhcSession(silentIo);
    await expect(session.start({ settings: { autoCompactWindow: 150_000, lhcLowerBound: 180_000 } })).rejects.toThrow(
      "lhcLowerBound must be less than autoCompactWindow",
    );
  });
});

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
