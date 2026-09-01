/**
 * Story 0 context-window evidence fixtures (test-only; no product module
 * exists yet). Pins the documented status-line input contract and the
 * accepted D8 decision table as reviewable data. Story 1's real observer
 * tests consume these same fixtures; if Story 1 changes the fixture file,
 * this integrity test forces the change to stay consistent with the
 * accepted design rule.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "context-window",
  "status-line-cases.json",
);

interface StatusLineCase {
  name: string;
  payload: {
    session_id?: string;
    model?: { id?: string; display_name?: string };
    context_window?: { context_window_size?: unknown };
  };
  expectedClass: "200k" | "1M" | "conservative-200k" | "detection-unavailable-200k";
  expectedAdvisory: "panel-report" | "unresolved-window" | null;
  pairedWith?: string;
}

interface SettingsMergeCase {
  name: string;
  userSettings: Record<string, unknown>;
  userArgvSettings: Record<string, unknown> | string | null;
  expectedOutcome: "observe-only" | "merge-chain" | "fallback-conservative-200k";
  expectedSingleSettingsPayload: boolean;
  expectedChainsUserCommand: boolean;
  expectedPreservedCommand?: string;
  expectedPreservedPadding?: number;
}

interface Fixture {
  source: string;
  decisionRule: string;
  statusLineCases: StatusLineCase[];
  settingsMergeCases: SettingsMergeCase[];
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;

/** Accepted D8 rule: only the two documented exact values select a class. */
function expectedClassFor(size: unknown): StatusLineCase["expectedClass"] {
  if (typeof size !== "number" || !Number.isSafeInteger(size)) return "detection-unavailable-200k";
  if (size === 200_000) return "200k";
  if (size === 1_000_000) return "1M";
  return "conservative-200k";
}

