import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  applyContextWindow,
  BUILTIN_CONTEXT_POLICIES,
  BUILTIN_CONTEXT_POLICY,
  CONFIG_FALLBACK_NOTICE,
  CONTEXT_POLICY_FIELD_KEYS,
  CONTEXT_WINDOW_NOT_YET_OBSERVED,
  contextWindowDetectionUnavailable,
  formatConfigFallbackNotice,
  loadContextPolicy,
  parseContextPolicyPartial,
  resolveContextWindow,
  validateContextPolicy,
} from "../../src/governor/config.js";

const W200K = resolveContextWindow(200_000, "claude-haiku-4-5-20251001");
const W1M = resolveContextWindow(1_000_000, "claude-opus-5");

function loadWithProject(contents: string, contextWindow = CONTEXT_WINDOW_NOT_YET_OBSERVED) {
  const dir = mkdtempSync(join(tmpdir(), "cc-lhc-cfg-"));
  writeFileSync(join(dir, ".cc-lhc.json"), contents);
  return loadContextPolicy({
    cwd: dir,
    projectConfigPath: join(dir, ".cc-lhc.json"),
    userConfigPath: join(dir, "missing-user.json"),
    contextWindow,
  });
}

describe("built-in policy per context window (TC-1.2a, TC-1.3a)", () => {
  it("200k: 70k target, 140k trigger, 40k minimum runway", () => {
    const p = BUILTIN_CONTEXT_POLICIES["200k"];
    expect([p.lowerBoundTokens, p.upperBoundTokens, p.minRunwayTokens]).toEqual([70_000, 140_000, 40_000]);
    expect(p.profile).toBe("default");
    expect(p.pruneEnabled).toBe(false);
  });

  it("1M: 180k target, 360k trigger, 50k minimum runway", () => {
    const p = BUILTIN_CONTEXT_POLICIES["1M"];
    expect([p.lowerBoundTokens, p.upperBoundTokens, p.minRunwayTokens]).toEqual([180_000, 360_000, 50_000]);
  });

  it("the conservative built-in is the 200k policy", () => {
    expect(BUILTIN_CONTEXT_POLICY).toBe(BUILTIN_CONTEXT_POLICIES["200k"]);
    expect(CONTEXT_WINDOW_NOT_YET_OBSERVED.contextClass).toBe("200k");
  });

  it("the policy carries no disable field", () => {
    expect([...CONTEXT_POLICY_FIELD_KEYS].sort()).toEqual(
      [
        "lowerBoundTokens",
        "minRunwayTokens",
        "profile",
        "pruneEnabled",
        "pruneTargetTokens",
        "pruneThresholdTokens",
        "upperBoundTokens",
      ].sort(),
    );
  });

  it("resolves a load against the observed window", () => {
    expect(loadWithProject("{}", W200K).policy).toEqual(BUILTIN_CONTEXT_POLICIES["200k"]);
    expect(loadWithProject("{}", W1M).policy).toEqual(BUILTIN_CONTEXT_POLICIES["1M"]);
    expect(loadWithProject("{}", W1M).contextWindow).toBe(W1M);
    expect(loadWithProject("{}").policy).toEqual(BUILTIN_CONTEXT_POLICIES["200k"]);
  });
});

