import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BUILTIN_CONTEXT_POLICY,
  CONFIG_FALLBACK_NOTICE,
  formatConfigFallbackNotice,
  loadContextPolicy,
  parseContextPolicyPartial,
  validateContextPolicy,
} from "../../src/governor/config.js";

describe("context policy config", () => {
  it("built-in defaults match steward work-ready path", () => {
    expect(BUILTIN_CONTEXT_POLICY.lowerBoundTokens).toBe(180_000);
    expect(BUILTIN_CONTEXT_POLICY.upperBoundTokens).toBe(360_000);
    expect(BUILTIN_CONTEXT_POLICY.autoCompact).toBe(true);
    expect(BUILTIN_CONTEXT_POLICY.profile).toBe("default");
    expect(BUILTIN_CONTEXT_POLICY.pruneEnabled).toBe(false);
  });

  it("drops an unknown field and keeps the valid ones beside it", () => {
    const r = parseContextPolicyPartial({ upperBoundTokens: 500_000, mystery: true }, "t");
    expect(r.value.upperBoundTokens).toBe(500_000);
    expect(r.fallbacks.map((f) => f.detail).join(" ")).toMatch(/unknown field "mystery"/);
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

  it("precedence: session > project > user > builtin with sources", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-cfg-"));
    const userDir = join(dir, "user");
    const projectDir = join(dir, "proj");
    mkdirSync(join(userDir, "cc-lhc"), { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(userDir, "cc-lhc", "config.json"),
      JSON.stringify({ upperBoundTokens: 600_000, lowerBoundTokens: 200_000 }),
    );
    writeFileSync(join(projectDir, ".cc-lhc.json"), JSON.stringify({ upperBoundTokens: 550_000, autoCompact: true }));

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
    expect(resolved.policy.autoCompact).toBe(true);
    expect(resolved.sources.autoCompact).toBe("project");
    expect(resolved.policy.profile).toBe("default");
    expect(resolved.sources.profile).toBe("builtin");
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

describe("invalid configuration cannot disarm automatic compact", () => {
  function loadWithProject(contents: string): ReturnType<typeof loadContextPolicy> {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-fallback-"));
    writeFileSync(join(dir, ".cc-lhc.json"), contents);
    return loadContextPolicy({
      cwd: dir,
      projectConfigPath: join(dir, ".cc-lhc.json"),
      userConfigPath: join(dir, "missing-user.json"),
    });
  }

  it("unparseable config falls back to built-in defaults with automatic compact still on", () => {
    const resolved = loadWithProject("{ not json");
    expect(resolved.policy).toEqual(BUILTIN_CONTEXT_POLICY);
    expect(resolved.policy.autoCompact).toBe(true);
    expect(resolved.fallbacks.some((f) => f.origin.includes(".cc-lhc.json"))).toBe(true);
  });

  it("an empty config file falls back without disabling anything", () => {
    const resolved = loadWithProject("   ");
    expect(resolved.policy.autoCompact).toBe(true);
    expect(resolved.fallbacks.some((f) => f.detail.includes("empty file"))).toBe(true);
  });

  it("an unknown field is ignored and its neighbours still apply", () => {
    const resolved = loadWithProject(JSON.stringify({ upperBoundTokens: 500_000, compactHarder: true }));
    expect(resolved.policy.upperBoundTokens).toBe(500_000);
    expect(resolved.policy.autoCompact).toBe(true);
    expect(resolved.fallbacks.map((f) => f.detail).join(" ")).toMatch(/compactHarder/);
  });

  it("a malformed autoCompact value falls back to on, never to off", () => {
    const resolved = loadWithProject(JSON.stringify({ autoCompact: "no" }));
    expect(resolved.policy.autoCompact).toBe(true);
    expect(resolved.sources.autoCompact).toBe("builtin");
    expect(resolved.fallbacks[0]?.field).toBe("autoCompact");
  });

  it("incoherent bounds revert only the configured field", () => {
    // upper below the built-in lower: the configured upper loses, and the
    // resulting policy is coherent and still armed.
    const resolved = loadWithProject(JSON.stringify({ upperBoundTokens: 100_000 }));
    expect(resolved.policy.upperBoundTokens).toBe(BUILTIN_CONTEXT_POLICY.upperBoundTokens);
    expect(resolved.policy.lowerBoundTokens).toBe(BUILTIN_CONTEXT_POLICY.lowerBoundTokens);
    expect(resolved.policy.autoCompact).toBe(true);
    expect(validateContextPolicy(resolved.policy)).toEqual([]);
    expect(resolved.fallbacks.some((f) => f.field === "upperBoundTokens")).toBe(true);
  });

  it("an insufficient runway reverts the configured bounds and stays armed", () => {
    const resolved = loadWithProject(JSON.stringify({ lowerBoundTokens: 300_000, upperBoundTokens: 310_000 }));
    expect(validateContextPolicy(resolved.policy)).toEqual([]);
    expect(resolved.policy.autoCompact).toBe(true);
    expect(resolved.fallbacks.length).toBeGreaterThan(0);
  });

  it("every fallback surface carries the required notice sentence", () => {
    const resolved = loadWithProject(JSON.stringify({ autoCompact: "no" }));
    const notice = formatConfigFallbackNotice(resolved.fallbacks);
    expect(notice[0]).toBe(CONFIG_FALLBACK_NOTICE);
    expect(notice.length).toBeGreaterThan(1);
    expect(formatConfigFallbackNotice([])).toEqual([]);
  });

  it("explicit autoCompact:false is honoured — the one legitimate stop", () => {
    const resolved = loadWithProject(JSON.stringify({ autoCompact: false }));
    expect(resolved.policy.autoCompact).toBe(false);
    expect(resolved.sources.autoCompact).toBe("project");
    expect(resolved.fallbacks).toEqual([]);
  });
});