describe("story0 context-window evidence fixtures", () => {
  it("carries the documented status-line fields on every observable payload", () => {
    for (const c of fixture.statusLineCases) {
      expect(c.payload.session_id, c.name).toBeTruthy();
      expect(c.payload.model?.id, c.name).toBeTruthy();
    }
  });

  it("covers both documented window values and the same-family discrimination shape", () => {
    const sizes = fixture.statusLineCases.map((c) => c.payload.context_window?.context_window_size);
    expect(sizes).toContain(200_000);
    expect(sizes).toContain(1_000_000);

    const paired = fixture.statusLineCases.filter((c) => c.pairedWith !== undefined);
    expect(paired.length).toBeGreaterThan(0);
    for (const c of paired) {
      const other = fixture.statusLineCases.find((o) => o.name === c.pairedWith);
      expect(other, `${c.name} pairs with a real case`).toBeDefined();
      expect(c.payload.model?.id, `${c.name} shares the family of its pair`).toBe(other?.payload.model?.id);
      expect(c.expectedClass, `${c.name} resolves by window, not family`).not.toBe(other?.expectedClass);
    }
  });

  it("classifies every case by the accepted exact-value rule", () => {
    for (const c of fixture.statusLineCases) {
      expect(c.expectedClass, c.name).toBe(expectedClassFor(c.payload.context_window?.context_window_size));
    }
  });

  it("raises the unresolved-window advisory exactly for observed values below 200k", () => {
    for (const c of fixture.statusLineCases) {
      const size = c.payload.context_window?.context_window_size;
      const belowDocumented = typeof size === "number" && Number.isSafeInteger(size) && size < 200_000;
      if (belowDocumented) {
        expect(c.expectedAdvisory, c.name).toBe("unresolved-window");
      } else {
        expect(c.expectedAdvisory, c.name).not.toBe("unresolved-window");
      }
      if (c.expectedClass === "200k" || c.expectedClass === "1M") {
        expect(c.expectedAdvisory, `${c.name}: documented classes carry no advisory`).toBeNull();
      } else {
        expect(c.expectedAdvisory, `${c.name}: fallback classes are always reported`).not.toBeNull();
      }
    }
  });

  it("covers all four accepted settings-preservation situations exactly once", () => {
    const outcomes = fixture.settingsMergeCases.map((c) => `${c.name}:${c.expectedOutcome}`);
    expect(outcomes).toHaveLength(4);
    const byOutcome = new Map<string, number>();
    for (const c of fixture.settingsMergeCases) {
      byOutcome.set(c.expectedOutcome, (byOutcome.get(c.expectedOutcome) ?? 0) + 1);
    }
    expect(byOutcome.get("observe-only")).toBe(1);
    expect(byOutcome.get("merge-chain")).toBe(2);
    expect(byOutcome.get("fallback-conservative-200k")).toBe(1);
  });

  it("never expects two settings payloads and preserves the user command byte-exact when chaining", () => {
    for (const c of fixture.settingsMergeCases) {
      expect(c.expectedSingleSettingsPayload, c.name).toBe(true);
      if (c.expectedChainsUserCommand) {
        const declared =
          (c.userSettings as { statusLine?: { command?: string; padding?: number } }).statusLine ??
          (typeof c.userArgvSettings === "object" && c.userArgvSettings !== null
            ? (c.userArgvSettings as { statusLine?: { command?: string; padding?: number } }).statusLine
            : undefined);
        expect(declared?.command, c.name).toBe(c.expectedPreservedCommand);
        expect(declared?.padding, c.name).toBe(c.expectedPreservedPadding);
      } else {
        expect(c.expectedPreservedCommand, c.name).toBeUndefined();
      }
    }
  });

  it("keeps the unreadable-payload case fail-closed to the conservative policy", () => {
    const fallback = fixture.settingsMergeCases.find((c) => c.expectedOutcome === "fallback-conservative-200k");
    expect(fallback).toBeDefined();
    expect(typeof fallback?.userArgvSettings).toBe("string");
    expect(fallback?.expectedChainsUserCommand).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Live 2.1.252 evidence: the documented input, captured through the real route
// ---------------------------------------------------------------------------

const LIVE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "context-window",
  "claude-2.1.252-status-line-live.json",
);

interface LivePayload {
  session_id: string;
  version: string;
  model: { id: string; display_name: string };
  context_window: { context_window_size: unknown; total_input_tokens: number };
  exceeds_200k_tokens: boolean;
}

interface LiveRecord {
  probe: string;
  argv: string[];
  sequence: number;
  moment: string;
  payload: LivePayload;
}

interface LiveFixture {
  source: string;
  caveats: string[];
  records: LiveRecord[];
}

const live = JSON.parse(readFileSync(LIVE_PATH, "utf8")) as LiveFixture;

describe("story0 context-window live evidence (Claude Code 2.1.252)", () => {
  it("was captured from the pinned binary through the status-line route", () => {
    expect(live.records.length).toBeGreaterThan(0);
    for (const r of live.records) expect(r.payload.version, r.probe).toBe("2.1.252");
    expect(live.source).toContain("--settings");
  });

  it("carries the documented fields on every real payload", () => {
    for (const r of live.records) {
      const label = `${r.probe}#${r.sequence}`;
      expect(r.payload.session_id, label).toBeTruthy();
      expect(r.payload.model.id, label).toBeTruthy();
      expect(Number.isSafeInteger(r.payload.context_window.context_window_size), label).toBe(true);
    }
  });

  it("observed both documented window values, and only those", () => {
    const sizes = new Set(live.records.map((r) => r.payload.context_window.context_window_size));
    expect(sizes).toEqual(new Set([200_000, 1_000_000]));
    for (const r of live.records) {
      const cls = expectedClassFor(r.payload.context_window.context_window_size);
      expect(cls === "200k" || cls === "1M", `${r.probe}#${r.sequence} maps to a built-in class`).toBe(true);
    }
  });

  it("emits a payload at launch before the first model turn", () => {
    const probes = new Set(live.records.map((r) => r.probe));
    for (const probe of probes) {
      const first = live.records.find((r) => r.probe === probe && r.sequence === 0);
      expect(first?.moment, probe).toBe("launch-before-first-turn");
      expect(first?.payload.context_window.total_input_tokens, probe).toBe(0);
    }
  });

  it("re-emits with the new model id and the same session after /model", () => {
    const a = live.records.filter((r) => r.probe === "A").sort((x, y) => x.sequence - y.sequence);
    expect(a.length).toBe(3);
    expect(a[2]!.moment).toContain("/model");
    expect(a[2]!.payload.model.id).not.toBe(a[1]!.payload.model.id);
    expect(a[2]!.payload.session_id).toBe(a[1]!.payload.session_id);
  });

  it("does not resolve the window from the family name", () => {
    // Two different families both observed at 1M, one at 200k: the value is
    // the discriminator, the name is not.
    const byModel = new Map(
      live.records.map((r) => [r.payload.model.id, r.payload.context_window.context_window_size]),
    );
    expect(byModel.get("claude-haiku-4-5-20251001")).toBe(200_000);
    expect(byModel.get("claude-sonnet-5")).toBe(1_000_000);
    expect(byModel.get("claude-opus-5")).toBe(1_000_000);
  });

  it("keeps synthetic decision-table cases labelled as such", () => {
    const observed = fixture.statusLineCases.filter((c) => (c as { observed?: boolean }).observed === true);
    const synthetic = fixture.statusLineCases.filter((c) => (c as { observed?: boolean }).observed !== true);
    expect(observed.map((c) => c.name).sort()).toEqual(["documented-1m", "documented-200k"]);
    expect(synthetic.length).toBeGreaterThan(0);
    // A synthetic case may only pin a rule the live route could not reach.
    const liveSizes = new Set(live.records.map((r) => r.payload.context_window.context_window_size));
    for (const c of synthetic) {
      const size = c.payload.context_window?.context_window_size;
      const reachableLive = typeof size === "number" && liveSizes.has(size) && c.pairedWith === undefined;
      expect(reachableLive, `${c.name} would be live-observable and must not stay synthetic`).toBe(false);
    }
  });
});
