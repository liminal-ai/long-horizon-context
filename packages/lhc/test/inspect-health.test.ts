import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HealthReport, initLhc, intakeStream, threads } from "../src/index.js";
import {
  createInferenceCallbacksDouble,
  expectReadOnly,
  mixedStateVariantThread,
  mutationInFlightVariant,
  PERMANENT_FAILURE_REASON,
  RATE_LIMIT_FAILURE_REASON,
  type TempStore,
  tempStore,
  validEvent,
} from "./fixtures/index.js";
import { o200k, withEstimator } from "./fixtures/tokens.js";

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
});

function healthValue(result: { ok: boolean }): HealthReport {
  if (!result.ok) {
    throw new Error(`expected ok health report: ${JSON.stringify(result)}`);
  }
  return (result as { ok: true; value: HealthReport }).value;
}

const ZERO = { ready: 0, pending: 0, failed: 0, blocked: 0 };

async function createThread(): Promise<string> {
  const filePath = store.threadPath();
  const created = await threads.newThread({ filePath, registryPath: store.registryPath });
  if (!created.ok) throw new Error(`fixture thread creation failed: ${created.error.reason}`);
  return filePath;
}

describe("TC-4.1 / AC-4.1, AC-4.5: counts per owner/kind/state and queue consistency", () => {
  it("the mixed-state fixture reports exact counts and a queue section consistent with them", async () => {
    const fixture = await mixedStateVariantThread(store);
    const { filePath, sdk } = fixture;

    const health = await expectReadOnly(filePath, () => sdk.inspect.health({ filePath }));
    expect(health.ok).toBe(true);
    if (!health.ok) return;
    const report = health.value;

    expect(report.owners).toEqual([
      { owner: "messages", kind: "smoothed_prompt", counts: { ...ZERO, ready: 13, pending: 1 } },
      { owner: "messages", kind: "tool_result_summary", counts: { ...ZERO, ready: 6, failed: 2 } },
      { owner: "turns", kind: "chunk_summary_brief", counts: { ...ZERO, ready: 3 } },
      { owner: "turns", kind: "chunk_summary_detailed", counts: { ...ZERO, ready: 3 } },
      { owner: "turns", kind: "detailed_turn_compression", counts: { ...ZERO, ready: 12 } },
      { owner: "turns", kind: "pre_detailed_assembly", counts: { ...ZERO, ready: 12, blocked: 1 } },
      { owner: "turns", kind: "turn_rendering", counts: { ...ZERO, ready: 12, blocked: 1 } },
    ]);

    expect(report.queue).toEqual({ queued: 1, claimed: 0 });
    const pendingTotal = report.owners.reduce((sum, row) => sum + row.counts.pending, 0);
    expect(report.queue.queued + report.queue.claimed).toBe(pendingTotal);
  });
});

describe("TC-4.2 / AC-4.2, AC-4.3: failure detail and repair preview", () => {
  it("failed entries carry exact detail; the preview is exactly the failed-not-blocked set", async () => {
    const fixture = await mixedStateVariantThread(store);
    const { filePath, sdk } = fixture;
    const report = healthValue(await sdk.inspect.health({ filePath }));

    const failed = report.failures.filter(
      (entry) => entry.reason.startsWith("rate_limit") || entry.reason.startsWith("content_refusal"),
    );
    expect(failed).toEqual([
      {
        owner: "messages",
        subjectKind: "message",
        subjectId: fixture.failedTransientMessageId,
        derivationType: "tool_result_summary",
        reason: RATE_LIMIT_FAILURE_REASON,
      },
      {
        owner: "messages",
        subjectKind: "message",
        subjectId: fixture.failedPermanentMessageId,
        derivationType: "tool_result_summary",
        reason: PERMANENT_FAILURE_REASON,
      },
    ]);

    const blocked = report.failures.filter((entry) => !failed.includes(entry));
    expect(blocked.map((entry) => [entry.owner, entry.subjectKind, entry.subjectId, entry.derivationType])).toEqual([
      ["turns", "turn", fixture.blockedTurnId, "pre_detailed_assembly"],
      ["turns", "turn", fixture.blockedTurnId, "turn_rendering"],
    ]);
    for (const entry of blocked) {
      expect(entry.reason.length).toBeGreaterThan(0);
    }

    expect(report.repairPreview).toEqual([
      {
        owner: "messages",
        subjectKind: "message",
        subjectId: fixture.failedTransientMessageId,
        derivationType: "tool_result_summary",
      },
      {
        owner: "messages",
        subjectKind: "message",
        subjectId: fixture.failedPermanentMessageId,
        derivationType: "tool_result_summary",
      },
    ]);

    const again = healthValue(await sdk.inspect.health({ filePath }));
    expect(again).toEqual(report);
  });
});

