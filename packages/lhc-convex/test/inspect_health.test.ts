// Story 2 (Epic 04): TC-4.1-4.3 — the inspect health report. Counts by
// owner/kind/state assembled entirely from the owners' report surfaces
// (AC-4.1), actionable failure detail (AC-4.2), a repair preview that is
// reported and never executed (AC-4.3), rebuild visibility bracketing a drain
// (AC-4.4), and live queue visibility consistent with the state counts in the
// same report (AC-4.5).
//
// The frozen TC-2.8 capture-gap leg is NOT ported: the Convex inspect.health
// surfaces only the messages and turns owners — there is no capture-gap
// detection path that would emit an owner:"capture" row (see report/ledger).
// The frozen "throwing inference callback" structural proof is replaced by the
// shared host's captured-call log: inspect.health is a Convex query and cannot
// reach the model-call action at all.
import { describe, expect, test } from "vitest";
import type { HealthReport, Lhc, MessageEventInput } from "../src/client/index.js";
import { capturedCalls, resetCapturedCalls } from "./convex/model.js";
import { derivedThreadFixture, type ServiceFixture, validEvent } from "./fixtures/index.js";

const RATE_LIMIT_FAILURE_REASON = "rate_limit: scripted failure (fixture)";
const PERMANENT_FAILURE_REASON = "content_refusal: scripted permanent failure (fixture)";
const ZERO = { ready: 0, pending: 0, failed: 0, blocked: 0 };

function healthValue(result: { ok: boolean }): HealthReport {
  if (!result.ok) throw new Error(`expected ok health report: ${JSON.stringify(result)}`);
  return (result as { ok: true; value: HealthReport }).value;
}

async function send(sdk: Lhc, filePath: string, batch: readonly MessageEventInput[]): Promise<void> {
  const sent = await sdk.intakeStream.messageEvents({ filePath }, batch);
  if (!sent.ok) throw new Error(`fixture batch failed: ${sent.error.reason}`);
}

function plainTurn(turn: number): MessageEventInput[] {
  return [
    validEvent("user_prompt", { payload: { text: `turn ${turn}: please investigate area ${turn}` } }),
    validEvent("assistant_thinking", { payload: { text: `considering what area ${turn} contains` } }),
    validEvent("assistant_text", { payload: { text: `findings for area ${turn}` } }),
    validEvent("turn_end"),
  ];
}

interface MixedStateFixture extends ServiceFixture {
  filePath: string;
  threadId: string;
  blockedTurnId: string;
  failedTransientMessageId: string;
  failedPermanentMessageId: string;
}

// One thread carrying every operational state at once: ready (the drained
// body), failed-transient and failed-permanent (two tool_result_summary forms
// stamped failed, mirroring the frozen setMessageDerivationFailed), blocked
// (t13's turn derivations meeting real source damage — its turn row deleted
// below the SDK), and pending with live queued work (t14's smoothing left
// queued by a bounded drain).
async function mixedStateVariantThread(): Promise<MixedStateFixture> {
  const fixture = await derivedThreadFixture();
  const { filePath, threadId } = fixture;

  // Two tool_result_summary forms land failed through the sanctioned raw stamp,
  // one transient class, one permanent class — distinguishable on read-back.
  const subjects = await fixture.test.run(async (ctx) => {
    const rows = await ctx.db.query("derivations").collect();
    const summaries = rows.filter(
      (row) =>
        row.instance === fixture.instance &&
        row.thread === threadId &&
        row.scope === "message" &&
        row.deriv === "tool_result_summary",
    );
    const transient = summaries[2];
    const permanent = summaries[4];
    if (transient === undefined || permanent === undefined) throw new Error("fixture tool summaries missing");
    await ctx.db.patch("derivations", transient._id, {
      state: "failed",
      content: undefined,
      reason: RATE_LIMIT_FAILURE_REASON,
      metadata: undefined,
      derivedAt: "2026-01-01T00:00:00.000Z",
    });
    await ctx.db.patch("derivations", permanent._id, {
      state: "failed",
      content: undefined,
      reason: PERMANENT_FAILURE_REASON,
      metadata: undefined,
      derivedAt: "2026-01-01T00:00:00.000Z",
    });
    return { transient: transient.subject, permanent: permanent.subject };
  });

  // Turn 13 closes cleanly but is NOT drained: its prompt smoothing and turn
  // derivation sit queued.
  await send(fixture.sdk, filePath, plainTurn(13));
  // Turn 14 opens with a lone prompt: one more queued smoothing item the
  // bounded drain below leaves pending.
  await send(fixture.sdk, filePath, [
    validEvent("user_prompt", { payload: { text: "turn 14: this prompt's smoothing stays pending" } }),
  ]);

  // Real source damage: t13's turn row is deleted, so its claimed turn
  // derivation lands blocked through the terminal path.
  await fixture.test.run(async (ctx) => {
    const turns = await ctx.db.query("turns").collect();
    const turn = turns.find(
      (row) => row.instance === fixture.instance && row.thread === threadId && row.turn === "t13",
    );
    if (turn === undefined) throw new Error("turn t13 missing");
    await ctx.db.patch("turns", turn._id, { deletedAt: "2026-01-01T00:00:00.000Z" });
  });

  // Bounded, head-first FIFO: t13's prompt smoothing (ready), then t13's turn
  // derivation (terminal on the damage → blocked). t14's smoothing stays
  // queued — the live pending state.
  const report = await fixture.sdk.work.drain({ filePath }, { maxItems: 2 });
  if (!report.ok) throw new Error(`fixture drain failed: ${report.error.reason}`);
  if (report.value.blocked !== 1) {
    throw new Error(`fixture invariant: expected one blocked turn derivation, got ${report.value.blocked}`);
  }
  if (report.value.remaining !== 1) {
    throw new Error(`fixture invariant: expected exactly one queued item left, got ${report.value.remaining}`);
  }

  return {
    ...fixture,
    blockedTurnId: "t13",
    failedTransientMessageId: subjects.transient,
    failedPermanentMessageId: subjects.permanent,
  };
}

