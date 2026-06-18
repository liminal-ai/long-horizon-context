// Story 2 (Epic 04), default suite: TC-4.1–4.3 — the inspect health report.
// Counts by owner/kind/state assembled entirely from the owners' report
// surfaces (AC-4.1), actionable failure detail (AC-4.2), a repair preview
// that is reported and never executed (AC-4.3), rebuild visibility bracketing
// a drain (AC-4.4), and live queue visibility consistent with the state
// counts in the same report (AC-4.5).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HealthReport, initLhc, intakeStream, threads } from "../src/index.js";
import {
  createInferenceCallbacksDouble,
  expectReadOnly,
  mixedStateVariantThread,
  mutationInFlightVariant,
  PERMANENT_FAILURE_REASON,
  type TempStore,
  TRANSIENT_EXHAUST_REASON,
  tempStore,
  validEvent,
} from "./fixtures/index.js";

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

const ZERO = { ready: 0, pending: 0, retrying: 0, failed: 0, blocked: 0 };

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

    // Every owner/kind/state count, exact, in deterministic order: 13 turns'
    // smoothings ready + t14's pending; the tool-heavy middle's summaries
    // with the two scripted failures; t13's turn forms blocked on the real
    // source damage; the three closed chunks' summaries ready.
    expect(report.owners).toEqual([
      { owner: "messages", kind: "smoothed_prompt", counts: { ...ZERO, ready: 13, pending: 1 } },
      { owner: "messages", kind: "tool_result_summary", counts: { ...ZERO, ready: 6, failed: 2 } },
      { owner: "turns", kind: "chunk_summary_brief", counts: { ...ZERO, ready: 3 } },
      { owner: "turns", kind: "chunk_summary_detailed", counts: { ...ZERO, ready: 3 } },
      { owner: "turns", kind: "smooth_turn_compression", counts: { ...ZERO, ready: 12, blocked: 1 } },
      { owner: "turns", kind: "turn_rendering", counts: { ...ZERO, ready: 12, blocked: 1 } },
    ]);

    // Queue visibility from the same report's live joins: exactly the one
    // still-queued smoothing item, consistent with the pending count.
    expect(report.queue).toEqual({ queued: 1, claimed: 0 });
    const pendingTotal = report.owners.reduce((sum, row) => sum + row.counts.pending + row.counts.retrying, 0);
    expect(report.queue.queued + report.queue.claimed).toBe(pendingTotal);
  });
});

describe("TC-4.2 / AC-4.2, AC-4.3: failure detail and repair preview", () => {
  it("failed entries carry exact detail; the preview is exactly the failed-not-blocked set", async () => {
    const fixture = await mixedStateVariantThread(store);
    const { filePath, sdk } = fixture;
    const report = healthValue(await sdk.inspect.health({ filePath }));

    // Actionable failure detail: subject, form, reason, attempts, last error
    // — enough to target a requeue without raw SQL.
    const failed = report.failures.filter(
      (entry) => entry.reason.startsWith("rate_limit") || entry.reason.startsWith("content_refusal"),
    );
    expect(failed).toEqual([
      {
        owner: "messages",
        subjectKind: "message",
        subjectId: fixture.failedTransientMessageId,
        derivationType: "tool_result_summary",
        reason: TRANSIENT_EXHAUST_REASON,
        attempts: 3,
        lastError: TRANSIENT_EXHAUST_REASON,
      },
      {
        owner: "messages",
        subjectKind: "message",
        subjectId: fixture.failedPermanentMessageId,
        derivationType: "tool_result_summary",
        reason: PERMANENT_FAILURE_REASON,
        attempts: 1,
        lastError: PERMANENT_FAILURE_REASON,
      },
    ]);

    // Blocked forms surface as failures too — with the damage named — but
    // never as repair targets.
    const blocked = report.failures.filter((entry) => !failed.includes(entry));
    expect(blocked.map((entry) => [entry.owner, entry.subjectKind, entry.subjectId, entry.derivationType])).toEqual([
      ["turns", "turn", fixture.blockedTurnId, "smooth_turn_compression"],
      ["turns", "turn", fixture.blockedTurnId, "turn_rendering"],
    ]);
    for (const entry of blocked) {
      expect(entry.reason.length).toBeGreaterThan(0);
    }

    // The preview lists exactly the failed-and-not-blocked set, in report
    // order — and previews only: the read changed nothing (the delta assert
    // in TC-4.1 covers the same operation).
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

    // Never executed: the failed forms are still failed on a second read —
    // health did not requeue what it previewed.
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
    const recorded = await intakeStream.messageEvents({ filePath }, [gap]);
    expect(recorded.ok).toBe(true);

    const reader = initLhc({ inferenceCallbacks: createInferenceCallbacksDouble(), mode: "manual" });
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
      attempts: 0,
    });
    expect(report.repairPreview).toEqual([]);
  });
});