describe("TC-2.8 / AC-2.7: capture gaps in health", () => {
  it("reports durable capture-gap runtime_note markers as capture health failures", async () => {
    const filePath = await createThread();
    const gap = validEvent("runtime_note", {
      idempotencyKey: "gap-1",
      actor: "system",
      harness: "pi",
      payload: { text: "capture gap: 1 event(s) rejected - payload mismatch" },
    });
    const recorded = await withEstimator(o200k, () => intakeStream.messageEvents({ filePath }, [gap]));
    expect(recorded.ok).toBe(true);

    const reader = initLhc({
      tokenFamily: "o200k",
      inferenceCallbacks: createInferenceCallbacksDouble(),
      mode: "manual",
    });
    const report = healthValue(await expectReadOnly(filePath, () => reader.inspect.health({ filePath })));
    expect(report.owners).toContainEqual({
      owner: "capture",
      kind: "capture_gap",
      counts: { ...ZERO, failed: 1 },
    });
    expect(report.failures).toContainEqual({
      owner: "capture",
      subjectKind: "event",
      subjectId: "1",
      derivationType: "capture_gap",
      reason: gap.payload.text,
    });
    expect(report.repairPreview).toEqual([]);
  });
});

describe("TC-4.3 / AC-4.4: rebuild visibility brackets a drain", () => {
  it("after an edit the cascade's cleared set is pending with queued work; after the drain the same set is ready; nothing else moved", async () => {
    const fixture = await mutationInFlightVariant(store);
    const { filePath, sdk } = fixture;

    const clearedKeys = fixture.mutation.cleared
      .map((target) => `${target.subjectKind}:${target.subjectId}:${target.derivationType}`)
      .sort();
    expect(clearedKeys).toEqual(
      [
        `message:${fixture.editedMessageId}:smoothed_prompt`,
        "turn:t2:turn_rendering",
        "turn:t2:pre_detailed_assembly",
        "turn:t2:detailed_turn_compression",
        "chunk:c1:chunk_summary_detailed",
        "chunk:c1:chunk_summary_brief",
      ].sort(),
    );

    const before = healthValue(await expectReadOnly(filePath, () => sdk.inspect.health({ filePath })));
    expect(before.owners).toEqual([
      { owner: "messages", kind: "smoothed_prompt", counts: { ...ZERO, ready: 11, pending: 1 } },
      { owner: "messages", kind: "tool_result_summary", counts: { ...ZERO, ready: 8 } },
      { owner: "turns", kind: "chunk_summary_brief", counts: { ...ZERO, ready: 2, pending: 1 } },
      { owner: "turns", kind: "chunk_summary_detailed", counts: { ...ZERO, ready: 2, pending: 1 } },
      { owner: "turns", kind: "detailed_turn_compression", counts: { ...ZERO, ready: 11, pending: 1 } },
      { owner: "turns", kind: "pre_detailed_assembly", counts: { ...ZERO, ready: 11, pending: 1 } },
      { owner: "turns", kind: "turn_rendering", counts: { ...ZERO, ready: 11, pending: 1 } },
    ]);
    expect(before.queue).toEqual({ queued: 6, claimed: 0 });
    expect(before.failures).toEqual([]);
    expect(before.repairPreview).toEqual([]);

    const messagesPending = await sdk.messages.report({ filePath }, { notReady: true });
    const turnsPending = await sdk.turns.report({ filePath }, { notReady: true });
    expect(messagesPending.ok && turnsPending.ok).toBe(true);
    if (!messagesPending.ok || !turnsPending.ok) return;
    const pendingKeys = [...messagesPending.value, ...turnsPending.value]
      .filter((entry) => entry.state === "pending")
      .map((entry) => `${entry.subjectKind}:${entry.subjectId}:${entry.derivationType}`)
      .sort();
    expect(pendingKeys).toEqual(clearedKeys);

    const drained = await sdk.work.drain({ filePath });
    expect(drained.ok).toBe(true);
    await sdk.drainSettled({ filePath });

    const after = healthValue(await sdk.inspect.health({ filePath }));
    expect(after.owners).toEqual([
      { owner: "messages", kind: "smoothed_prompt", counts: { ...ZERO, ready: 12 } },
      { owner: "messages", kind: "tool_result_summary", counts: { ...ZERO, ready: 8 } },
      { owner: "turns", kind: "chunk_summary_brief", counts: { ...ZERO, ready: 3 } },
      { owner: "turns", kind: "chunk_summary_detailed", counts: { ...ZERO, ready: 3 } },
      { owner: "turns", kind: "detailed_turn_compression", counts: { ...ZERO, ready: 12 } },
      { owner: "turns", kind: "pre_detailed_assembly", counts: { ...ZERO, ready: 12 } },
      { owner: "turns", kind: "turn_rendering", counts: { ...ZERO, ready: 12 } },
    ]);
    expect(after.queue).toEqual({ queued: 0, claimed: 0 });
    expect(after.failures).toEqual([]);
  });
});

describe("architecture risk: health is inference-callback-free and surface-composed", () => {
  it("health succeeds under a throwing inference callback and calls no model on the fixture SDK", async () => {
    const fixture = await mixedStateVariantThread(store);
    const captured = fixture.double.captureInputs();

    const refuse = (): never => {
      throw new Error("inference callbacks must never be called by a read operation");
    };
    const reader = initLhc({
      tokenFamily: "o200k",
      inferenceCallbacks: {
        smoothPrompt: refuse,
        summarizeToolResult: refuse,
        compressDetailedTurn: refuse,
        summarizeChunkBrief: refuse,
      },
      mode: "manual",
    });
    const health = await expectReadOnly(fixture.filePath, () => reader.inspect.health({ filePath: fixture.filePath }));
    expect(health.ok).toBe(true);
    expect(captured).toHaveLength(0);
  });
});