function bySubject<T extends { subjectId: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => a.subjectId.localeCompare(b.subjectId));
}

describe("TC-4.1 / AC-4.1, AC-4.5: counts per owner/kind/state and queue consistency", () => {
  test("the mixed-state fixture reports exact counts and a queue section consistent with them", async () => {
    const fixture = await mixedStateVariantThread();
    const { filePath, sdk } = fixture;

    resetCapturedCalls();
    const health = await sdk.inspect.health({ filePath });
    expect(capturedCalls).toHaveLength(0);
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

    // Queue visibility from the same report's live joins: exactly the one
    // still-queued smoothing item, consistent with the pending count.
    expect(report.queue).toEqual({ queued: 1, claimed: 0 });
    const pendingTotal = report.owners.reduce((sum, row) => sum + row.counts.pending, 0);
    expect(report.queue.queued + report.queue.claimed).toBe(pendingTotal);
  });
});

describe("TC-4.2 / AC-4.2, AC-4.3: failure detail and repair preview", () => {
  test("failed entries carry exact detail; the preview is exactly the failed-not-blocked set", async () => {
    const fixture = await mixedStateVariantThread();
    const { filePath, sdk } = fixture;
    const report = healthValue(await sdk.inspect.health({ filePath }));

    // Actionable failure detail is enough to target a re-derive.
    const failed = report.failures.filter(
      (entry) => entry.reason.startsWith("rate_limit") || entry.reason.startsWith("content_refusal"),
    );
    expect(bySubject(failed)).toEqual(
      bySubject([
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
      ]),
    );

    // Blocked forms surface as failures too — with the damage named — but never
    // as repair targets.
    const blocked = report.failures.filter((entry) => !failed.includes(entry));
    expect(blocked.map((entry) => [entry.owner, entry.subjectKind, entry.subjectId, entry.derivationType])).toEqual([
      ["turns", "turn", fixture.blockedTurnId, "pre_detailed_assembly"],
      ["turns", "turn", fixture.blockedTurnId, "turn_rendering"],
    ]);
    for (const entry of blocked) {
      expect(entry.reason.length).toBeGreaterThan(0);
    }

    // The preview lists exactly the failed-and-not-blocked set.
    expect(bySubject(report.repairPreview)).toEqual(
      bySubject([
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
      ]),
    );

    // Never executed: the failed forms are still failed on a second read —
    // health did not requeue what it previewed.
    const again = healthValue(await sdk.inspect.health({ filePath }));
    expect(again).toEqual(report);
  });
});

