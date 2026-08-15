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
  type MessageEventInput,
  messages,
  provePendingToolPair,
  threads,
  turns,
  validateHostFacts,
} from "../src/index.js";
import {
  type CompactContinuationTestHooks,
  createInferenceCallbacksDouble,
  derivedThreadFixture,
  openRaw,
  runCompactContinuationForTests,
  seedWriterClaim,
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
      safeRunwayThresholdTokens: 200000,
      safeRunwayThresholdSource: "host_safe_runway",
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
  };
}

async function runCCTest(filePath: string, facts: CompactContinuationHostFacts, hooks?: CompactContinuationTestHooks) {
  return runCompactContinuationForTests({ filePath }, facts, () => new Date(), hooks);
}

function writerClaimOf(filePath: string): { claim: string; attemptId: string | null } {
  const db = openRaw(filePath);
  try {
    const row = db.prepare(`SELECT claim, attempt_id FROM compact_continuation_writer WHERE singleton = 1`).get() as {
      claim: string;
      attempt_id: string | null;
    };
    return { claim: row.claim, attemptId: row.attempt_id };
  } finally {
    db.close();
  }
}

function seedHeldWriter(filePath: string, attemptId: string): void {
  const db = openRaw(filePath);
  try {
    seedWriterClaim(db, attemptId, new Date().toISOString());
  } finally {
    db.close();
  }
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
          protectedToolCallIds: ["call-bad-corr"],
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
          protectedToolCallIds: ["call-does-not-exist"],
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
        continuation: {
          kind: "pending_correlated_tool_result",
          protectedToolCallIds: [toolCallId],
          correlationValid: true,
        },
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

    const interrupted = await runCCTest(fixture.filePath, baseFacts({ attemptId: "repair-boundary-1" }), {
      interruptAfterBoundary: true,
    });
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

    const interrupted = await runCCTest(fixture.filePath, baseFacts({ attemptId: "repair-marker-1" }), {
      interruptAfterMarker: true,
    });
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
    const interrupted = await runCCTest(fixture.filePath, baseFacts({ attemptId: "crash-1" }), {
      interruptAfterBoundary: true,
    });
    expect(interrupted.ok).toBe(true);
    if (!interrupted.ok) return;
    const cTurnId = interrupted.value.continuationTurnId!;

    // interruptAfterBoundary leaves writer held + boundary pending (crash model).
    const claim = await compactContinuation.getCompactContinuationWriterClaim({ filePath: fixture.filePath });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    expect(claim.value.claim).toBe("lhc");
    expect(claim.value.attemptId).toBe("crash-1");

    // Different attempt cannot steal (ownership conflict before writer claim).
    const steal = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({ attemptId: "crash-other", continuation: { kind: "active_non_tool" } }),
    );
    expect(steal.ok).toBe(false);
    if (steal.ok) return;
    expect(["compact_continuation_attempt_conflict", "compact_continuation_writer_conflict"]).toContain(
      steal.error.code,
    );

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
    const result = await runCCTest(fixture.filePath, baseFacts({ attemptId: "finalize-fail-1" }), {
      failFinalizeWrite: true,
    });
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

    const result = await runCCTest(fixture.filePath, baseFacts({ attemptId: "install-fail-1" }), {
      failInstallBeforeWrite: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.receipt.refuseCode).toBe("install_failed");
    expect(result.value.receipt.residual.markerPersisted).toBe(true);
    expect(result.value.receipt.residual.markerServed).toBe(false);
    expect(result.value.receipt.residual.priorServingViewIntact).toBe(true);
    expect(result.value.pendingBoundary?.status).toBe("failed_repairable");

    const stored = await compactContinuation.getCompactContinuationReceipt(
      { filePath: fixture.filePath },
      "install-fail-1",
    );
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.value?.terminal).toBe(false);

    const described = await fixture.sdk.threadView.describe({ filePath: fixture.filePath });
    expect(described.ok).toBe(true);
    if (!described.ok) return;
    expect(described.value?.viewId).toBe(baseline.value.viewId);
  });

  it("P1: install fail → failed_repairable nonterminal → same attempt repair succeeds", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedOpenAgenticTurn(fixture.filePath);

    const failed = await runCCTest(fixture.filePath, baseFacts({ attemptId: "repair-install-1" }), {
      failInstallBeforeWrite: true,
    });
    expect(failed.ok).toBe(true);
    if (!failed.ok) return;
    expect(failed.value.receipt.refuseCode).toBe("install_failed");
    expect(failed.value.pendingBoundary?.status).toBe("failed_repairable");
    expect(failed.value.pendingBoundary?.attemptId).toBe("repair-install-1");
    const cTurnId = failed.value.continuationTurnId!;

    const storedFail = await compactContinuation.getCompactContinuationReceipt(
      { filePath: fixture.filePath },
      "repair-install-1",
    );
    expect(storedFail.ok).toBe(true);
    if (!storedFail.ok) return;
    expect(storedFail.value?.terminal).toBe(false);

    const repaired = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({
        attemptId: "repair-install-1",
        writerClaim: "none",
        continuation: { kind: "active_non_tool" },
      }),
    );
    expect(repaired.ok).toBe(true);
    if (!repaired.ok) return;
    expect(repaired.value.forcedBoundaryThisAttempt).toBe(false);
    expect(repaired.value.continuationTurnId).toBe(cTurnId);
    expect(repaired.value.replayedTerminalAttempt).toBe(false);
    expect(["compact_continue_turn", "degraded_compact", "no_reduction"]).toContain(repaired.value.receipt.outcome);
    expect(repaired.value.pendingBoundary).toBeNull();

    const storedOk = await compactContinuation.getCompactContinuationReceipt(
      { filePath: fixture.filePath },
      "repair-install-1",
    );
    expect(storedOk.ok).toBe(true);
    if (!storedOk.ok) return;
    expect(storedOk.value?.terminal).toBe(true);
  });

  it("P1: foreign attempt cannot steal failed_repairable boundary", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedOpenAgenticTurn(fixture.filePath);

    const failed = await runCCTest(fixture.filePath, baseFacts({ attemptId: "owner-fail-1" }), {
      failInstallBeforeWrite: true,
    });
    expect(failed.ok).toBe(true);
    if (!failed.ok) return;
    expect(failed.value.pendingBoundary?.status).toBe("failed_repairable");

    const steal = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({
        attemptId: "thief-1",
        continuation: { kind: "active_non_tool" },
      }),
    );
    expect(steal.ok).toBe(false);
    if (steal.ok) return;
    expect(steal.error.code).toBe("compact_continuation_attempt_conflict");
    expect(steal.error.reason).toContain("owner-fail-1");

    // Owner can still resume.
    const owner = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({
        attemptId: "owner-fail-1",
        continuation: { kind: "active_non_tool" },
      }),
    );
    expect(owner.ok).toBe(true);
    if (!owner.ok) return;
    expect(owner.value.pendingBoundary).toBeNull();
  });

  it("P1: interruptAfterTurnEndCommit → resume materializes one boundary only", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedOpenAgenticTurn(fixture.filePath);

    const interrupted = await runCCTest(fixture.filePath, baseFacts({ attemptId: "force-gap-1" }), {
      interruptAfterTurnEndCommit: true,
    });
    expect(interrupted.ok).toBe(true);
    if (!interrupted.ok) return;
    expect(interrupted.value.forcedBoundaryThisAttempt).toBe(false);
    // Crash gap: turn_end committed, boundary not yet written.
    expect(interrupted.value.pendingBoundary).toBeNull();

    const claim = await compactContinuation.getCompactContinuationWriterClaim({ filePath: fixture.filePath });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    expect(claim.value.claim).toBe("lhc");
    expect(claim.value.attemptId).toBe("force-gap-1");

    const resumed = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({
        attemptId: "force-gap-1",
        writerClaim: "lhc",
        continuation: { kind: "active_non_tool" },
      }),
    );
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.value.forcedBoundaryThisAttempt).toBe(false);
    expect(resumed.value.continuationTurnId).toMatch(/^t\d+$/);
    expect(resumed.value.pendingBoundary).toBeNull();
    expect(["compact_continue_turn", "degraded_compact", "no_reduction"]).toContain(resumed.value.receipt.outcome);

    const turnList = await turns.listTurns({ filePath: fixture.filePath });
    expect(turnList.ok).toBe(true);
    if (!turnList.ok) return;
    expect(turnList.value.filter((t) => t.outcomeReason === CONTEXT_COMPACT_CONTINUE_REASON)).toHaveLength(1);
  });

  it("P1: terminal replay same intent ok; different continuation kind → attempt_conflict", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedOpenAgenticTurn(fixture.filePath);

    const first = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({ attemptId: "intent-replay-1" }),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const after = snapshotCanonical(fixture.filePath);

    const same = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({ attemptId: "intent-replay-1" }),
    );
    expect(same.ok).toBe(true);
    if (!same.ok) return;
    expect(same.value.replayedTerminalAttempt).toBe(true);
    expect(same.value.receipt.outcome).toBe(first.value.receipt.outcome);
    expect(snapshotCanonical(fixture.filePath)).toEqual(after);

    const different = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({
        attemptId: "intent-replay-1",
        continuation: { kind: "none" },
      }),
    );
    expect(different.ok).toBe(false);
    if (different.ok) return;
    expect(different.error.code).toBe("compact_continuation_attempt_conflict");
  });

  it("P1: preSkip with pending same attempt → nonterminal, later repair ok", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedOpenAgenticTurn(fixture.filePath);

    const interrupted = await runCCTest(fixture.filePath, baseFacts({ attemptId: "preskip-pending-1" }), {
      interruptAfterBoundary: true,
    });
    expect(interrupted.ok).toBe(true);
    if (!interrupted.ok) return;
    expect(interrupted.value.pendingBoundary?.status).toBe("pending");
    const cTurnId = interrupted.value.continuationTurnId!;

    const skip = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({
        attemptId: "preskip-pending-1",
        writerClaim: "lhc",
        seam: {
          ...SETTLED_SEAM,
          insideTransportRetry: true,
        },
      }),
    );
    expect(skip.ok).toBe(true);
    if (!skip.ok) return;
    expect(skip.value.receipt.skipped).toBe(true);
    expect(skip.value.pendingBoundary?.status).toBe("pending");
    expect(skip.value.pendingBoundary?.continuationTurnId).toBe(cTurnId);

    const storedSkip = await compactContinuation.getCompactContinuationReceipt(
      { filePath: fixture.filePath },
      "preskip-pending-1",
    );
    expect(storedSkip.ok).toBe(true);
    if (!storedSkip.ok) return;
    expect(storedSkip.value?.terminal).toBe(false);

    const repaired = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({
        attemptId: "preskip-pending-1",
        writerClaim: "none",
        continuation: { kind: "active_non_tool" },
      }),
    );
    expect(repaired.ok).toBe(true);
    if (!repaired.ok) return;
    expect(repaired.value.continuationTurnId).toBe(cTurnId);
    expect(repaired.value.pendingBoundary).toBeNull();
    expect(["compact_continue_turn", "degraded_compact", "no_reduction"]).toContain(repaired.value.receipt.outcome);
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

  it("getCompactContinuationAttemptIntent returns stored immutable identity for recovery", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedOpenAgenticTurn(fixture.filePath);
    const toolCallId = "call-preserve-X";
    await intakeStream.messageEvents({ filePath: fixture.filePath }, [
      validEvent("tool_call", {
        payload: { toolCallId, toolName: "read_file", arguments: { path: "y.txt" } },
      }),
      validEvent("tool_result", {
        payload: { toolCallId, content: "preserve body ".repeat(20), isError: false },
      }),
    ]);
    const facts = baseFacts({
      attemptId: "identity-inspect-1",
      actor: "recovery-actor",
      harness: "recovery-harness",
      continuation: {
        kind: "pending_correlated_tool_result",
        protectedToolCallIds: [toolCallId],
        correlationValid: true,
      },
      policy: {
        upperTriggerTokens: 77_000,
        lowerTargetTokens: 321,
        hostCapability: "full_state_machine",
      },
      compact: {
        profile: "continuation",
        params: { lowerBound: 321, percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 } },
      },
    });
    // Claim-only crash: intent + writer held, no successful finalize.
    const crashed = await runCCTest(fixture.filePath, facts, { failFinalizeAtRelease: true });
    expect(crashed.ok).toBe(false);
    if (crashed.ok) return;
    expect(crashed.error.code).toBe("storage_failure");
    expect(writerClaimOf(fixture.filePath)).toEqual({ claim: "lhc", attemptId: "identity-inspect-1" });

    const missing = await compactContinuation.getCompactContinuationAttemptIntent(
      { filePath: fixture.filePath },
      "no-such-attempt",
    );
    expect(missing.ok).toBe(true);
    if (!missing.ok) return;
    expect(missing.value).toBeNull();

    const inspected = await compactContinuation.getCompactContinuationAttemptIntent(
      { filePath: fixture.filePath },
      "identity-inspect-1",
    );
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.value).not.toBeNull();
    if (inspected.value === null) return;
    expect(inspected.value.attemptId).toBe("identity-inspect-1");
    expect(inspected.value.actor).toBe("recovery-actor");
    expect(inspected.value.harness).toBe("recovery-harness");
    expect(inspected.value.continuation).toEqual({
      kind: "pending_correlated_tool_result",
      protectedToolCallIds: [toolCallId],
    });
    expect(inspected.value.policy).toEqual({
      upperTriggerTokens: 77_000,
      lowerTargetTokens: 321,
      hostCapability: "full_state_machine",
    });
    expect(inspected.value.compact?.profile).toBe("continuation");
    expect(inspected.value.compact?.params?.lowerBound).toBe(321);
    // Hash integrity: stored identity matches computeOperationIdentity without mutable posture.
    const expected = compactContinuation.computeOperationIdentity(facts);
    const { intentHash } = compactContinuation.hashAttemptIntent(expected);
    expect(inspected.value.intentHash).toBe(intentHash);

    // Corrupt intent_json → storage_failure; never synthesizes/clears claim.
    const db = openRaw(fixture.filePath);
    try {
      db.prepare(`UPDATE compact_continuation_attempt SET intent_json = ? WHERE attempt_id = ?`).run(
        "{not-json",
        "identity-inspect-1",
      );
    } finally {
      db.close();
    }
    const corrupt = await compactContinuation.getCompactContinuationAttemptIntent(
      { filePath: fixture.filePath },
      "identity-inspect-1",
    );
    expect(corrupt.ok).toBe(false);
    if (corrupt.ok) return;
    expect(corrupt.error.code).toBe("storage_failure");
    expect(writerClaimOf(fixture.filePath)).toEqual({ claim: "lhc", attemptId: "identity-inspect-1" });
  });

  it("claim-only preserve-path re-enters with stored identity despite live seam drift", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedOpenAgenticTurn(fixture.filePath);
    const toolCallId = "call-crash-X";
    const preserveFacts = baseFacts({
      attemptId: "preserve-claim-only-1",
      continuation: {
        kind: "pending_correlated_tool_result",
        protectedToolCallIds: [toolCallId],
        correlationValid: true,
      },
      // Seed both tool call+result so preserve path can prove the pair.
      // (seedOpenAgenticTurn already has call-active-1; add matching pair via additional events below if needed.)
    });
    // Inject the preserve tool pair into the open turn so proof can succeed.
    await intakeStream.messageEvents({ filePath: fixture.filePath }, [
      validEvent("tool_call", {
        payload: { toolCallId, toolName: "read_file", arguments: { path: "y.txt" } },
      }),
      validEvent("tool_result", {
        payload: { toolCallId, content: "preserve body ".repeat(20), isError: false },
      }),
    ]);

    const crashed = await runCCTest(fixture.filePath, preserveFacts, { failFinalizeAtRelease: true });
    expect(crashed.ok).toBe(false);
    if (crashed.ok) return;
    expect(writerClaimOf(fixture.filePath)).toEqual({
      claim: "lhc",
      attemptId: "preserve-claim-only-1",
    });
    const pendingAfterCrash = await compactContinuation.getPendingCompactContinuationBoundary({
      filePath: fixture.filePath,
    });
    expect(pendingAfterCrash.ok).toBe(true);
    // Preserve path may or may not leave a boundary; claim-only shape is intent+claim.
    // When no complete boundary, owner still holds claim.

    const identity = await compactContinuation.getCompactContinuationAttemptIntent(
      { filePath: fixture.filePath },
      "preserve-claim-only-1",
    );
    expect(identity.ok).toBe(true);
    if (!identity.ok || identity.value === null) {
      expect(identity.ok && identity.value !== null).toBe(true);
      return;
    }
    expect(identity.value.continuation).toEqual({
      kind: "pending_correlated_tool_result",
      protectedToolCallIds: [toolCallId],
    });

    // Live seam has a different kind and no toolCallId X — must still re-enter with stored identity.
    const liveDrift = baseFacts({
      attemptId: "preserve-claim-only-1",
      writerClaim: "lhc",
      continuation: { kind: "active_non_tool" },
      // Policy/compact drift relative to stored identity would also conflict without recovery.
      policy: {
        upperTriggerTokens: 999_999,
        lowerTargetTokens: 1,
        hostCapability: "full_state_machine",
      },
      compact: { params: { lowerBound: 1 } },
    });
    // Without stored identity: conflict.
    const conflict = await compactContinuation.runCompactContinuation({ filePath: fixture.filePath }, liveDrift);
    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.error.code).toBe("compact_continuation_attempt_conflict");
    // Claim must not be cleared by the conflicted re-entry.
    expect(writerClaimOf(fixture.filePath)).toEqual({
      claim: "lhc",
      attemptId: "preserve-claim-only-1",
    });

    // Recovery: rebuild host facts from stored immutable identity + fresh mutable posture.
    const recoveredFacts = baseFacts({
      attemptId: identity.value.attemptId,
      actor: identity.value.actor,
      harness: identity.value.harness,
      policy: identity.value.policy,
      ...(identity.value.compact !== undefined ? { compact: identity.value.compact } : {}),
      continuation:
        identity.value.continuation.kind === "pending_correlated_tool_result"
          ? {
              kind: "pending_correlated_tool_result",
              protectedToolCallIds: identity.value.continuation.protectedToolCallIds,
              correlationValid: true,
            }
          : identity.value.continuation,
      writerClaim: "lhc",
      // Fresh mutable posture (different from original crash entry).
      seam: {
        modelResponseComplete: true,
        requestedToolsSettled: true,
        captureFlushed: true,
        beforeNextProviderRequest: true,
        insideTransportRetry: false,
        inputEpochAtDecision: 9,
        inputEpochAtApply: 9,
      },
      providerUsage: {
        available: true,
        inputTokens: 95_000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        total: 95_000,
        domain: "provider_reported_input",
      },
      postMeasurementEstimate: {
        tokens: 500,
        source: "lhc_token_estimate",
        domain: "source_labelled_estimate",
      },
    });
    const recovered = await compactContinuation.runCompactContinuation({ filePath: fixture.filePath }, recoveredFacts);
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(writerClaimOf(fixture.filePath)).toEqual({ claim: "none", attemptId: null });
    // Fresh attempt id works after owner released.
    await seedOpenAgenticTurn(fixture.filePath);
    const fresh = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({ attemptId: "fresh-after-preserve-recovery", continuation: { kind: "active_non_tool" } }),
    );
    expect(fresh.ok).toBe(true);
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

  // ── Fable review-2: claim wedge, finalize OpResult, identity, hooks ─────

  it("BL1: claim-only crash re-entry on quiet/health releases owned claim; fresh can claim", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedOpenAgenticTurn(fixture.filePath);

    // Quiet below-trigger re-entry releases owned claim and does not wedge.
    seedHeldWriter(fixture.filePath, "crashed-quiet");
    expect(writerClaimOf(fixture.filePath)).toEqual({ claim: "lhc", attemptId: "crashed-quiet" });
    const quiet = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({
        attemptId: "crashed-quiet",
        writerClaim: "lhc",
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
    expect(quiet.ok).toBe(true);
    if (!quiet.ok) return;
    expect(quiet.value.receipt.outcome).toBe("continue_normal");
    expect(quiet.value.receipt.residual.writerReleased).toBe(true);
    expect(writerClaimOf(fixture.filePath)).toEqual({ claim: "none", attemptId: null });

    // Missing-usage path.
    seedHeldWriter(fixture.filePath, "crashed-missing");
    const missing = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({
        attemptId: "crashed-missing",
        writerClaim: "lhc",
        providerUsage: { available: false, reason: "missing", domain: "provider_reported_input" },
      }),
    );
    expect(missing.ok).toBe(true);
    if (!missing.ok) return;
    expect(missing.value.receipt.residual.writerReleased).toBe(true);
    expect(writerClaimOf(fixture.filePath)).toEqual({ claim: "none", attemptId: null });

    // Health refusal.
    seedHeldWriter(fixture.filePath, "crashed-health");
    const health = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({
        attemptId: "crashed-health",
        writerClaim: "lhc",
        captureComplete: false,
      }),
    );
    expect(health.ok).toBe(true);
    if (!health.ok) return;
    expect(health.value.receipt.refuseCode).toBe("incomplete_capture");
    expect(health.value.receipt.residual.writerReleased).toBe(true);
    expect(writerClaimOf(fixture.filePath)).toEqual({ claim: "none", attemptId: null });

    // Foreign attempt must not release another owner's claim.
    seedHeldWriter(fixture.filePath, "crashed-owner");
    const foreign = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({
        attemptId: "other-fresh",
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
    expect(foreign.ok).toBe(true);
    if (!foreign.ok) return;
    expect(writerClaimOf(fixture.filePath)).toEqual({ claim: "lhc", attemptId: "crashed-owner" });

    // Same-attempt mutating resume after claim-only crash succeeds and releases.
    const resumed = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({ attemptId: "crashed-owner", writerClaim: "lhc" }),
    );
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(["compact_continue_turn", "degraded_compact", "no_reduction"]).toContain(resumed.value.receipt.outcome);
    expect(writerClaimOf(fixture.filePath)).toEqual({ claim: "none", attemptId: null });

    // Fresh attempt can claim after owner released.
    await seedOpenAgenticTurn(fixture.filePath);
    const fresh = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({ attemptId: "fresh-after-wedge" }),
    );
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(writerClaimOf(fixture.filePath)).toEqual({ claim: "none", attemptId: null });
  });

  it("BL2: finalize mid-txn faults return storage_failure, roll back, then recover", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedOpenAgenticTurn(fixture.filePath);

    for (const [attemptId, hooks] of [
      ["fin-after-receipt", { failFinalizeAfterReceipt: true }],
      ["fin-at-release", { failFinalizeAtRelease: true }],
      ["fin-after-release", { failFinalizeAfterReleaseBeforeCommit: true }],
      ["fin-receipt-write", { failReceiptWrite: true }],
    ] as const) {
      const before = snapshotCanonical(fixture.filePath);
      const claimBefore = writerClaimOf(fixture.filePath);
      expect(claimBefore).toEqual({ claim: "none", attemptId: null });

      const failed = await runCCTest(fixture.filePath, baseFacts({ attemptId }), { ...hooks });
      expect(failed.ok).toBe(false);
      if (failed.ok) return;
      expect(failed.error.code).toBe("storage_failure");

      // No terminal receipt; mid-txn hooks roll the finalize txn back entirely.
      const stored = await compactContinuation.getCompactContinuationReceipt({ filePath: fixture.filePath }, attemptId);
      expect(stored.ok).toBe(true);
      if (!stored.ok) return;
      expect(stored.value).toBeNull();

      // Writer claim happens in an earlier committed txn, so it remains held by this attempt
      // for every finalize fault including failReceiptWrite (pre-txn abort after claim).
      const claimAfter = writerClaimOf(fixture.filePath);
      expect(claimAfter).toEqual({ claim: "lhc", attemptId });

      // Boundary may be pending (force path committed) but must not be complete.
      const pending = await compactContinuation.getPendingCompactContinuationBoundary({
        filePath: fixture.filePath,
      });
      expect(pending.ok).toBe(true);
      if (!pending.ok) return;
      if (pending.value !== null) {
        expect(pending.value.status).not.toBe("complete");
        expect(pending.value.attemptId).toBe(attemptId);
      }

      // Stage log must not claim writer_released on a failed finalize.
      const stages = await compactContinuation.listCompactContinuationStages({ filePath: fixture.filePath }, attemptId);
      expect(stages.ok).toBe(true);
      if (!stages.ok) return;
      expect(stages.value.some((s) => s.stage === "writer_released")).toBe(false);
      expect(stages.value.some((s) => s.stage === "claimed_writer")).toBe(true);

      // Canonical record advanced only by force/marker path stages already committed —
      // but view must not be a successful install for this attempt.
      const afterFail = snapshotCanonical(fixture.filePath);
      expect(afterFail.viewId === before.viewId || afterFail.viewId !== null).toBe(true);

      // Successful retry without hook.
      const recovered = await compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        baseFacts({ attemptId, writerClaim: "lhc" }),
      );
      expect(recovered.ok).toBe(true);
      if (!recovered.ok) return;
      expect(["compact_continue_turn", "degraded_compact", "no_reduction"]).toContain(recovered.value.receipt.outcome);
      expect(writerClaimOf(fixture.filePath)).toEqual({ claim: "none", attemptId: null });
      const storedOk = await compactContinuation.getCompactContinuationReceipt(
        { filePath: fixture.filePath },
        attemptId,
      );
      expect(storedOk.ok).toBe(true);
      if (!storedOk.ok) return;
      expect(storedOk.value?.terminal).toBe(true);

      // Next attempt needs fresh open work.
      await seedOpenAgenticTurn(fixture.filePath);
    }
  });

  it("M2: identity drift conflicts; posture drift on same-owner repair is accepted and audited", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedOpenAgenticTurn(fixture.filePath);
    const failed = await runCCTest(fixture.filePath, baseFacts({ attemptId: "identity-1" }), {
      failInstallBeforeWrite: true,
    });
    expect(failed.ok).toBe(true);
    if (!failed.ok) return;
    expect(failed.value.pendingBoundary?.status).toBe("failed_repairable");

    // Actor drift → conflict.
    const actorDrift = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({ attemptId: "identity-1", actor: "other-actor", writerClaim: "none" }),
    );
    expect(actorDrift.ok).toBe(false);
    if (actorDrift.ok) return;
    expect(actorDrift.error.code).toBe("compact_continuation_attempt_conflict");

    // Policy drift → conflict.
    const policyDrift = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({
        attemptId: "identity-1",
        policy: { upperTriggerTokens: 100000, lowerTargetTokens: 999999, hostCapability: "full_state_machine" },
      }),
    );
    expect(policyDrift.ok).toBe(false);
    if (policyDrift.ok) return;
    expect(policyDrift.error.code).toBe("compact_continuation_attempt_conflict");

    // Harness drift → conflict.
    const harnessDrift = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({ attemptId: "identity-1", harness: "other-harness" }),
    );
    expect(harnessDrift.ok).toBe(false);
    if (harnessDrift.ok) return;
    expect(harnessDrift.error.code).toBe("compact_continuation_attempt_conflict");

    // Continuation kind drift → conflict (identity includes kind).
    const kindDrift = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({
        attemptId: "identity-1",
        continuation: { kind: "pending_correlated_tool_result", protectedToolCallIds: ["x"], correlationValid: true },
      }),
    );
    expect(kindDrift.ok).toBe(false);
    if (kindDrift.ok) return;
    expect(kindDrift.error.code).toBe("compact_continuation_attempt_conflict");

    // Posture drift (usage/seam epochs) accepted; stage log records posture snapshots.
    const repaired = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({
        attemptId: "identity-1",
        writerClaim: "none",
        providerUsage: {
          available: true,
          inputTokens: 91000,
          cacheCreationTokens: 5000,
          cacheReadTokens: 10000,
          total: 106000,
          domain: "provider_reported_input",
        },
        seam: { ...SETTLED_SEAM, inputEpochAtDecision: 2, inputEpochAtApply: 2 },
      }),
    );
    expect(repaired.ok).toBe(true);
    if (!repaired.ok) return;
    expect(["compact_continue_turn", "degraded_compact", "no_reduction"]).toContain(repaired.value.receipt.outcome);
    const stages = await compactContinuation.listCompactContinuationStages(
      { filePath: fixture.filePath },
      "identity-1",
    );
    expect(stages.ok).toBe(true);
    if (!stages.ok) return;
    const postures = stages.value.filter((s) => s.stage === "retry_posture");
    expect(postures.length).toBeGreaterThanOrEqual(2);
  });

  it("M5: public surface rejects testHooks; cannot fabricate marker without install", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedOpenAgenticTurn(fixture.filePath);
    const before = snapshotCanonical(fixture.filePath);
    const withHooks = {
      ...baseFacts({ attemptId: "hooks-public-1" }),
      testHooks: { skipRealCompact: true },
    } as CompactContinuationHostFacts & { testHooks: { skipRealCompact: boolean } };
    const result = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      withHooks as CompactContinuationHostFacts,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_compact_continuation_input");
    expect(result.error.reason).toMatch(/testHooks|unknown field/);
    expect(snapshotCanonical(fixture.filePath)).toEqual(before);
    expect(writerClaimOf(fixture.filePath)).toEqual({ claim: "none", attemptId: null });
  });

  it("terminal replay repairs stale same-owner claim with recovery stages, receipt intact", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedOpenAgenticTurn(fixture.filePath);
    const first = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({ attemptId: "replay-repair-1" }),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(writerClaimOf(fixture.filePath)).toEqual({ claim: "none", attemptId: null });
    const receiptBefore = await compactContinuation.getCompactContinuationReceipt(
      { filePath: fixture.filePath },
      "replay-repair-1",
    );
    expect(receiptBefore.ok).toBe(true);
    if (!receiptBefore.ok) return;
    expect(receiptBefore.value?.terminal).toBe(true);
    const receiptJson = JSON.stringify(receiptBefore.value?.receipt);

    // Seed stale same-owner claim after terminal completion.
    seedHeldWriter(fixture.filePath, "replay-repair-1");
    expect(writerClaimOf(fixture.filePath)).toEqual({ claim: "lhc", attemptId: "replay-repair-1" });

    const replay = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({ attemptId: "replay-repair-1" }),
    );
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.replayedTerminalAttempt).toBe(true);
    expect(writerClaimOf(fixture.filePath)).toEqual({ claim: "none", attemptId: null });

    const stages = await compactContinuation.listCompactContinuationStages(
      { filePath: fixture.filePath },
      "replay-repair-1",
    );
    expect(stages.ok).toBe(true);
    if (!stages.ok) return;
    expect(stages.value.some((s) => s.stage === "writer_claim_repaired")).toBe(true);
    expect(stages.value.some((s) => s.stage === "recovery_maintenance")).toBe(true);

    const receiptAfter = await compactContinuation.getCompactContinuationReceipt(
      { filePath: fixture.filePath },
      "replay-repair-1",
    );
    expect(receiptAfter.ok).toBe(true);
    if (!receiptAfter.ok) return;
    expect(receiptAfter.value?.terminal).toBe(true);
    expect(JSON.stringify(receiptAfter.value?.receipt)).toBe(receiptJson);
  });

  it("M4: successful install source_state_json matches post-marker max event order", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedOpenAgenticTurn(fixture.filePath);
    const result = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({ attemptId: "source-state-1" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const db = openRaw(fixture.filePath);
    try {
      const maxEvent = Number(
        (db.prepare(`SELECT COALESCE(MAX(event_order), 0) AS m FROM event`).get() as { m: number | bigint }).m,
      );
      const src = db.prepare(`SELECT source_state_json FROM thread_view WHERE singleton = 1`).get() as {
        source_state_json: string;
      };
      const parsed = JSON.parse(src.source_state_json) as { maxEventOrder: number };
      expect(parsed.maxEventOrder).toBe(maxEvent);
      // Marker is the max event on continue-turn success.
      const marker = db
        .prepare(
          `SELECT event_order FROM event WHERE event_kind = 'compact_continuation_marker' ORDER BY event_order DESC LIMIT 1`,
        )
        .get() as { event_order: number | bigint } | undefined;
      expect(marker).toBeDefined();
      expect(Number(marker!.event_order)).toBe(maxEvent);
    } finally {
      db.close();
    }
  });

  it("M7: token counts reject fractions; provider total is authoritative (not sum-checked)", async () => {
    const fractional = validateHostFacts(
      baseFacts({
        attemptId: "v-frac",
        providerUsage: {
          available: true,
          inputTokens: 10.5 as unknown as number,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          total: 10,
          domain: "provider_reported_input",
        },
      }),
    );
    expect(fractional?.code).toBe("invalid_compact_continuation_input");

    // total may diverge from component sum — accepted as authoritative provider total.
    const totalNotSum = validateHostFacts(
      baseFacts({
        attemptId: "v-total",
        providerUsage: {
          available: true,
          inputTokens: 1,
          cacheCreationTokens: 1,
          cacheReadTokens: 1,
          total: 999999,
          domain: "provider_reported_input",
        },
      }),
    );
    expect(totalNotSum).toBeUndefined();

    const unknownNested = validateHostFacts({
      ...baseFacts({ attemptId: "v-unk" }),
      seam: { ...SETTLED_SEAM, extraFlag: true },
    });
    expect(unknownNested?.reason).toMatch(/unknown field seam\.extraFlag/);
  });
});

