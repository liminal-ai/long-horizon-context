// Epic 03 Story 0 foundation checks (FC-0.1–FC-0.6): view storage,
// profile config validation through real initLhc construction, the
// derived-thread fixture's state fidelity proven by read-back through the
// owning report surfaces (states reached through production drains, never
// hand-written rows), the corruption variant, and the two-point test injection
// facility.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { initLhc, type Lhc, messages, turns } from "../src/index.js";
import {
  blockedSiblingThread,
  corruptedVariantThread,
  createInferenceCallbacksDouble,
  type DerivedThreadFixture,
  derivedThreadFixture,
  fireViewInjection,
  openRaw,
  PERMANENT_FAILURE_REASON,
  RATE_LIMIT_FAILURE_REASON,
  setViewInjectionHook,
  type TempStore,
  tempStore,
  validEvent,
} from "./fixtures/index.js";

// The main fixture is the suite's load-bearing asset and is expensive to
// drain; it is built once and read (never mutated) by every check below.
let store: TempStore;
let fixture: DerivedThreadFixture;

beforeAll(async () => {
  store = tempStore();
  fixture = await derivedThreadFixture(store);
});
afterAll(() => {
  store.cleanup();
});

function manualSdk(view?: Parameters<typeof initLhc>[0]["view"]): Lhc {
  return initLhc({
    inferenceCallbacks: createInferenceCallbacksDouble(),
    mode: "manual",
    ...(view === undefined ? {} : { view }),
  });
}

describe("FC-0.1: current view storage on a current thread file", () => {
  it("creates the three view tables with their CHECK constraints and seeds the boundary at 0", () => {
    const db = openRaw(fixture.filePath);
    try {
      const version = db.prepare("PRAGMA user_version").get() as { user_version: number | bigint } | undefined;
      expect(Number(version?.user_version ?? 0)).toBe(4);

      const tables = (
        db
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'table'
             AND name IN ('thread_view', 'thread_view_band', 'view_boundary') ORDER BY name`,
          )
          .all() as unknown as Array<{ name: string }>
      ).map((row) => row.name);
      expect(tables).toEqual(["thread_view", "thread_view_band", "view_boundary"]);

      // The boundary singleton is seeded at position 0 (everything full).
      const boundary = db
        .prepare(`SELECT thread_singleton, position, updated_at FROM view_boundary`)
        .all() as unknown as Array<{
        thread_singleton: number | bigint;
        position: number | bigint;
        updated_at: string;
      }>;
      expect(boundary).toHaveLength(1);
      expect(Number(boundary[0]!.thread_singleton)).toBe(1);
      expect(Number(boundary[0]!.position)).toBe(0);
      expect(boundary[0]!.updated_at.length).toBeGreaterThan(0);

      // Singleton CHECKs enforce structurally: a second view row or a second
      // boundary row cannot exist (failed inserts, nothing mutated).
      expect(() =>
        db
          .prepare(
            `INSERT INTO thread_view (singleton, view_id, created_at, compact_point,
               covered_from, config_json, arrangement_json, gaps_json, source_state_json)
             VALUES (2, 'v1', 'now', 0, 0, '{}', '[]', '[]', '{}')`,
          )
          .run(),
      ).toThrow(/CHECK/);
      expect(() =>
        db.prepare(`INSERT INTO view_boundary (thread_singleton, position, updated_at) VALUES (2, 0, 'now')`).run(),
      ).toThrow(/CHECK/);

      // The band table pins its band vocabulary and cascade in the DDL.
      const bandDdl = (
        db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'thread_view_band'`).get() as { sql: string }
      ).sql;
      expect(bandDdl).toContain("CHECK (band IN ('brief','detailed','smooth'))");
      expect(bandDdl).toContain("ON DELETE CASCADE");
    } finally {
      db.close();
    }
  });
});

describe("FC-0.2: view config validated at SDK construction, errors naming the violation", () => {
  it("rejects a profile whose band percentages do not sum to 100", () => {
    expect(() =>
      manualSdk({
        profiles: [
          {
            name: "skewed",
            lowerBound: 50000,
            percentages: { full: 30, smooth: 35, detailed: 20, brief: 20 },
          },
        ],
      }),
    ).toThrow(/profile "skewed": percentages must sum to 100, got 105/);
  });

  it("rejects visibility budgets violating max > target, naming the constraint", () => {
    expect(() => manualSdk({ visibility: { maxTokens: 24000, targetTokens: 24000 } })).toThrow(
      /visibility\.maxTokens \(24000\) must be greater than targetTokens \(24000\)/,
    );
  });

  it("rejects a non-positive lower bound", () => {
    expect(() =>
      manualSdk({
        profiles: [
          {
            name: "hollow",
            lowerBound: 0,
            percentages: { full: 25, smooth: 35, detailed: 20, brief: 20 },
          },
        ],
      }),
    ).toThrow(/profile "hollow": lowerBound must be a positive number, got 0/);
  });

  it("rejects a partial profile that overrides no built-in (unknown override target)", () => {
    expect(() => manualSdk({ profiles: [{ name: "mystery", lowerBound: 64000 }] })).toThrow(
      /profile "mystery" is partial but overrides no built-in \(unknown built-in override target\)/,
    );
  });

  it("resolves defaults and merges a built-in override field-wise", () => {
    const sdk = manualSdk({ profiles: [{ name: "coding", lowerBound: 64000 }] });
    expect(sdk.config.view.visibility).toEqual({
      maxTokens: 64000,
      targetTokens: 32000,
    });
    expect(sdk.config.view.compactThreshold).toBe(160000);
    // The override replaced only the named field; the built-in's percentages
    // survive, and the other built-ins are untouched.
    expect(sdk.config.view.profiles["coding"]).toEqual({
      name: "coding",
      lowerBound: 64000,
      percentages: { full: 25, smooth: 35, detailed: 20, brief: 20 },
    });
    expect(sdk.config.view.profiles["continuation"]).toEqual({
      name: "continuation",
      lowerBound: 120000,
      percentages: { full: 30, smooth: 30, detailed: 20, brief: 20 },
    });
    expect(sdk.config.view.profiles["conversation"]?.percentages).toEqual({
      full: 12,
      smooth: 48,
      detailed: 20,
      brief: 20,
    });
  });
});

