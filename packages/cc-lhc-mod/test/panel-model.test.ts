import { describe, expect, it } from "vitest";
import {
  EMPTY_PANEL,
  type PanelState,
  parseLhcArgs,
  parseSetting,
  parseTokens,
  statusLine,
  statusReport,
} from "../src/panel.ts";
import { computePolicy, resolveSettings } from "../src/settings.ts";

const policyFor = (window: number, options: Record<string, unknown> = {}) =>
  computePolicy(resolveSettings(options), window).policy;

describe("settings typed in the panel or after /lhc bounds", () => {
  it("reads tokens with k and m suffixes and separators", () => {
    expect(["600000", "600k", "600,000", "0.6m", "1.2M"].map(parseTokens)).toEqual([
      600_000, 600_000, 600_000, 600_000, 1_200_000,
    ]);
    expect(["", "abc", "-5", "0", "6e5"].map(parseTokens)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("takes a percent from 1 to 100, with or without the sign", () => {
    expect(parseSetting("compactPercent", "85%")).toEqual({ field: "compactPercent", value: 85 });
    expect(parseSetting("compactPercent", "0")).toHaveProperty("error");
    expect(parseSetting("compactPercent", "101")).toHaveProperty("error");
    expect(parseSetting("compactPercent", "0x5A")).toHaveProperty("error");
    expect(parseSetting("compactPercent", "1e2")).toHaveProperty("error");
    expect(parseSetting("lowerBound", "140")).toEqual({
      error: "The lower bound is at least 10k tokens, not 140. For thousands, add k: 140k",
    });
    expect(parseLhcArgs("bounds 1 1 1")).toMatchObject({ kind: "invalid" });
    expect(parseSetting("upperBound", "lots")).toEqual({
      error: 'The upper bound is a whole number of tokens such as 600000 or 600k, not "lots"',
    });
  });

  it("parses each /lhc subcommand and refuses anything else with the usage", () => {
    expect(parseLhcArgs("")).toEqual({ kind: "open" });
    expect(parseLhcArgs(" prune ")).toEqual({ kind: "prune" });
    expect(parseLhcArgs("bounds 150k 700k 85")).toEqual({
      kind: "bounds",
      edits: [
        { field: "lowerBound", value: 150_000 },
        { field: "upperBound", value: 700_000 },
        { field: "compactPercent", value: 85 },
      ],
    });
    expect(parseLhcArgs("bounds 150k")).toMatchObject({ kind: "invalid" });
    expect(parseLhcArgs("status now")).toMatchObject({ kind: "invalid" });
  });
});

describe("what the status line and /lhc status say", () => {
  const state: PanelState = {
    ...EMPTY_PANEL,
    thread: { id: "th_1", how: "new" },
    settings: resolveSettings({}).settings,
    policy: policyFor(1_000_000),
    context: 412_000,
    lastCompact: { at: 0, op: "compact", trigger: "auto", before: 812_000, by: "lhc", after: 138_000, isMidTurn: true },
    derivations: { ready: 41, pending: 2, failed: 0, blocked: 0 },
  };

  it("leads with pressure against the trigger, then the thread and the last compaction", () => {
    expect(statusLine(state)).toBe(
      "context 412k of 800k (52%) · thread th_1 (new) · compacted 812k to 138k (mid-turn)",
    );
    expect(statusLine({ ...EMPTY_PANEL, thread: { id: "th_1", how: "new" } })).toBe("thread th_1 (new)");
    expect(statusLine(EMPTY_PANEL)).toBeUndefined();
  });

  it("names a fallback to Claude Code's summary", () => {
    const fellBack: PanelState = {
      ...state,
      lastCompact: { at: 0, op: "compact", trigger: "auto", by: "native", reason: "sidecar down" },
    };
    expect(statusLine(fellBack)).toContain("last compaction fell back to Claude Code's summary");
    expect(statusReport(fellBack, 0)).toContain("LHC fell back to Claude Code's summary (sidecar down)");
  });

  it("says when a 200k window clamps the trigger to 167k", () => {
    const report = statusReport({ ...state, policy: policyFor(200_000) }, 120_000);
    expect(report).toContain("Compacts at 167k back to 80k (window 200k, clamped: a 200k window allows at most 167k).");
    expect(report).toContain("Last compact 2m ago (auto)");
    expect(report).toContain("Derivations: 41 ready, 2 pending, 0 failed, 0 blocked.");
  });
});
