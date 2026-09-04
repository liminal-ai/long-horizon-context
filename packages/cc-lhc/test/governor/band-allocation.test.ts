/**
 * LIM-117: TC-4.1b-c, TC-4.2b-c.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Lhc, ThreadRef } from "lhc";
import { describe, expect, it, vi } from "vitest";

import { runCompactCommand } from "../../src/commands/compact.js";
import type { LhcCommandRuntime } from "../../src/commands/dispatch.js";
import {
  allocationById,
  BAND_ALLOCATIONS,
  compactConstruction,
  mutationCoreProfile,
  PRODUCT_PRESET_IDS,
} from "../../src/governor/band-allocation.js";
import { BUILTIN_CONTEXT_POLICY, loadContextPolicy } from "../../src/governor/config.js";
import * as writeRebuilt from "../../src/rollout/write-rebuilt.js";
import { emptyCaptureStats } from "../../src/stats.js";

describe("TC-4.1b Balanced allocation", () => {
  it("resolves Balanced to 25/25/25/25 and internal cc-lhc-balanced", () => {
    const allocation = allocationById("balanced");
    expect(allocation.label).toBe("Balanced");
    expect(allocation.description).toBe("equal fidelity distribution");
    expect([allocation.low, allocation.medium, allocation.high, allocation.full]).toEqual([25, 25, 25, 25]);
    expect(allocation.coreProfile).toBe("cc-lhc-balanced");
    expect(mutationCoreProfile("balanced")).toBe("cc-lhc-balanced");
    expect(compactConstruction({ profile: "balanced", lowerBoundTokens: 180_000 })).toEqual({
      profile: "cc-lhc-balanced",
      params: { lowerBound: 180_000 },
    });
  });
});

describe("TC-4.1c Historical allocation", () => {
  it("resolves Historical to 30/20/30/20 Low-to-Full and internal cc-lhc-historical", () => {
    const allocation = allocationById("historical");
    expect(allocation.label).toBe("Historical");
    expect(allocation.description).toBe("broader low-fidelity history");
    expect([allocation.low, allocation.medium, allocation.high, allocation.full]).toEqual([30, 20, 30, 20]);
    expect(allocation.coreProfile).toBe("cc-lhc-historical");
    expect(mutationCoreProfile("historical")).toBe("cc-lhc-historical");
    expect(compactConstruction({ profile: "historical", lowerBoundTokens: 90_000 })).toEqual({
      profile: "cc-lhc-historical",
      params: { lowerBound: 90_000 },
    });
  });
});

describe("TC-4.2b configured selection precedence is shared by every mutation entry", () => {
  it("user/project/session precedence resolves one preset shared by automatic/manual/one-shot mutation", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-preset-"));
    mkdirSync(join(dir, "user", "cc-lhc"), { recursive: true });
    writeFileSync(join(dir, "user", "cc-lhc", "config.json"), JSON.stringify({ profile: "balanced" }));
    writeFileSync(join(dir, ".cc-lhc.json"), JSON.stringify({ profile: "historical" }));

    const fromProject = loadContextPolicy({
      cwd: dir,
      userConfigPath: join(dir, "user", "cc-lhc", "config.json"),
      projectConfigPath: join(dir, ".cc-lhc.json"),
    });
    expect(fromProject.fallbacks).toEqual([]);
    expect(fromProject.policy.profile).toBe("historical");
    expect(fromProject.sources.profile).toBe("project");

    const fromSession = loadContextPolicy({
      cwd: dir,
      userConfigPath: join(dir, "user", "cc-lhc", "config.json"),
      projectConfigPath: join(dir, ".cc-lhc.json"),
      sessionOverrides: { profile: "balanced" },
    });
    expect(fromSession.policy.profile).toBe("balanced");
    expect(fromSession.sources.profile).toBe("session");

    const automatic = compactConstruction(fromSession.policy);
    const manual = compactConstruction(fromSession.policy);
    const oneShot = compactConstruction(fromSession.policy);
    expect(automatic).toEqual(manual);
    expect(manual).toEqual(oneShot);
    expect(automatic).toEqual({
      profile: "cc-lhc-balanced",
      params: { lowerBound: BUILTIN_CONTEXT_POLICY.lowerBoundTokens },
    });
    expect(PRODUCT_PRESET_IDS).toEqual(["default", "balanced", "historical"]);
    expect(BAND_ALLOCATIONS).toHaveLength(3);
  });

  it("manual compact command passes mapped Historical profile and explicit lowerBound to core", async () => {
    const writeSpy = vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockResolvedValue({
      sessionId: "new-manual",
      rolloutPath: "/tmp/new-manual.jsonl",
      lineCount: 2,
      expectedReintakeLines: 2,
      replayedPrefixLines: 1,
      prefixBoundary: { kind: "verified", lineCount: 1, byteLength: 10, sha256: "ab".repeat(32) },
      totalByteLength: 20,
    });
    const sdk = {
      threadView: {
        previewCompact: vi.fn(async () => ({ ok: true, value: { kind: "ok" } })),
        compact: vi.fn(async () => ({
          ok: true,
          value: {
            viewId: "v1",
            tailTokens: 4,
            totalTokens: 9,
            bands: {
              smooth: { entries: 1, tokens: 5 },
              detailed: { entries: 0, tokens: 0 },
              brief: { entries: 0, tokens: 0 },
            },
          },
        })),
        getSessionThreadView: vi.fn(async () => ({
          ok: true,
          value: { threadId: "th", entries: [{ role: "user", content: "hi", sourceMessages: [] }] },
        })),
      },
    };
    const runtime: LhcCommandRuntime = {
      stats: { ...emptyCaptureStats(), threadId: "th" },
      sdk: sdk as unknown as Lhc,
      threadRef: { threadId: "th", registryPath: "/tmp/r.sqlite" } as ThreadRef,
      cwd: "/work",
      sourceRolloutPath: undefined,
      sourceSessionId: "old-1111",
      isTurnOpen: () => false,
      isCaptureHealthy: () => true,
      isCaptureReady: () => true,
      getCaptureGeneration: () => 1,
      capturePhase: "ready",
      captureDegraded: false,
      captureGeneration: 1,
      getLiveAsyncWork: () => [],
      contextPolicy: { profile: "historical", lowerBoundTokens: 3_300 },
    };
    const outcome = await runCompactCommand("compact", runtime);
    expect(outcome.handoff?.rebuilt.sessionId).toBe("new-manual");
    expect(sdk.threadView.previewCompact).toHaveBeenCalledWith(expect.anything(), {
      profile: "cc-lhc-historical",
      params: { lowerBound: 3_300 },
    });
    expect(sdk.threadView.compact).toHaveBeenCalledWith(expect.anything(), {
      profile: "cc-lhc-historical",
      params: { lowerBound: 3_300 },
    });
    writeSpy.mockRestore();
  });
});

describe("TC-4.2c reject unknown selection", () => {
  it("unknown/old core value uses exact visible Default field fallback without silent normalization", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-preset-bad-"));
    writeFileSync(join(dir, ".cc-lhc.json"), JSON.stringify({ profile: "continuation" }));
    const legacy = loadContextPolicy({
      cwd: dir,
      projectConfigPath: join(dir, ".cc-lhc.json"),
      userConfigPath: join(dir, "missing-user.json"),
    });
    expect(legacy.policy.profile).toBe("default");
    expect(legacy.sources.profile).toBe("builtin");
    expect(legacy.fallbacks.some((fallback) => fallback.field === "profile")).toBe(true);
    expect(legacy.fallbacks.map((fallback) => fallback.detail).join("\n")).toContain(
      "profile must be one of default, balanced, historical",
    );

    writeFileSync(join(dir, ".cc-lhc.json"), JSON.stringify({ profile: "coding" }));
    const coding = loadContextPolicy({
      cwd: dir,
      projectConfigPath: join(dir, ".cc-lhc.json"),
      userConfigPath: join(dir, "missing-user.json"),
    });
    expect(coding.policy.profile).toBe("default");
    expect(coding.sources.profile).toBe("builtin");

    writeFileSync(join(dir, ".cc-lhc.json"), JSON.stringify({ profile: "invented" }));
    const invented = loadContextPolicy({
      cwd: dir,
      projectConfigPath: join(dir, ".cc-lhc.json"),
      userConfigPath: join(dir, "missing-user.json"),
    });
    expect(invented.policy.profile).toBe("default");
    expect(Object.keys(invented.policy)).not.toContain("autoCompact");
  });
});
