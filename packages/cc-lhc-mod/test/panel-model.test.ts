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

  it("stays quiet with no compaction news, however full the context", () => {
    expect(statusLine({ ...state, lastCompact: null, context: 790_000 }, 0)).toBeUndefined();
    expect(statusLine(state, 0)).toBeUndefined();
    expect(statusLine(EMPTY_PANEL, 0)).toBeUndefined();
  });

  it("shows an LHC compaction until a turn that began after it ends", () => {
    const compacted = { ...state, lastCompact: { ...state.lastCompact, at: 5_000 } } as PanelState;
    expect(statusLine(compacted, 4_000)).toBe("812k → 138k");
    expect(statusLine(compacted, 6_000)).toBeUndefined();
  });

  it("warns of a fallback to Claude Code's summary until the next LHC compaction", () => {
    const fellBack: PanelState = {
      ...state,
      context: null,
      lastCompact: { at: 5_000, op: "compact", trigger: "auto", by: "native", reason: "sidecar down" },
    };
    expect(statusLine(fellBack, 4_000)).toBe("fell back to Claude Code's summary");
    expect(statusLine({ ...fellBack, context: 100_000 }, 9_000)).toBe("fell back to Claude Code's summary");
    expect(statusLine({ ...fellBack, lastCompact: { ...state.lastCompact, at: 10_000 } } as PanelState, 9_000)).toBe(
      "812k → 138k",
    );
    expect(statusReport(fellBack, 5_000)).toContain("LHC fell back to Claude Code's summary (sidecar down)");
  });

  it("keeps the context and the thread in /lhc status", () => {
    expect(statusReport(state, 120_000).split("\n")).toEqual([
      "Context 412k of 800k (52%), thread th_1 (new).",
      "Compacts at 800k back to 140k (window 1M).",
      "Settings: lower bound 140k, upper bound 800k, 90% of the window.",
      "Last compact 2m ago (auto): compacted 812k to 138k (mid-turn).",
      "Derivations: 41 ready, 2 pending, 0 failed, 0 blocked.",
    ]);
    expect(statusReport(EMPTY_PANEL, 0)).toBe("No session is bound to an LHC thread yet.");
  });

  it("says when a 200k window clamps the trigger to 167k", () => {
    const report = statusReport({ ...state, policy: policyFor(200_000) }, 120_000);
    expect(report).toContain("Compacts at 167k back to 80k (window 200k, clamped: a 200k window allows at most 167k).");
    expect(report).toContain("Last compact 2m ago (auto)");
    expect(report).toContain("Derivations: 41 ready, 2 pending, 0 failed, 0 blocked.");
  });
});
