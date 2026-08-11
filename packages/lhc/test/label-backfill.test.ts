// Selected-thread label backfill (Slice 7): stored legacy renderings without
// labels are rewritten via pure composition; canonical events are untouched;
// no work is queued; missing/failed renderings are reported, never repaired.
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { countLiveItems, initLhc, type InferenceCallbacks, type Lhc, retrieval, threads, turns } from "../src/index.js";
import { createInferenceCallbacksDouble, openRaw, tempStore, type TempStore, validEvent } from "./fixtures/index.js";

let store: TempStore;
let filePath: string;
let sdk: Lhc;

beforeEach(async () => {
  store = tempStore();
  const created = await threads.newThread({
    filePath: store.threadPath(),
    registryPath: store.registryPath,
  });
  if (!created.ok) throw new Error(`thread creation failed: ${created.error.reason}`);
  filePath = created.value.filePath;
  const callbacks: InferenceCallbacks = createInferenceCallbacksDouble();
  sdk = initLhc({ mode: "manual", inferenceCallbacks: callbacks, lease: { durationMs: 200 } });
});
afterEach(() => {
  store.cleanup();
});

async function seedTurns(count: number): Promise<void> {
  for (let i = 1; i <= count; i += 1) {
    const result = await sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: `question ${i}` } }),
      validEvent("assistant_text", { payload: { text: `answer ${i}` } }),
      validEvent("turn_end"),
    ]);
    if (!result.ok) throw new Error(`batch failed: ${result.error.reason}`);
  }
  const drained = await sdk.work.drain({ filePath });
  if (!drained.ok) throw new Error(`drain failed: ${drained.error.reason}`);
}

function renderingContent(turnId: string): string | null {
  const db = openRaw(filePath);
  try {
    const row = db
      .prepare(
        `SELECT content FROM derivation
         WHERE subject_kind = 'turn' AND subject_id = ? AND derivation_type = 'turn_rendering'`,
      )
      .get(turnId) as { content: string | null } | undefined;
    return row?.content ?? null;
  } finally {
    db.close();
  }
}

function stripLabels(turnId: string): void {
  const db = new DatabaseSync(filePath);
  try {
    db.prepare(
      `UPDATE derivation SET content = 'legacy untagged rendering'
       WHERE subject_kind = 'turn' AND subject_id = ? AND derivation_type = 'turn_rendering'`,
    ).run(turnId);
  } finally {
    db.close();
  }
}

function canonicalEventRows(): string {
  const db = openRaw(filePath);
  try {
    return JSON.stringify(db.prepare(`SELECT event_order, event_kind, payload FROM event ORDER BY event_order`).all());
  } finally {
    db.close();
  }
}

describe("turns.backfillRenderingLabels", () => {
  it("rewrites only legacy unlabeled renderings, leaving canonical events and the queue untouched", async () => {
    await seedTurns(2);
    stripLabels("t1");
    const eventsBefore = canonicalEventRows();

    const result = await sdk.turns.backfillRenderingLabels({ filePath });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.relabeled).toEqual(["t1"]);
    expect(result.value.alreadyLabeled).toBe(1);
    expect(result.value.skipped).toEqual([]);
    expect(result.value.dryRun).toBe(false);

    const rewritten = renderingContent("t1");
    expect(rewritten).not.toBeNull();
    expect(rewritten!.startsWith("<t1>\n")).toBe(true);
    expect(rewritten!.endsWith("\n</t1>")).toBe(true);
    expect(rewritten).toContain("question 1");
    expect(rewritten).toMatch(/<m\d+>/);

    // Retrieval now serves the stored rendering instead of re-composing.
    const served = await retrieval.getTurns({ filePath }, ["t1"]);
    expect(served.ok).toBe(true);
    if (!served.ok) return;
    expect(served.value.served[0]!.source).toBe("stored");
    expect(served.value.served[0]!.text).toBe(rewritten);

    expect(canonicalEventRows()).toBe(eventsBefore);
    const db = openRaw(filePath);
    try {
      expect(countLiveItems(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  it("dry run reports the same selection and mutates nothing", async () => {
    await seedTurns(2);
    stripLabels("t2");
    const before = renderingContent("t2");

    const result = await sdk.turns.backfillRenderingLabels({ filePath }, { dryRun: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.dryRun).toBe(true);
    expect(result.value.relabeled).toEqual(["t2"]);
    expect(renderingContent("t2")).toBe(before);
  });

  it("reports not-ready renderings as skipped and never repairs them", async () => {
    await seedTurns(2);
    const db = new DatabaseSync(filePath);
    try {
      db.prepare(
        `UPDATE derivation SET state = 'failed', content = NULL
         WHERE subject_kind = 'turn' AND subject_id = 't1' AND derivation_type = 'turn_rendering'`,
      ).run();
    } finally {
      db.close();
    }

    const result = await sdk.turns.backfillRenderingLabels({ filePath });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.skipped).toEqual([{ turnId: "t1", reason: "rendering_failed" }]);
    expect(result.value.relabeled).toEqual([]);
    expect(renderingContent("t1")).toBeNull();
  });

  it("module surface exposes the operation", () => {
    expect(typeof turns.backfillRenderingLabels).toBe("function");
  });
});