describe("exact window resolution (TC-1.1a-d)", () => {
  it("only 200000 and 1000000 select a class", () => {
    expect(W200K).toMatchObject({ contextClass: "200k", source: "observed", unresolvedAdvisory: false });
    expect(W1M).toMatchObject({ contextClass: "1M", source: "observed", unresolvedAdvisory: false });
  });

  it("any other value keeps 200k and is reported; below 200k also raises the advisory", () => {
    const half = resolveContextWindow(500_000, "x");
    expect(half).toMatchObject({ contextClass: "200k", source: "unsupported_value", unresolvedAdvisory: false });
    expect(half.detail).toContain("500000");
    const small = resolveContextWindow(150_000, "x");
    expect(small).toMatchObject({ contextClass: "200k", source: "unsupported_value", unresolvedAdvisory: true });
    expect(resolveContextWindow(1_000_001, "x").contextClass).toBe("200k");
    expect(resolveContextWindow(199_999, "x").unresolvedAdvisory).toBe(true);
  });

  it("does not resolve from the model name", () => {
    expect(resolveContextWindow(200_000, "claude-sonnet-5[1m]").contextClass).toBe("200k");
    expect(resolveContextWindow(1_000_000, "claude-haiku-4-5-20251001").contextClass).toBe("1M");
  });

  it("detection unavailable is a reported conservative fallback with the advisory", () => {
    const r = contextWindowDetectionUnavailable("settings unmergeable");
    expect(r).toMatchObject({ contextClass: "200k", source: "detection_unavailable", unresolvedAdvisory: true });
    expect(r.detail).toContain("settings unmergeable");
  });
});

describe("context policy config", () => {
  it("drops an unknown field and keeps the valid ones beside it", () => {
    const r = parseContextPolicyPartial({ upperBoundTokens: 500_000, mystery: true }, "t");
    expect(r.value.upperBoundTokens).toBe(500_000);
    expect(r.fallbacks.map((f) => f.detail).join(" ")).toMatch(/unknown field "mystery"/);
  });

  it("treats autoCompact as an unknown field, never as a switch (TC-1.5d)", () => {
    const r = parseContextPolicyPartial({ autoCompact: false }, "t");
    expect(r.value).toEqual({});
    expect(r.fallbacks[0]?.detail).toMatch(/unknown field "autoCompact"/);
  });

  it("drops a malformed field and keeps the valid ones beside it", () => {
    const r = parseContextPolicyPartial({ lowerBoundTokens: "big", upperBoundTokens: 500_000 }, "t");
    expect(r.value.lowerBoundTokens).toBeUndefined();
    expect(r.value.upperBoundTokens).toBe(500_000);
    expect(r.fallbacks[0]?.field).toBe("lowerBoundTokens");
  });

  it("validates upper > lower with runway", () => {
    expect(
      validateContextPolicy({
        ...BUILTIN_CONTEXT_POLICY,
        lowerBoundTokens: 100,
        upperBoundTokens: 200,
        minRunwayTokens: 50_000,
      }),
    ).toEqual(expect.arrayContaining([expect.stringMatching(/runway/)]));

    expect(
      validateContextPolicy({
        ...BUILTIN_CONTEXT_POLICY,
        lowerBoundTokens: 500_000,
        upperBoundTokens: 400_000,
      }),
    ).toEqual(expect.arrayContaining([expect.stringMatching(/greater than/)]));
  });

  it("rejects unknown profile and non-integer bounds in a panel edit", () => {
    expect(validateContextPolicy({ ...BUILTIN_CONTEXT_POLICY, profile: "invented" })).toEqual(
      expect.arrayContaining([expect.stringMatching(/profile must be one of default, balanced, historical/)]),
    );
    expect(validateContextPolicy({ ...BUILTIN_CONTEXT_POLICY, upperBoundTokens: Number.NaN })).toEqual(
      expect.arrayContaining([expect.stringMatching(/upperBoundTokens/)]),
    );
  });

  it("precedence: session > project > user > builtin with sources (TC-1.5a, TC-1.5b)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-cfg-"));
    const userDir = join(dir, "user");
    const projectDir = join(dir, "proj");
    mkdirSync(join(userDir, "cc-lhc"), { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(userDir, "cc-lhc", "config.json"),
      JSON.stringify({ upperBoundTokens: 600_000, lowerBoundTokens: 200_000 }),
    );
    writeFileSync(join(projectDir, ".cc-lhc.json"), JSON.stringify({ upperBoundTokens: 550_000, profile: "balanced" }));

    const resolved = loadContextPolicy({
      cwd: projectDir,
      userConfigPath: join(userDir, "cc-lhc", "config.json"),
      projectConfigPath: join(projectDir, ".cc-lhc.json"),
      sessionOverrides: { upperBoundTokens: 520_000 },
      contextWindow: W1M,
    });
    expect(resolved.fallbacks).toEqual([]);
    expect(resolved.policy.upperBoundTokens).toBe(520_000);
    expect(resolved.sources.upperBoundTokens).toBe("session");
    expect(resolved.policy.lowerBoundTokens).toBe(200_000);
    expect(resolved.sources.lowerBoundTokens).toBe("user");
    expect(resolved.policy.profile).toBe("balanced");
    expect(resolved.sources.profile).toBe("project");
    expect(resolved.policy.minRunwayTokens).toBe(50_000);
    expect(resolved.sources.minRunwayTokens).toBe("builtin");
  });

  it("conflicting prune fields fail a panel edit when prune enabled", () => {
    const r = validateContextPolicy({
      ...BUILTIN_CONTEXT_POLICY,
      pruneEnabled: true,
      pruneThresholdTokens: 100,
      pruneTargetTokens: 200,
    });
    expect(r.join(" ")).toMatch(/pruneTargetTokens/);
  });
});

