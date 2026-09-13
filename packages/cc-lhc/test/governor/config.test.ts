import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BUILTIN_CONTEXT_POLICY,
  CONFIG_FALLBACK_NOTICE,
  CONTEXT_POLICY_FIELD_KEYS,
  formatConfigFallbackNotice,
  loadContextPolicy,
  parseContextPolicyPartial,
  validateContextPolicy,
} from "../../src/governor/config.js";

function loadWithProject(contents: string) {
  const dir = mkdtempSync(join(tmpdir(), "cc-lhc-cfg-"));
  writeFileSync(join(dir, ".cc-lhc.json"), contents);
  return loadContextPolicy({
    cwd: dir,
    projectConfigPath: join(dir, ".cc-lhc.json"),
    userConfigPath: join(dir, "missing-user.json"),
  });
}

describe("built-in policy", () => {
  it("is 180k target, 360k trigger, 50k minimum runway", () => {
    const p = BUILTIN_CONTEXT_POLICY;
    expect([p.lowerBoundTokens, p.upperBoundTokens, p.minRunwayTokens]).toEqual([180_000, 360_000, 50_000]);
    expect(p.profile).toBe("default");
    expect(p.pruneEnabled).toBe(false);
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

  it("a headless load with no observation step resolves 180k/360k", () => {
    const resolved = loadContextPolicy({
      cwd: tmpdir(),
      userConfigPath: join(tmpdir(), "cc-lhc-none-user.json"),
      projectConfigPath: join(tmpdir(), "cc-lhc-none-project.json"),
    });
    expect(resolved.policy.lowerBoundTokens).toBe(180_000);
    expect(resolved.policy.upperBoundTokens).toBe(360_000);
    expect(resolved.policy.minRunwayTokens).toBe(50_000);
    expect(resolved.fallbacks).toEqual([]);
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

describe("invalid configuration falls back per field to the built-in (TC-1.5c)", () => {
  it("unparseable config falls back to the built-in", () => {
    const resolved = loadWithProject("{ not json");
    expect(resolved.policy).toEqual(BUILTIN_CONTEXT_POLICY);
    expect(resolved.fallbacks.some((f) => f.origin.includes(".cc-lhc.json"))).toBe(true);
  });

  it("an empty config file falls back to the built-in", () => {
    const resolved = loadWithProject("   ");
    expect(resolved.policy).toEqual(BUILTIN_CONTEXT_POLICY);
    expect(resolved.fallbacks.some((f) => f.detail.includes("empty file"))).toBe(true);
  });

  it("a malformed field names the field and its source and takes the built-in for it alone", () => {
    const resolved = loadWithProject(JSON.stringify({ lowerBoundTokens: "big", upperBoundTokens: 400_000 }));
    expect(resolved.policy.lowerBoundTokens).toBe(180_000);
    expect(resolved.sources.lowerBoundTokens).toBe("builtin");
    expect(resolved.policy.upperBoundTokens).toBe(400_000);
    expect(resolved.sources.upperBoundTokens).toBe("project");
    const fallback = resolved.fallbacks.find((f) => f.field === "lowerBoundTokens");
    expect(fallback?.origin).toContain("project config");
    expect(fallback?.detail).toContain("lowerBoundTokens");
  });

  it("incoherent bounds revert only the configured field, to the built-in", () => {
    const resolved = loadWithProject(JSON.stringify({ upperBoundTokens: 100_000 }));
    expect(resolved.policy.upperBoundTokens).toBe(360_000);
    expect(resolved.policy.lowerBoundTokens).toBe(180_000);
    expect(validateContextPolicy(resolved.policy)).toEqual([]);
    const fallback = resolved.fallbacks.find((f) => f.field === "upperBoundTokens");
    expect(fallback?.origin).toContain("project config");
    expect(fallback?.detail).toContain("built-in default");
  });

  it("an insufficient runway reverts the configured bounds and stays coherent", () => {
    const resolved = loadWithProject(JSON.stringify({ lowerBoundTokens: 300_000, upperBoundTokens: 310_000 }));
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
    expect(resolved.policy).toEqual(BUILTIN_CONTEXT_POLICY);
    expect(Object.keys(resolved.policy)).not.toContain("autoCompact");
    expect(resolved.fallbacks.map((f) => f.detail).join(" ")).toMatch(/unknown field "autoCompact"/);
  });
});