describe("FC-0.3: fixture states proven by read-back through the owning report surfaces", () => {
  it("ready: every turn rendering and the closed chunks' summaries read back ready through turns.report", async () => {
    const report = await turns.report({ filePath: fixture.filePath });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const renderings = report.value.filter((entry) => entry.derivationType === "turn_rendering");
    expect(renderings.map((entry) => entry.subjectId).sort()).toEqual([...fixture.turnIds].sort());
    for (const rendering of renderings) {
      expect(rendering.state).toBe("ready");
      expect(rendering.content).toBeDefined();
    }
    // The fixture's pinned shape: 4 chunks, c1–c3 closed with both summary
    // forms ready (the drain ran their close→summary enqueues to completion).
    expect(fixture.chunks.chunks.map((chunk) => `${chunk.chunkId}:${chunk.status}`)).toEqual([
      "c1:closed",
      "c2:closed",
      "c3:closed",
      "c4:open",
    ]);
    for (const chunkId of ["c1", "c2", "c3"]) {
      for (const form of ["chunk_summary_detailed", "chunk_summary_brief"]) {
        const summary = report.value.find((entry) => entry.subjectId === chunkId && entry.derivationType === form);
        expect(summary?.state).toBe("ready");
      }
    }
  });

  it("failed-transient and failed-permanent: the scripted subjects read back failed through messages.report", async () => {
    const report = await messages.report({ filePath: fixture.filePath }, { notReady: true });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const transient = report.value.find((entry) => entry.subjectId === fixture.failedTransientMessageId);
    expect(transient?.derivationType).toBe("tool_result_summary");
    expect(transient?.state).toBe("failed");
    const permanent = report.value.find((entry) => entry.subjectId === fixture.failedPermanentMessageId);
    expect(permanent?.derivationType).toBe("tool_result_summary");
    expect(permanent?.state).toBe("failed");
    // Terminal failures left no live queue rows behind (DD-1): neither entry
    // carries queue detail.
    expect(transient?.queue).toBeUndefined();
    expect(permanent?.queue).toBeUndefined();
  });

  it("blocked: real source damage on the sacrificial sibling lands the turn forms blocked", async () => {
    const sibling = await blockedSiblingThread(store);
    const report = await turns.report({ filePath: sibling.filePath });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const blocked = report.value.filter(
      (entry) => entry.subjectId === sibling.blockedTurnId && entry.state === "blocked",
    );
    expect(blocked.map((entry) => entry.derivationType).sort()).toEqual(["pre_detailed_assembly", "turn_rendering"]);
    for (const entry of blocked) {
      expect(entry.reason).toMatch(/^source_damaged: turn state corrupt/);
    }
  });
});

describe("FC-0.4: the two failed forms carry distinguishable reason classes (Story 3 dependency)", () => {
  it("failed derivations persist the attempt's reason class", async () => {
    const report = await messages.report({ filePath: fixture.filePath }, { notReady: true });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const transient = report.value.find((entry) => entry.subjectId === fixture.failedTransientMessageId);
    const permanent = report.value.find((entry) => entry.subjectId === fixture.failedPermanentMessageId);

    expect(transient?.reason).toBe(RATE_LIMIT_FAILURE_REASON);
    expect(transient?.reason).toMatch(/^rate_limit:/);

    expect(permanent?.reason).toBe(PERMANENT_FAILURE_REASON);
    expect(permanent?.reason).toMatch(/^content_refusal:/);

    // The classes are distinguishable on read-back.
    expect(transient?.reason).not.toBe(permanent?.reason);
  });
});

describe("FC-0.5: corruption variant", () => {
  it("the corruption variant refuses canonical consumption with state_corruption naming the damage", async () => {
    const corrupted = await corruptedVariantThread(store);
    const refused = await corrupted.sdk.intakeStream.messageEvents({ filePath: corrupted.filePath }, [
      validEvent("user_prompt", { payload: { text: "after the damage" } }),
    ]);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.errorClass).toBe("state_corruption");
    expect(refused.error.code).toBe("turn_state_corrupt");
    expect(refused.error.reason).toMatch(/open turns/);
  });
});

describe("FC-0.6: the compact-write injection point", () => {
  afterEach(() => {
    setViewInjectionHook("compact-write", null);
  });

  it("uninstalled, the point is a no-op", () => {
    expect(() => fireViewInjection("compact-write")).not.toThrow();
  });

  it("an installed hook fires, its throw propagates, and uninstalling restores the no-op", () => {
    const fired: string[] = [];
    setViewInjectionHook("compact-write", () => {
      fired.push("compact");
    });
    fireViewInjection("compact-write");
    expect(fired).toEqual(["compact"]);

    setViewInjectionHook("compact-write", () => {
      throw new Error("injected crash between sweep and view write");
    });
    expect(() => fireViewInjection("compact-write")).toThrow(/injected crash/);

    setViewInjectionHook("compact-write", null);
    fired.length = 0;
    fireViewInjection("compact-write");
    expect(fired).toEqual([]);
  });
});