describe("invalid configuration falls back per field to the active window (TC-1.5c)", () => {
  it("unparseable config falls back to the active class built-in", () => {
    const resolved = loadWithProject("{ not json", W1M);
    expect(resolved.policy).toEqual(BUILTIN_CONTEXT_POLICIES["1M"]);
    expect(resolved.fallbacks.some((f) => f.origin.includes(".cc-lhc.json"))).toBe(true);
  });

  it("an empty config file falls back without changing the class", () => {
    const resolved = loadWithProject("   ", W200K);
    expect(resolved.policy).toEqual(BUILTIN_CONTEXT_POLICIES["200k"]);
    expect(resolved.fallbacks.some((f) => f.detail.includes("empty file"))).toBe(true);
  });

  it("a malformed field names the field and its source and takes the class default for it alone", () => {
    const resolved = loadWithProject(JSON.stringify({ lowerBoundTokens: "big", upperBoundTokens: 150_000 }), W200K);
    expect(resolved.policy.lowerBoundTokens).toBe(70_000);
    expect(resolved.sources.lowerBoundTokens).toBe("builtin");
    expect(resolved.policy.upperBoundTokens).toBe(150_000);
    expect(resolved.sources.upperBoundTokens).toBe("project");
    const fallback = resolved.fallbacks.find((f) => f.field === "lowerBoundTokens");
    expect(fallback?.origin).toContain("project config");
    expect(fallback?.detail).toContain("lowerBoundTokens");
  });

  it("incoherent bounds revert only the configured field, to the active class", () => {
    // upper below the 1M built-in lower: the configured upper loses.
    const resolved = loadWithProject(JSON.stringify({ upperBoundTokens: 100_000 }), W1M);
    expect(resolved.policy.upperBoundTokens).toBe(360_000);
    expect(resolved.policy.lowerBoundTokens).toBe(180_000);
    expect(validateContextPolicy(resolved.policy)).toEqual([]);
    const fallback = resolved.fallbacks.find((f) => f.field === "upperBoundTokens");
    expect(fallback?.origin).toContain("project config");
    expect(fallback?.detail).toContain("active context window");
    // An explicit 120k trigger is coherent on 200k (runway 50k), where it is honoured.
    expect(loadWithProject(JSON.stringify({ upperBoundTokens: 120_000 }), W200K).policy.upperBoundTokens).toBe(120_000);
  });

  it("an insufficient runway reverts the configured bounds and stays coherent", () => {
    const resolved = loadWithProject(JSON.stringify({ lowerBoundTokens: 300_000, upperBoundTokens: 310_000 }), W1M);
    expect(validateContextPolicy(resolved.policy)).toEqual([]);
    expect(resolved.fallbacks.length).toBeGreaterThan(0);
  });

  it("every fallback surface carries the required notice sentence", () => {
    const resolved = loadWithProject(JSON.stringify({ pruneEnabled: "no" }));
    const notice = formatConfigFallbackNotice(resolved.fallbacks);
    expect(notice[0]).toBe(CONFIG_FALLBACK_NOTICE);
    expect(notice.length).toBeGreaterThan(1);
    expect(formatConfigFallbackNotice([])).toEqual([]);
  });

  it("no configuration value disables Smart Compact (TC-1.5d)", () => {
    const resolved = loadWithProject(JSON.stringify({ autoCompact: false, enabled: false, smartCompact: "off" }));
    expect(resolved.policy).toEqual(BUILTIN_CONTEXT_POLICIES["200k"]);
    expect(Object.keys(resolved.policy)).not.toContain("autoCompact");
    expect(resolved.fallbacks.map((f) => f.detail).join(" ")).toMatch(/unknown field "autoCompact"/);
  });
});