describe("TC-4.3 / AC-4.4: rebuild visibility brackets a drain", () => {
  test("after an edit the cascade's cleared set is pending with queued work; after the drain the same set is ready; nothing else moved", async () => {
    const fixture = await derivedThreadFixture();
    const { filePath, sdk } = fixture;

    const compacted = await sdk.threadView.compact({ filePath }, {});
    if (!compacted.ok) throw new Error(compacted.error.reason);
    const listed = await sdk.messages.list({ filePath });
    if (!listed.ok) throw new Error(listed.error.reason);
    const target = listed.value.find((record) => record.kind === "user_prompt" && record.turnId === "t2");
    if (target === undefined) throw new Error("fixture invariant: turn 2 carries no prompt message");
    const edited = await sdk.messages.edit({ filePath }, { messageId: target.messageId, content: "turn 2 revised" });
    if (!edited.ok) throw new Error(edited.error.reason);

    // The cascade contract's exact cleared set: the prompt's own smoothing,
    // t2's two turn forms plus its compression, c1's two chunk summaries.
    const clearedKeys = edited.value.cleared
      .map((target) => `${target["subjectKind"]}:${target["subjectId"]}:${target["derivationType"]}`)
      .sort();
    expect(clearedKeys).toEqual(
      [
        `message:${target.messageId}:smoothed_prompt`,
        "turn:t2:turn_rendering",
        "turn:t2:pre_detailed_assembly",
        "turn:t2:detailed_turn_compression",
        "chunk:c1:chunk_summary_detailed",
        "chunk:c1:chunk_summary_brief",
      ].sort(),
    );

    const before = healthValue(await sdk.inspect.health({ filePath }));
    // The cleared set reads pending — one per owner/kind — with its queued
    // replacement work visible, and every form outside the cascade still ready.
    expect(before.owners).toEqual([
      { owner: "messages", kind: "smoothed_prompt", counts: { ...ZERO, ready: 11, pending: 1 } },
      { owner: "messages", kind: "tool_result_summary", counts: { ...ZERO, ready: 8 } },
      { owner: "turns", kind: "chunk_summary_brief", counts: { ...ZERO, ready: 2, pending: 1 } },
      { owner: "turns", kind: "chunk_summary_detailed", counts: { ...ZERO, ready: 2, pending: 1 } },
      { owner: "turns", kind: "detailed_turn_compression", counts: { ...ZERO, ready: 11, pending: 1 } },
      { owner: "turns", kind: "pre_detailed_assembly", counts: { ...ZERO, ready: 11, pending: 1 } },
      { owner: "turns", kind: "turn_rendering", counts: { ...ZERO, ready: 11, pending: 1 } },
    ]);
    // Queued replacement work visible and consistent: one item per rebuild
    // group, joining onto the 6 pending entries.
    expect(before.queue).toEqual({ queued: edited.value.queued.length, claimed: 0 });
    expect(before.failures).toEqual([]);
    expect(before.repairPreview).toEqual([]);

    // The exact pending subjects per the cascade contract, read through the
    // owners' surfaces health composes. The turns owner spans both the turn and
    // chunk derivation scopes; the client reports each scope separately, so the
    // chunk forms are gathered through the per-chunk report.
    const messagesPending = await sdk.messages.report({ filePath }, { notReady: true });
    const turnsPending = await sdk.turns.report({ filePath }, { notReady: true });
    const chunks = await sdk.turns.listChunks({ filePath });
    expect(messagesPending.ok && turnsPending.ok && chunks.ok).toBe(true);
    if (!messagesPending.ok || !turnsPending.ok || !chunks.ok) return;
    const chunkPending = [];
    for (const chunk of chunks.value) {
      const report = await sdk.turns.report({ filePath }, { chunkId: chunk.chunkId, notReady: true });
      if (!report.ok) throw new Error(report.error.reason);
      chunkPending.push(...report.value);
    }
    const pendingKeys = [...messagesPending.value, ...turnsPending.value, ...chunkPending]
      .filter((entry) => entry.state === "pending")
      .map((entry) => `${entry.subjectKind}:${entry.subjectId}:${entry.derivationType}`)
      .sort();
    expect(pendingKeys).toEqual(clearedKeys);

    // Drain the queued rebuilds.
    const drained = await sdk.work.drain({ filePath });
    expect(drained.ok).toBe(true);

    // The same set reads ready; counts return to the full fixture totals; queue
    // empty — two reads bracket the rebuild.
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
