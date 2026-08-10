import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BUILTIN_CONTEXT_POLICY,
  loadContextPolicy,
  parseContextPolicyPartial,
  validateContextPolicy,
} from "../../src/governor/config.js";

describe("context policy config", () => {
  it("built-in defaults match steward work-ready path", () => {
    expect(BUILTIN_CONTEXT_POLICY.lowerBoundTokens).toBe(240_000);
    expect(BUILTIN_CONTEXT_POLICY.upperBoundTokens).toBe(500_000);
    expect(BUILTIN_CONTEXT_POLICY.nativeBackstopTokens).toBe(1_000_000);
    expect(BUILTIN_CONTEXT_POLICY.autoCompact).toBe(true);
    expect(BUILTIN_CONTEXT_POLICY.observeOnly).toBe(false);
    expect(BUILTIN_CONTEXT_POLICY.profile).toBe("continuation");
    expect(BUILTIN_CONTEXT_POLICY.pruneEnabled).toBe(false);
  });

  it("rejects unknown fields", () => {
    const r = parseContextPolicyPartial({ upperBoundTokens: 1, mystery: true }, "t");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/unknown field "mystery"/);
  });

  it("rejects malformed types", () => {
    const r = parseContextPolicyPartial({ lowerBoundTokens: "big" }, "t");
    expect(r.ok).toBe(false);
  });

  it("rejects observeOnly in persisted config", () => {
    const r = parseContextPolicyPartial({ observeOnly: true }, "user");
    expect(r.ok).toBe(false);
  });

  it("validates upper > lower with runway and native > upper", () => {
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
        upperBoundTokens: 900_000,
        nativeBackstopTokens: 800_000,
      }),
    ).toEqual(expect.arrayContaining([expect.stringMatching(/nativeBackstopTokens/)]));

    expect(
      validateContextPolicy({
        ...BUILTIN_CONTEXT_POLICY,
        lowerBoundTokens: 500_000,
        upperBoundTokens: 400_000,
      }),
    ).toEqual(expect.arrayContaining([expect.stringMatching(/greater than/)]));
  });

  it("rejects unknown profile", () => {
    expect(
      validateContextPolicy({ ...BUILTIN_CONTEXT_POLICY, profile: "invented" }),
    ).toEqual(expect.arrayContaining([expect.stringMatching(/canonical LHC profile/)]));
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
    writeFileSync(
      join(projectDir, ".cc-lhc.json"),
      JSON.stringify({ upperBoundTokens: 550_000, autoCompact: true }),
    );

    const resolved = loadContextPolicy({
      cwd: projectDir,
      userConfigPath: join(userDir, "cc-lhc", "config.json"),
      projectConfigPath: join(projectDir, ".cc-lhc.json"),
      sessionOverrides: { upperBoundTokens: 520_000 },
    });
    expect(resolved.armed).toBe(true);
    expect(resolved.policy.upperBoundTokens).toBe(520_000);
    expect(resolved.sources.upperBoundTokens).toBe("session");
    expect(resolved.policy.lowerBoundTokens).toBe(200_000);
    expect(resolved.sources.lowerBoundTokens).toBe("user");
    expect(resolved.policy.autoCompact).toBe(true);
    expect(resolved.sources.autoCompact).toBe("project");
    expect(resolved.policy.profile).toBe("continuation");
    expect(resolved.sources.profile).toBe("builtin");
  });

  it("malformed project config fails loudly and does not arm", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-bad-"));
    writeFileSync(join(dir, ".cc-lhc.json"), "{ not json");
    const resolved = loadContextPolicy({
      cwd: dir,
      projectConfigPath: join(dir, ".cc-lhc.json"),
      userConfigPath: join(dir, "missing-user.json"),
    });
    expect(resolved.armed).toBe(false);
    expect(resolved.errors.some((e) => e.includes(".cc-lhc.json"))).toBe(true);
  });

  it("conflicting prune fields fail when prune enabled", () => {
    const r = validateContextPolicy({
      ...BUILTIN_CONTEXT_POLICY,
      pruneEnabled: true,
      pruneThresholdTokens: 100,
      pruneTargetTokens: 200,
    });
    expect(r.join(" ")).toMatch(/pruneTargetTokens/);
  });
});