describe("re-resolution against a newly observed window (TC-1.4a-c)", () => {
  it("1M to 200k: built-in fields move, explicit fields stay with their sources", () => {
    const loaded = loadWithProject(JSON.stringify({ profile: "historical" }), W1M);
    const next = applyContextWindow(loaded, W200K);
    expect([next.policy.lowerBoundTokens, next.policy.upperBoundTokens, next.policy.minRunwayTokens]).toEqual([
      70_000, 140_000, 40_000,
    ]);
    expect(next.policy.profile).toBe("historical");
    expect(next.sources.profile).toBe("project");
    expect(next.contextWindow).toBe(W200K);
  });

  it("200k to 1M restores the 1M built-ins", () => {
    const loaded = loadWithProject("{}", W200K);
    const next = applyContextWindow(loaded, W1M);
    expect(next.policy).toEqual(BUILTIN_CONTEXT_POLICIES["1M"]);
    expect(next.contextWindow).toBe(W1M);
  });

  it("an explicit session value keeps precedence across the change", () => {
    const loaded = loadContextPolicy({
      cwd: tmpdir(),
      userConfigPath: join(tmpdir(), "cc-lhc-none-user.json"),
      projectConfigPath: join(tmpdir(), "cc-lhc-none-project.json"),
      sessionOverrides: { upperBoundTokens: 300_000, lowerBoundTokens: 120_000 },
      contextWindow: W1M,
    });
    const next = applyContextWindow(loaded, W200K);
    expect(next.policy.upperBoundTokens).toBe(300_000);
    expect(next.policy.lowerBoundTokens).toBe(120_000);
    expect(next.sources.upperBoundTokens).toBe("session");
    expect(next.policy.minRunwayTokens).toBe(40_000);
  });

  it("an explicit value that becomes incoherent under the new class falls back per field, named", () => {
    // An explicit 120k trigger is coherent against the 200k built-in lower of
    // 70k but sits below the 1M built-in lower of 180k: moving 200k -> 1M
    // reverts it and says so.
    const loaded = loadWithProject(JSON.stringify({ upperBoundTokens: 120_000 }), W200K);
    expect(loaded.policy.upperBoundTokens).toBe(120_000);
    const next = applyContextWindow(loaded, W1M);
    expect(next.policy.upperBoundTokens).toBe(360_000);
    expect(next.sources.upperBoundTokens).toBe("builtin");
    expect(next.fallbacks.find((f) => f.field === "upperBoundTokens")?.origin).toContain("project");
  });

  it("is a no-op for the same window", () => {
    const loaded = loadWithProject(JSON.stringify({ profile: "balanced" }), W1M);
    const next = applyContextWindow(loaded, W1M);
    expect(next.policy).toEqual(loaded.policy);
    expect(next.sources).toEqual(loaded.sources);
  });
});