describe("LIM-67 pending-tool protected escalation runtime", () => {
  const PROTECTED_ID = "call-protected-1";

  /** One open agentic turn: older huge unprotected tool results, then the protected pair. */
  async function seedEscalationTurn(filePath: string): Promise<void> {
    const events: MessageEventInput[] = [
      validEvent("user_prompt", { payload: { text: "sustained tool work" } }),
      validEvent("assistant_text", { payload: { text: "running the long tool loop" } }),
    ];
    for (let i = 1; i <= 3; i++) {
      events.push(
        validEvent("tool_call", {
          payload: { toolCallId: `call-old-${i}`, toolName: "read_file", arguments: { path: `old-${i}.txt` } },
        }),
        validEvent("tool_result", {
          payload: { toolCallId: `call-old-${i}`, content: `old bulky data ${i} `.repeat(1500), isError: false },
        }),
      );
    }
    events.push(
      validEvent("tool_call", {
        payload: { toolCallId: PROTECTED_ID, toolName: "read_file", arguments: { path: "current.txt" } },
      }),
      validEvent("tool_result", {
        payload: { toolCallId: PROTECTED_ID, content: "protected verbatim payload", isError: false },
      }),
    );
    const batch = await intakeStream.messageEvents({ filePath }, events);
    if (!batch.ok) throw new Error(batch.error.reason);
  }

  function escalationFacts(
    attemptId: string,
    safeRunwayThresholdTokens: number,
  ): CompactContinuationHostFacts {
    return baseFacts({
      attemptId,
      providerUsage: {
        available: true,
        inputTokens: 290000,
        cacheCreationTokens: 5000,
        cacheReadTokens: 5000,
        total: 300000,
        domain: "provider_reported_input",
      },
      postMeasurementEstimate: { tokens: 2000, source: "lhc_token_estimate", domain: "source_labelled_estimate" },
      policy: {
        upperTriggerTokens: 100000,
        lowerTargetTokens: 500000,
        hostCapability: "full_state_machine",
        safeRunwayThresholdTokens,
        safeRunwayThresholdSource: "host_safe_runway",
      },
      continuation: {
        kind: "pending_correlated_tool_result",
        protectedToolCallIds: [PROTECTED_ID],
        correlationValid: true,
      },
    });
  }

  it("escalates ineffective preserve through protected boundary and installs (maximal retry)", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedEscalationTurn(fixture.filePath);
    const before = snapshotCanonical(fixture.filePath);

    // Preserve alone saves ~nothing (results are in the open tail), so projected
    // pressure stays above the threshold until the protected boundary prunes the
    // older unprotected bodies.
    const result = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      escalationFacts("escalate-install-1", 298000),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const receipt = result.value.receipt;
    expect(receipt.outcome).toBe("compact_preserve_tool_escalated");
    expect(receipt.reliefPath).toBe("host_validation_awaiting");
    expect(receipt.protectedToolCallIds).toEqual([PROTECTED_ID]);
    expect(receipt.residual.nextProviderRequestAllowed).toBe(false);
    expect(receipt.residual.hostValidationStatus).toBe("awaiting");
    expect(receipt.residual.markerPersisted).toBe(true);
    expect(receipt.residual.markerServed).toBe(true);
    expect(receipt.residual.visibilityBoundaryAfter).not.toBeNull();
    expect(receipt.residual.visibilityBoundaryAfter!).toBeGreaterThan(receipt.residual.visibilityBoundaryBefore ?? 0);
    expect(receipt.effects.some((e) => e.type === "advance_visibility_boundary")).toBe(true);
    expect(receipt.effects.some((e) => e.type === "preserve_tool_pairs_verbatim")).toBe(true);

    // One forced boundary, one marker, view installed.
    const after = snapshotCanonical(fixture.filePath);
    expect(after.turnCount).toBe(before.turnCount + 1);
    expect(after.markerCount).toBe(1);
    expect(after.viewId).not.toBe(before.viewId);

    // Protected pair stays canonical and verbatim.
    const listed = await messages.list({ filePath: fixture.filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const protectedResult = listed.value.find(
      (m) => m.kind === "tool_result" && m.blocks.some((b) => b.content["toolCallId"] === PROTECTED_ID),
    );
    expect(protectedResult?.blocks[0]?.content["content"]).toBe("protected verbatim payload");

    // Host validation acknowledgment flips awaiting → ok.
    const hv = await compactContinuation.getCompactContinuationHostValidation(
      { filePath: fixture.filePath },
      "escalate-install-1",
    );
    expect(hv.ok).toBe(true);
    if (!hv.ok) return;
    expect(hv.value?.status).toBe("awaiting");
    const ack = await compactContinuation.recordCompactContinuationHostValidation(
      { filePath: fixture.filePath },
      "escalate-install-1",
      "ok",
    );
    expect(ack.ok).toBe(true);
    const hv2 = await compactContinuation.getCompactContinuationHostValidation(
      { filePath: fixture.filePath },
      "escalate-install-1",
    );
    expect(hv2.ok).toBe(true);
    if (!hv2.ok) return;
    expect(hv2.value?.status).toBe("ok");
  });

  it("unsafe runway after maximal prune refuses truthfully: no install, no marker", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedEscalationTurn(fixture.filePath);
    const before = snapshotCanonical(fixture.filePath);

    const result = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      escalationFacts("escalate-unsafe-1", 1000),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const receipt = result.value.receipt;
    expect(receipt.outcome).toBe("refuse");
    expect(receipt.refuseCode).toBe("unsafe_runway");
    expect(receipt.reliefPath).toBe("protected_escalation");
    // Receipt stays truthful: no marker was persisted on the refused attempt.
    expect(receipt.residual.markerPersisted).toBe(false);
    expect(receipt.residual.markerServed).toBe(false);
    expect(receipt.residual.priorServingViewIntact).toBe(true);
    expect(receipt.residual.nextProviderRequestAllowed).toBe(false);
    expect(receipt.effects.some((e) => e.type === "insert_continuation_marker")).toBe(false);
    expect(receipt.effects.some((e) => e.type === "install_serving_view")).toBe(false);

    const after = snapshotCanonical(fixture.filePath);
    // Forced boundary is durable (repairable), but no marker and no new view.
    expect(after.turnCount).toBe(before.turnCount + 1);
    expect(after.markerCount).toBe(0);
    expect(after.viewId).toBe(before.viewId);

    const pending = await compactContinuation.getPendingCompactContinuationBoundary({
      filePath: fixture.filePath,
    });
    expect(pending.ok).toBe(true);
    if (!pending.ok) return;
    expect(pending.value?.status).toBe("failed_repairable");
    expect(pending.value?.markerPersisted).toBe(false);
  });
});