describe("TC-4.3 / AC-4.4: rebuild visibility brackets a drain", () => {
  it("after an edit the cascade's cleared set is pending with queued work; after the drain the same set is ready; nothing else moved", async () => {
    const fixture = await mutationInFlightVariant(store);
    const { filePath, sdk } = fixture;

    // The cascade contract's exact cleared set: the prompt's own smoothing,
    // t2's two turn forms, c1's two chunk summaries.
    const clearedKeys = fixture.mutation.cleared
      .map((target) => `${target.subjectKind}:${target.subjectId}:${target.derivationType}`)
      .sort();
    expect(clearedKeys).toEqual(
      [
        `message:${fixture.editedMessageId}:smoothed_prompt`,
        "turn:t2:turn_rendering",
        "turn:t2:smooth_turn_compression",
        "chunk:c1:chunk_summary_detailed",
        "chunk:c1:chunk_summary_brief",
      ].sort(),
    );

    const before = healthValue(await expectReadOnly(filePath, () => sdk.inspect.health({ filePath })));
    // The cleared set reads pending — one per owner/kind — with its queued
    // replacement work visible, and every form outside the cascade still
    // ready (failures-free fixture: full counts minus the cascade).
    expect(before.owners).toEqual([
      { owner: "messages", kind: "smoothed_prompt", counts: { ...ZERO, ready: 11, pending: 1 } },
      { owner: "messages", kind: "tool_result_summary", counts: { ...ZERO, ready: 8 } },
      { owner: "turns", kind: "chunk_summary_brief", counts: { ...ZERO, ready: 2, pending: 1 } },
      { owner: "turns", kind: "chunk_summary_detailed", counts: { ...ZERO, ready: 2, pending: 1 } },
      { owner: "turns", kind: "smooth_turn_compression", counts: { ...ZERO, ready: 11, pending: 1 } },
      { owner: "turns", kind: "turn_rendering", counts: { ...ZERO, ready: 11, pending: 1 } },
    ]);
    // Queued work visible and consistent: 4 replacement items — smoothing,
    // turn derivation (two forms), two chunk summaries — join onto the 5
    // pending entries.
    expect(before.queue).toEqual({ queued: 5, claimed: 0 });
    expect(before.failures).toEqual([]);
    expect(before.repairPreview).toEqual([]);

    // The exact pending subjects per the cascade contract, read through the
    // owners' surfaces health composes.
    const messagesPending = await sdk.messages.report({ filePath }, { notReady: true });
    const turnsPending = await sdk.turns.report({ filePath }, { notReady: true });
    expect(messagesPending.ok && turnsPending.ok).toBe(true);
    if (!messagesPending.ok || !turnsPending.ok) return;
    const pendingKeys = [...messagesPending.value, ...turnsPending.value]
      .filter((entry) => entry.state === "pending")
      .map((entry) => `${entry.subjectKind}:${entry.subjectId}:${entry.derivationType}`)
      .sort();
    expect(pendingKeys).toEqual(clearedKeys);

    // Drain the queued rebuilds and wait the scheduler out.
    const drained = await sdk.work.drain({ filePath });
    expect(drained.ok).toBe(true);
    await sdk.drainSettled({ filePath });

    // The same set reads ready; counts return to the full fixture totals;
    // queue empty — two reads bracket the rebuild.
    const after = healthValue(await sdk.inspect.health({ filePath }));
    expect(after.owners).toEqual([
      { owner: "messages", kind: "smoothed_prompt", counts: { ...ZERO, ready: 12 } },
      { owner: "messages", kind: "tool_result_summary", counts: { ...ZERO, ready: 8 } },
      { owner: "turns", kind: "chunk_summary_brief", counts: { ...ZERO, ready: 3 } },
      { owner: "turns", kind: "chunk_summary_detailed", counts: { ...ZERO, ready: 3 } },
      { owner: "turns", kind: "smooth_turn_compression", counts: { ...ZERO, ready: 12 } },
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
      inferenceCallbacks: {
        smoothPrompt: refuse,
        summarizeToolResult: refuse,
        composeTurnRendering: refuse,
        compressSmoothTurn: refuse,
        summarizeChunkDetailed: refuse,
        summarizeChunkBrief: refuse,
      },
      mode: "manual",
    });
    const health = await expectReadOnly(fixture.filePath, () => reader.inspect.health({ filePath: fixture.filePath }));
    expect(health.ok).toBe(true);
    expect(captured).toHaveLength(0);
  });
});
