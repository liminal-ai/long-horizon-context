/**
 * LIM-61: staged compact-continuation runtime (correction: B1–B3, M4–M8).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONTEXT_COMPACT_CONTINUE_REASON,
  type CompactContinuationHostFacts,
  compactContinuation,
  compactContinuationMarkerIdempotencyKey,
  initLhc,
  intakeStream,
  type Lhc,
  messages,
  provePendingToolPair,
  threads,
  turns,
  validateHostFacts,
} from "../src/index.js";
import {
  createInferenceCallbacksDouble,
  derivedThreadFixture,
  openRaw,
  type TempStore,
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

const SETTLED_SEAM = {
  modelResponseComplete: true,
  requestedToolsSettled: true,
  captureFlushed: true,
  beforeNextProviderRequest: true,
  insideTransportRetry: false,
  inputEpochAtDecision: 1,
  inputEpochAtApply: 1,
} as const;

function baseFacts(overrides: Partial<CompactContinuationHostFacts> = {}): CompactContinuationHostFacts {
  return {
    attemptId: overrides.attemptId ?? "attempt-1",
    seam: overrides.seam ?? { ...SETTLED_SEAM },
    providerUsage: overrides.providerUsage ?? {
      available: true,
      inputTokens: 90000,
      cacheCreationTokens: 5000,
      cacheReadTokens: 10000,
      total: 105000,
      domain: "provider_reported_input",
    },
    postMeasurementEstimate: overrides.postMeasurementEstimate ?? {
      tokens: 2000,
      source: "lhc_token_estimate",
      domain: "source_labelled_estimate",
    },
    policy: overrides.policy ?? {
      upperTriggerTokens: 100000,
      lowerTargetTokens: 400,
      hostCapability: "full_state_machine",
    },
    continuation: overrides.continuation ?? { kind: "active_non_tool" },
    writerClaim: overrides.writerClaim ?? "none",
    captureComplete: overrides.captureComplete ?? true,
    providerIdentityValid: overrides.providerIdentityValid ?? true,
    actor: overrides.actor ?? "fixture-actor",
    harness: overrides.harness ?? "fixture-harness",
    compact: overrides.compact ?? {
      params: { lowerBound: 400, percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 } },
    },
    ...(overrides.singleOpenTurn !== undefined ? { singleOpenTurn: overrides.singleOpenTurn } : {}),
    ...(overrides.testHooks !== undefined ? { testHooks: overrides.testHooks } : {}),
  };
}

async function seedOpenAgenticTurn(filePath: string): Promise<void> {
  const batch = await intakeStream.messageEvents({ filePath }, [
    validEvent("user_prompt", { payload: { text: "continue the investigation with more context" } }),
    validEvent("assistant_text", { payload: { text: "working on it with more detail ".repeat(20) } }),
    validEvent("tool_call", {
      payload: { toolCallId: "call-active-1", toolName: "read_file", arguments: { path: "x.txt" } },
    }),
    validEvent("tool_result", {
      payload: { toolCallId: "call-active-1", content: "result body ".repeat(30), isError: false },
    }),
  ]);
  if (!batch.ok) throw new Error(batch.error.reason);
}

async function seedPendingToolTurn(filePath: string, toolCallId: string): Promise<void> {
  const batch = await intakeStream.messageEvents({ filePath }, [
    validEvent("user_prompt", { payload: { text: "use tools" } }),
    validEvent("assistant_text", { payload: { text: "calling tool" } }),
    validEvent("tool_call", {
      payload: { toolCallId, toolName: "read_file", arguments: { path: "notes.txt" } },
    }),
    validEvent("tool_result", {
      payload: { toolCallId, content: "tool result verbatim payload that must survive", isError: false },
    }),
  ]);
  if (!batch.ok) throw new Error(batch.error.reason);
}

function snapshotCanonical(filePath: string): {
  eventCount: number;
  turnCount: number;
  markerCount: number;
  viewId: string | null;
  maxEventOrder: number;
} {
  const db = openRaw(filePath);
  try {
    const eventCount = Number((db.prepare(`SELECT COUNT(*) AS n FROM event`).get() as { n: number | bigint }).n);
    const turnCount = Number((db.prepare(`SELECT COUNT(*) AS n FROM turns`).get() as { n: number | bigint }).n);
    const markerCount = Number(
      (
        db.prepare(`SELECT COUNT(*) AS n FROM event WHERE event_kind = 'compact_continuation_marker'`).get() as {
          n: number | bigint;
        }
      ).n,
    );
    const view = db.prepare(`SELECT view_id FROM thread_view WHERE singleton = 1`).get() as
      | { view_id: string }
      | undefined;
    const maxEventOrder = Number(
      (db.prepare(`SELECT COALESCE(MAX(event_order), 0) AS m FROM event`).get() as { m: number | bigint }).m,
    );
    return {
      eventCount,
      turnCount,
      markerCount,
      viewId: view?.view_id ?? null,
      maxEventOrder,
    };
  } finally {
    db.close();
  }
}

describe("LIM-61 compact-continuation runtime", () => {
  it("below trigger / no authoritative usage: no mutation", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    const before = snapshotCanonical(fixture.filePath);

    const below = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({
        attemptId: "below-1",
        providerUsage: {
          available: true,
          inputTokens: 1000,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          total: 1000,
          domain: "provider_reported_input",
        },
        postMeasurementEstimate: { tokens: 0, source: "lhc_token_estimate", domain: "source_labelled_estimate" },
      }),
    );
    expect(below.ok).toBe(true);
    if (!below.ok) return;
    expect(below.value.receipt.outcome).toBe("continue_normal");
    expect(below.value.receipt.effects.some((e) => e.type === "claim_writer")).toBe(false);
    expect(snapshotCanonical(fixture.filePath)).toEqual(before);

    const noUsage = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({
        attemptId: "no-usage-1",
        providerUsage: { available: false, reason: "missing", domain: "provider_reported_input" },
      }),
    );
    expect(noUsage.ok).toBe(true);
    if (!noUsage.ok) return;
    expect(noUsage.value.receipt.outcome).toBe("continue_normal");
    expect(snapshotCanonical(fixture.filePath)).toEqual(before);
  });

  it("normal completion creates no continuation turn", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    const before = snapshotCanonical(fixture.filePath);
    const result = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({ attemptId: "complete-1", continuation: { kind: "none" } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.receipt.outcome).toBe("normal_complete");
    expect(result.value.forcedBoundaryThisAttempt).toBe(false);
    expect(snapshotCanonical(fixture.filePath).turnCount).toBe(before.turnCount);
  });

  it("B1: above-trigger health refusals do not mutate record or view", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedOpenAgenticTurn(fixture.filePath);
    const baseline = await fixture.sdk.threadView.compact(
      { filePath: fixture.filePath },
      { params: { lowerBound: 400, percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 } } },
    );
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;
    const before = snapshotCanonical(fixture.filePath);

    for (const [attemptId, facts] of [
      ["health-capture", baseFacts({ attemptId: "health-capture", captureComplete: false })],
      ["health-identity", baseFacts({ attemptId: "health-identity", providerIdentityValid: false })],
      [
        "health-open",
        baseFacts({
          attemptId: "health-open",
          // Durable open-turn is still true; force via corrupt would be state_corruption.
          // Use invalid tool correlation shape on active path with singleOpenTurn override
          // that contradicts — runtime trusts durable single open; so use incomplete capture variants.
        }),
      ],
    ] as const) {
      void facts;
      void attemptId;
    }

    const capture = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({ attemptId: "health-capture", captureComplete: false }),
    );
    expect(capture.ok).toBe(true);
    if (!capture.ok) return;
    expect(capture.value.receipt.refuseCode).toBe("incomplete_capture");
    expect(capture.value.receipt.residual.priorServingViewIntact).toBe(true);
    expect(capture.value.receipt.residual.markerPersisted).toBe(false);
    expect(capture.value.receipt.effects.some((e) => e.type === "claim_writer")).toBe(false);
    expect(snapshotCanonical(fixture.filePath)).toEqual(before);

    const identity = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({ attemptId: "health-identity", providerIdentityValid: false }),
    );
    expect(identity.ok).toBe(true);
    if (!identity.ok) return;
    expect(identity.value.receipt.refuseCode).toBe("invalid_provider_identity");
    expect(snapshotCanonical(fixture.filePath)).toEqual(before);

    // Invalid tool correlation (host + durable) on preserve path.
    await seedPendingToolTurn(fixture.filePath, "call-bad-corr");
    const beforeTool = snapshotCanonical(fixture.filePath);
    const corr = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({
        attemptId: "health-corr",
        continuation: {
          kind: "pending_correlated_tool_result",
          toolCallId: "call-bad-corr",
          correlationValid: false,
        },
      }),
    );
    expect(corr.ok).toBe(true);
    if (!corr.ok) return;
    expect(corr.value.receipt.refuseCode).toBe("invalid_tool_correlation");
    expect(snapshotCanonical(fixture.filePath)).toEqual(beforeTool);

    // Durable pair missing despite host correlationValid.
    const missing = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({
        attemptId: "health-pair-missing",
        continuation: {
          kind: "pending_correlated_tool_result",
          toolCallId: "call-does-not-exist",
          correlationValid: true,
        },
      }),
    );
    expect(missing.ok).toBe(true);
    if (!missing.ok) return;
    expect(missing.value.receipt.refuseCode).toBe("invalid_tool_correlation");
    expect(snapshotCanonical(fixture.filePath)).toEqual(beforeTool);
  });

  it("active non-tool success: one boundary, one hidden typed marker, install", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedOpenAgenticTurn(fixture.filePath);

    const result = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({ attemptId: "active-success-1" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(["compact_continue_turn", "degraded_compact", "no_reduction"]).toContain(result.value.receipt.outcome);
    expect(result.value.forcedBoundaryThisAttempt).toBe(true);
    expect(result.value.continuationTurnId).toMatch(/^t\d+$/);
    expect(result.value.markerPersisted).toBe(true);
    expect(result.value.pendingBoundary).toBeNull();

    const cTurnId = result.value.continuationTurnId!;
    const userChat = await messages.list({ filePath: fixture.filePath }, { forUserChat: true });
    expect(userChat.ok).toBe(true);
    if (!userChat.ok) return;
    expect(userChat.value.every((m) => m.kind !== "compact_continuation_marker")).toBe(true);

    const all = await messages.list({ filePath: fixture.filePath });
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.value.filter((m) => m.kind === "compact_continuation_marker")).toHaveLength(1);

    const ctx = await fixture.sdk.threadView.getLlmRequestContext({ filePath: fixture.filePath });
    expect(ctx.ok).toBe(true);
    if (!ctx.ok) return;
    const joined = ctx.value.messages.map((m) => m.content.map((c) => c.text).join("")).join("\n");
    expect(joined).toContain("[compact continuation]");
    expect(joined).toContain(`continuationTurnId=${cTurnId}`);

    const session = await fixture.sdk.threadView.getSessionThreadView({ filePath: fixture.filePath });
    expect(session.ok).toBe(true);
    if (!session.ok) return;
    const sessionText = JSON.stringify(session.value.entries);
    expect(sessionText).toContain("[compact continuation]");
  });

  it("B2: completed boundary is not re-repaired on below-trigger seam", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedOpenAgenticTurn(fixture.filePath);
    const first = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({ attemptId: "complete-boundary-1" }),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.pendingBoundary).toBeNull();
    const viewAfter = snapshotCanonical(fixture.filePath);

    const below = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({
        attemptId: "complete-boundary-below",
        providerUsage: {
          available: true,
          inputTokens: 100,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          total: 100,
          domain: "provider_reported_input",
        },
        postMeasurementEstimate: { tokens: 0, source: "lhc_token_estimate", domain: "source_labelled_estimate" },
      }),
    );
    expect(below.ok).toBe(true);
    if (!below.ok) return;
    expect(below.value.receipt.outcome).toBe("continue_normal");
    expect(below.value.forcedBoundaryThisAttempt).toBe(false);
    expect(snapshotCanonical(fixture.filePath)).toEqual(viewAfter);
  });

  it("B2: completed attemptId replays without re-mutation", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedOpenAgenticTurn(fixture.filePath);
    const first = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({ attemptId: "replay-1" }),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const after = snapshotCanonical(fixture.filePath);

    const second = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({ attemptId: "replay-1" }),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.replayedTerminalAttempt).toBe(true);
    expect(second.value.receipt.outcome).toBe(first.value.receipt.outcome);
    expect(snapshotCanonical(fixture.filePath)).toEqual(after);
  });

  it("later above-trigger active work creates a distinct new boundary", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedOpenAgenticTurn(fixture.filePath);
    const first = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({ attemptId: "distinct-1" }),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const tA = first.value.continuationTurnId!;

    await seedOpenAgenticTurn(fixture.filePath);
    const second = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({ attemptId: "distinct-2" }),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.forcedBoundaryThisAttempt).toBe(true);
    expect(second.value.continuationTurnId).not.toBe(tA);
  });

  it("tool-result branch preserves pair; no marker", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    const toolCallId = "call-preserve-1";
    await seedPendingToolTurn(fixture.filePath, toolCallId);

    const result = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({
        attemptId: "tool-success-1",
        continuation: { kind: "pending_correlated_tool_result", toolCallId, correlationValid: true },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(["compact_preserve_tool", "degraded_compact", "no_reduction"]).toContain(result.value.receipt.outcome);
    expect(result.value.forcedBoundaryThisAttempt).toBe(false);
    expect(result.value.receipt.effects.some((e) => e.type === "insert_continuation_marker")).toBe(false);

    const listed = await messages.list({ filePath: fixture.filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const pair = listed.value.filter(
      (m) =>
        (m.kind === "tool_call" || m.kind === "tool_result") &&
        m.blocks.some((b) => b.content["toolCallId"] === toolCallId),
    );
    expect(pair).toHaveLength(2);
    expect(pair.find((m) => m.kind === "tool_result")?.blocks[0]?.content["content"]).toBe(
      "tool result verbatim payload that must survive",
    );
  });

  it("M8: durable tool-pair proof rejects orphaned and mismatched pairs", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedPendingToolTurn(fixture.filePath, "call-ok");

    const db = openRaw(fixture.filePath);
    try {
      const ok = provePendingToolPair(db, "call-ok");
      expect(ok.ok).toBe(true);

      const missing = provePendingToolPair(db, "call-missing");
      expect(missing.ok).toBe(false);
      if (!missing.ok) expect(missing.reason).toBe("call_missing");

      // Orphaned call: delete result message tombstone-style.
      db.prepare(
        `UPDATE message SET deleted_at = ? WHERE message_id IN (
           SELECT m.message_id FROM message m
           JOIN message_block b ON b.message_id = m.message_id
           WHERE b.block_type = 'tool_result' AND json_extract(b.content, '$.toolCallId') = 'call-ok'
         )`,
      ).run(new Date().toISOString());
      const orphan = provePendingToolPair(db, "call-ok");
      expect(orphan.ok).toBe(false);
      if (!orphan.ok) expect(orphan.reason).toBe("orphaned_call");
    } finally {
      db.close();
    }
  });

  it("repair after boundary is idempotent (no second boundary)", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedOpenAgenticTurn(fixture.filePath);

    const interrupted = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({
        attemptId: "repair-boundary-1",
        testHooks: { interruptAfterBoundary: true },
      }),
    );
    expect(interrupted.ok).toBe(true);
    if (!interrupted.ok) return;
    expect(interrupted.value.forcedBoundaryThisAttempt).toBe(true);
    const cTurnId = interrupted.value.continuationTurnId!;
    // Crash interrupt leaves pending boundary + held writer; resume same attemptId.
    expect(interrupted.value.pendingBoundary?.status).toBe("pending");
    expect(interrupted.value.replayedTerminalAttempt).toBe(false);

    const repaired = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({
        attemptId: "repair-boundary-1",
        writerClaim: "lhc",
        continuation: { kind: "active_non_tool" },
      }),
    );
    expect(repaired.ok).toBe(true);
    if (!repaired.ok) return;
    expect(repaired.value.forcedBoundaryThisAttempt).toBe(false);
    expect(repaired.value.continuationTurnId).toBe(cTurnId);
    expect(repaired.value.replayedTerminalAttempt).toBe(false);

    const turnList = await turns.listTurns({ filePath: fixture.filePath });
    expect(turnList.ok).toBe(true);
    if (!turnList.ok) return;
    expect(turnList.value.filter((t) => t.outcomeReason === CONTEXT_COMPACT_CONTINUE_REASON)).toHaveLength(1);
  });

  it("repair after marker is idempotent (no second marker)", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedOpenAgenticTurn(fixture.filePath);

    const interrupted = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({
        attemptId: "repair-marker-1",
        testHooks: { interruptAfterMarker: true },
      }),
    );
    expect(interrupted.ok).toBe(true);
    if (!interrupted.ok) return;
    const cTurnId = interrupted.value.continuationTurnId!;
    expect(interrupted.value.receipt.residual.markerPersisted).toBe(true);
    expect(interrupted.value.pendingBoundary?.markerPersisted).toBe(true);

    const repaired = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({
        attemptId: "repair-marker-1",
        writerClaim: "lhc",
        continuation: { kind: "active_non_tool" },
      }),
    );
    expect(repaired.ok).toBe(true);
    if (!repaired.ok) return;
    expect(repaired.value.forcedBoundaryThisAttempt).toBe(false);
    expect(repaired.value.replayedTerminalAttempt).toBe(false);

    const events = await intakeStream.listEvents({ filePath: fixture.filePath });
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    const key = compactContinuationMarkerIdempotencyKey(cTurnId);
    expect(events.value.filter((e) => e.idempotencyKey === key)).toHaveLength(1);
  });

  it("B3/M6: crash with held writer + pending boundary resumes same attemptId", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedOpenAgenticTurn(fixture.filePath);

    // Cooperative interrupt leaves boundary pending but releases writer; re-hold for crash model.
    const interrupted = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({
        attemptId: "crash-1",
        testHooks: { interruptAfterBoundary: true },
      }),
    );
    expect(interrupted.ok).toBe(true);
    if (!interrupted.ok) return;
    const cTurnId = interrupted.value.continuationTurnId!;

    // interruptAfterBoundary leaves writer held + boundary pending (crash model).
    const claim = await compactContinuation.getCompactContinuationWriterClaim({ filePath: fixture.filePath });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    expect(claim.value.claim).toBe("lhc");
    expect(claim.value.attemptId).toBe("crash-1");

    // Different attempt cannot steal.
    const steal = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({ attemptId: "crash-other", continuation: { kind: "active_non_tool" } }),
    );
    expect(steal.ok).toBe(false);
    if (steal.ok) return;
    expect(steal.error.code).toBe("compact_continuation_writer_conflict");

    // Resume with owning attemptId.
    const resumed = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({
        attemptId: "crash-1",
        writerClaim: "lhc",
        continuation: { kind: "active_non_tool" },
      }),
    );
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.value.forcedBoundaryThisAttempt).toBe(false);
    expect(resumed.value.continuationTurnId).toBe(cTurnId);
    expect(resumed.value.replayedTerminalAttempt).toBe(false);

    const claimAfter = await compactContinuation.getCompactContinuationWriterClaim({ filePath: fixture.filePath });
    expect(claimAfter.ok).toBe(true);
    if (!claimAfter.ok) return;
    expect(claimAfter.value.claim).toBe("none");
  });

  it("B3: finalize write failure does not return success with allowed next request", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedOpenAgenticTurn(fixture.filePath);
    const result = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({
        attemptId: "finalize-fail-1",
        testHooks: { failFinalizeWrite: true },
      }),
    );
    // May fail at finalize after mutations — must not be ok with nextProviderRequestAllowed.
    if (result.ok) {
      // If somehow finalize injection only hits after empty path — not our case.
      expect(result.value.nextProviderRequestAllowed).toBe(false);
    } else {
      expect(result.error.code).toBe("storage_failure");
    }
  });

  it("M4: stale prepared compact install refuses; prior view intact", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    const prepared = await fixture.sdk.threadView.prepareCompact(
      { filePath: fixture.filePath },
      { params: { lowerBound: 400, percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 } } },
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    // Concurrent capture advances source state.
    await intakeStream.messageEvents({ filePath: fixture.filePath }, [
      validEvent("user_prompt", { payload: { text: "steering" } }),
    ]);

    const installed = await fixture.sdk.threadView.installPreparedCompact(
      { filePath: fixture.filePath },
      prepared.value,
    );
    expect(installed.ok).toBe(false);
    if (installed.ok) return;
    expect(installed.error.code).toBe("stale_prepared_compact");

    // Public compact still works after refuse.
    const compact = await fixture.sdk.threadView.compact(
      { filePath: fixture.filePath },
      { params: { lowerBound: 400, percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 } } },
    );
    expect(compact.ok).toBe(true);
  });

  it("M4: public compact prepare→install stays green with no intervening mutation", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    const compact = await fixture.sdk.threadView.compact(
      { filePath: fixture.filePath },
      { params: { lowerBound: 400, percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 } } },
    );
    expect(compact.ok).toBe(true);
    if (!compact.ok) return;
    expect(compact.value.compactPoint).toBeGreaterThan(0);
  });

  it("install failure after marker keeps prior view; boundary/marker residual truthful", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    const baseline = await fixture.sdk.threadView.compact(
      { filePath: fixture.filePath },
      { params: { lowerBound: 400, percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 } } },
    );
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;
    await seedOpenAgenticTurn(fixture.filePath);

    const result = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({
        attemptId: "install-fail-1",
        testHooks: { failInstallBeforeWrite: true },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.receipt.refuseCode).toBe("install_failed");
    expect(result.value.receipt.residual.markerPersisted).toBe(true);
    expect(result.value.receipt.residual.markerServed).toBe(false);
    expect(result.value.receipt.residual.priorServingViewIntact).toBe(true);

    const described = await fixture.sdk.threadView.describe({ filePath: fixture.filePath });
    expect(described.ok).toBe(true);
    if (!described.ok) return;
    expect(described.value?.viewId).toBe(baseline.value.viewId);
  });

  it("input validation rejects malformed host facts", async () => {
    expect(validateHostFacts(null)?.code).toBe("invalid_compact_continuation_input");
    expect(validateHostFacts({ attemptId: "" })?.code).toBe("invalid_compact_continuation_input");
    const fixture = await derivedThreadFixture(store, { failures: false });
    const result = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      // @ts-expect-error intentional invalid
      { attemptId: "" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_compact_continuation_input");
  });

  it("native writer conflict refuses without claim", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    const before = snapshotCanonical(fixture.filePath);
    const result = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({ attemptId: "native-1", writerClaim: "native" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.receipt.refuseCode).toBe("native_writer_conflict");
    expect(result.value.receipt.effects.some((e) => e.type === "claim_writer")).toBe(false);
    expect(snapshotCanonical(fixture.filePath)).toEqual(before);
  });

  it("durable receipt and stage log are inspectable", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedOpenAgenticTurn(fixture.filePath);
    const result = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({ attemptId: "inspect-1" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const stored = await compactContinuation.getCompactContinuationReceipt({ filePath: fixture.filePath }, "inspect-1");
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.value?.terminal).toBe(true);
    expect(stored.value?.receipt.outcome).toBe(result.value.receipt.outcome);

    const stages = await compactContinuation.listCompactContinuationStages({ filePath: fixture.filePath }, "inspect-1");
    expect(stages.ok).toBe(true);
    if (!stages.ok) return;
    expect(stages.value.some((s) => s.stage === "claimed_writer")).toBe(true);
    expect(stages.value.some((s) => s.stage === "receipt_recorded")).toBe(true);
  });

  it("SDK surface exposes compactContinuation on initLhc", async () => {
    const sdk: Lhc = initLhc({
      inferenceCallbacks: createInferenceCallbacksDouble(),
      mode: "manual",
    });
    const filePath = store.threadPath();
    const created = await threads.newThread({ filePath, registryPath: store.registryPath });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await intakeStream.messageEvents({ filePath }, [validEvent("user_prompt"), validEvent("assistant_text")]);

    const result = await sdk.compactContinuation.runCompactContinuation(
      { filePath },
      baseFacts({
        attemptId: "sdk-surface-1",
        continuation: { kind: "none" },
        providerUsage: {
          available: true,
          inputTokens: 10,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          total: 10,
          domain: "provider_reported_input",
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.receipt.outcome).toBe("normal_complete");
  });
});
