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
import { o200k, withEstimator } from "./fixtures/tokens.js";

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
  const batch = await withEstimator(o200k, () =>
    intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: "continue the investigation with more context" } }),
      validEvent("assistant_text", { payload: { text: "working on it with more detail ".repeat(20) } }),
      validEvent("tool_call", {
        payload: { toolCallId: "call-active-1", toolName: "read_file", arguments: { path: "x.txt" } },
      }),
      validEvent("tool_result", {
        payload: { toolCallId: "call-active-1", content: "result body ".repeat(30), isError: false },
      }),
    ]),
  );
  if (!batch.ok) throw new Error(batch.error.reason);
}

async function seedPendingToolTurn(filePath: string, toolCallId: string): Promise<void> {
  const batch = await withEstimator(o200k, () =>
    intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: "use tools" } }),
      validEvent("assistant_text", { payload: { text: "calling tool" } }),
      validEvent("tool_call", {
        payload: { toolCallId, toolName: "read_file", arguments: { path: "notes.txt" } },
      }),
      validEvent("tool_result", {
        payload: { toolCallId, content: "tool result verbatim payload that must survive", isError: false },
      }),
    ]),
  );
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

    const below = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
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
      ),
    );
    expect(below.ok).toBe(true);
    if (!below.ok) return;
    expect(below.value.receipt.outcome).toBe("continue_normal");
    expect(below.value.receipt.effects.some((e) => e.type === "claim_writer")).toBe(false);
    expect(snapshotCanonical(fixture.filePath)).toEqual(before);

    const noUsage = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        baseFacts({
          attemptId: "no-usage-1",
          providerUsage: { available: false, reason: "missing", domain: "provider_reported_input" },
        }),
      ),
    );
    expect(noUsage.ok).toBe(true);
    if (!noUsage.ok) return;
    expect(noUsage.value.receipt.outcome).toBe("continue_normal");
    expect(snapshotCanonical(fixture.filePath)).toEqual(before);
  });

  it("normal completion creates no continuation turn", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    const before = snapshotCanonical(fixture.filePath);
    const result = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        baseFacts({ attemptId: "complete-1", continuation: { kind: "none" } }),
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.receipt.outcome).toBe("normal_complete");
    expect(result.value.forcedBoundaryThisAttempt).toBe(false);
    expect(snapshotCanonical(fixture.filePath).turnCount).toBe(before.turnCount);
  });

  it("B1: above-trigger health facts warn and still compact (no refuse)", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedOpenAgenticTurn(fixture.filePath);
    const baseline = await fixture.sdk.threadView.compact(
      { filePath: fixture.filePath },
      { params: { lowerBound: 400, percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 } } },
    );
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;
    const before = snapshotCanonical(fixture.filePath);

    const capture = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        baseFacts({ attemptId: "health-capture", captureComplete: false }),
      ),
    );
    expect(capture.ok).toBe(true);
    if (!capture.ok) return;
    expect(capture.value.receipt.refused).toBe(false);
    expect(capture.value.receipt.refuseCode).toBeNull();
    expect(capture.value.receipt.warnings.map((w) => w.code)).toEqual(["capture_incomplete"]);
    expect(capture.value.receipt.effects.some((e) => e.type === "claim_writer")).toBe(true);
    expect(capture.value.receipt.effects.some((e) => e.type === "install_serving_view")).toBe(true);
    expect(capture.value.receipt.residual.markerPersisted).toBe(true);
    expect(capture.value.receipt.residual.markerServed).toBe(true);
    expect(capture.value.receipt.residual.nextProviderRequestAllowed).toBe(true);
    const afterCapture = snapshotCanonical(fixture.filePath);
    expect(afterCapture.turnCount).toBe(before.turnCount + 1);
    expect(afterCapture.markerCount).toBe(before.markerCount + 1);
    expect(afterCapture.viewId).not.toBe(before.viewId);

    await seedOpenAgenticTurn(fixture.filePath);
    const beforeIdentity = snapshotCanonical(fixture.filePath);
    const identity = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        baseFacts({ attemptId: "health-identity", providerIdentityValid: false }),
      ),
    );
    expect(identity.ok).toBe(true);
    if (!identity.ok) return;
    expect(identity.value.receipt.refuseCode).toBeNull();
    expect(identity.value.receipt.warnings.map((w) => w.code)).toEqual(["provider_identity_unproven"]);
    expect(identity.value.receipt.effects.some((e) => e.type === "omit_signed_reasoning")).toBe(true);
    expect(identity.value.receipt.effects.some((e) => e.type === "install_serving_view")).toBe(true);
    const afterIdentity = snapshotCanonical(fixture.filePath);
    expect(afterIdentity.markerCount).toBe(beforeIdentity.markerCount + 1);
    expect(afterIdentity.viewId).not.toBe(beforeIdentity.viewId);

    await seedPendingToolTurn(fixture.filePath, "call-bad-corr");
    const beforeTool = snapshotCanonical(fixture.filePath);
    const corr = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        baseFacts({
          attemptId: "health-corr",
          continuation: {
            kind: "pending_correlated_tool_result",
            protectedToolCallIds: ["call-bad-corr"],
            correlationValid: false,
          },
        }),
      ),
    );
    expect(corr.ok).toBe(true);
    if (!corr.ok) return;
    expect(corr.value.receipt.refuseCode).toBeNull();
    expect(corr.value.receipt.outcome).toBe("decline_to_ordinary_compact");
    expect(corr.value.receipt.warnings.map((w) => w.code)).toEqual(["tool_correlation_unproven"]);
    expect(corr.value.receipt.residual.priorServingViewIntact).toBe(true);
    expect(corr.value.receipt.residual.originalAgenticTurnStillOpen).toBe(true);
    expect(corr.value.receipt.residual.nextProviderRequestAllowed).toBe(true);
    expect(corr.value.nextProviderRequestAllowed).toBe(true);
    expect(snapshotCanonical(fixture.filePath)).toEqual(beforeTool);

    const missing = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        baseFacts({
          attemptId: "health-pair-missing",
          continuation: {
            kind: "pending_correlated_tool_result",
            protectedToolCallIds: ["call-does-not-exist"],
            correlationValid: true,
          },
        }),
      ),
    );
    expect(missing.ok).toBe(true);
    if (!missing.ok) return;
    expect(missing.value.receipt.refuseCode).toBeNull();
    expect(missing.value.receipt.outcome).toBe("decline_to_ordinary_compact");
    expect(missing.value.receipt.warnings.map((w) => w.code)).toEqual(["tool_correlation_unproven"]);
    expect(missing.value.receipt.residual.nextProviderRequestAllowed).toBe(true);
    expect(snapshotCanonical(fixture.filePath)).toEqual(beforeTool);
  });

  it("active non-tool success: one boundary, one hidden typed marker, install", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedOpenAgenticTurn(fixture.filePath);

    const result = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        baseFacts({ attemptId: "active-success-1" }),
      ),
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
    const first = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        baseFacts({ attemptId: "complete-boundary-1" }),
      ),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.pendingBoundary).toBeNull();
    const viewAfter = snapshotCanonical(fixture.filePath);

    const below = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
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
      ),
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
    const first = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation({ filePath: fixture.filePath }, baseFacts({ attemptId: "replay-1" })),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const after = snapshotCanonical(fixture.filePath);

    const second = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation({ filePath: fixture.filePath }, baseFacts({ attemptId: "replay-1" })),
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
    const first = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        baseFacts({ attemptId: "distinct-1" }),
      ),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const tA = first.value.continuationTurnId!;

    await seedOpenAgenticTurn(fixture.filePath);
    const second = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        baseFacts({ attemptId: "distinct-2" }),
      ),
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

    const result = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        baseFacts({
          attemptId: "tool-success-1",
          continuation: {
            kind: "pending_correlated_tool_result",
            protectedToolCallIds: [toolCallId],
            correlationValid: true,
          },
        }),
      ),
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
    expect(interrupted.value.pendingBoundary?.status).toBe("pending");
    expect(interrupted.value.replayedTerminalAttempt).toBe(false);

    const repaired = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        baseFacts({
          attemptId: "repair-boundary-1",
          writerClaim: "lhc",
          continuation: { kind: "active_non_tool" },
        }),
      ),
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

    const repaired = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        baseFacts({
          attemptId: "repair-marker-1",
          writerClaim: "lhc",
          continuation: { kind: "active_non_tool" },
        }),
      ),
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

    const interrupted = await runCCTest(fixture.filePath, baseFacts({ attemptId: "crash-1" }), {
      interruptAfterBoundary: true,
    });
    expect(interrupted.ok).toBe(true);
    if (!interrupted.ok) return;
    const cTurnId = interrupted.value.continuationTurnId!;

    const claim = await compactContinuation.getCompactContinuationWriterClaim({ filePath: fixture.filePath });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    expect(claim.value.claim).toBe("lhc");
    expect(claim.value.attemptId).toBe("crash-1");

    const steal = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        baseFacts({ attemptId: "crash-other", continuation: { kind: "active_non_tool" } }),
      ),
    );
    expect(steal.ok).toBe(false);
    if (steal.ok) return;
    expect(["compact_continuation_attempt_conflict", "compact_continuation_writer_conflict"]).toContain(
      steal.error.code,
    );

    const resumed = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        baseFacts({
          attemptId: "crash-1",
          writerClaim: "lhc",
          continuation: { kind: "active_non_tool" },
        }),
      ),
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
    if (result.ok) {
      expect(result.value.nextProviderRequestAllowed).toBe(false);
    } else {
      expect(result.error.code).toBe("storage_failure");
    }
  });

  it("M4: normal source progress after prepare does not block activation", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    const prepared = await fixture.sdk.threadView.prepareCompact(
      { filePath: fixture.filePath },
      { params: { lowerBound: 400, percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 } } },
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    await withEstimator(o200k, () =>
      intakeStream.messageEvents({ filePath: fixture.filePath }, [
        validEvent("user_prompt", { payload: { text: "steering" } }),
      ]),
    );

    const installed = await fixture.sdk.threadView.installPreparedCompact(
      { filePath: fixture.filePath },
      prepared.value,
    );
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;

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

  it("install failure after marker is bounded retry; prior view kept, residual truthful", async () => {
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
    expect(result.value.receipt.refused).toBe(false);
    expect(result.value.receipt.refuseCode).toBeNull();
    expect(result.value.receipt.outcome).toBe("retry_compact");
    expect(result.value.receipt.reasonCode).toBe("compact_retry_authorized");
    expect(result.value.receipt.warnings.map((w) => w.code)).toEqual(["install_attempt_failed"]);
    expect(result.value.receipt.retry).toEqual({ attemptIndex: 1, budget: 2, retryAuthorized: true });
    expect(result.value.receipt.residual.markerPersisted).toBe(true);
    expect(result.value.receipt.residual.markerServed).toBe(false);
    expect(result.value.receipt.residual.priorServingViewIntact).toBe(true);
    expect(result.value.receipt.residual.reliefPath).toBe("core_install_failed");
    expect(result.value.receipt.residual.nextProviderRequestAllowed).toBe(true);
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

    const exhausted = await runCCTest(fixture.filePath, baseFacts({ attemptId: "install-fail-1" }), {
      failInstallBeforeWrite: true,
    });
    expect(exhausted.ok).toBe(true);
    if (!exhausted.ok) return;
    expect(exhausted.value.receipt.refuseCode).toBeNull();
    expect(exhausted.value.receipt.outcome).toBe("continue_current_body");
    expect(exhausted.value.receipt.reasonCode).toBe("compact_retry_budget_exhausted");
    expect(exhausted.value.receipt.retry).toEqual({ attemptIndex: 2, budget: 2, retryAuthorized: false });
    expect(exhausted.value.receipt.warnings.map((w) => w.code)).toEqual([
      "install_attempt_failed",
      "compact_retry_budget_exhausted",
    ]);
    expect(exhausted.value.receipt.residual.priorServingViewIntact).toBe(true);
    expect(exhausted.value.receipt.residual.nextProviderRequestAllowed).toBe(true);
    const stillBaseline = await fixture.sdk.threadView.describe({ filePath: fixture.filePath });
    expect(stillBaseline.ok).toBe(true);
    if (!stillBaseline.ok) return;
    expect(stillBaseline.value?.viewId).toBe(baseline.value.viewId);

    const storedExhausted = await compactContinuation.getCompactContinuationReceipt(
      { filePath: fixture.filePath },
      "install-fail-1",
    );
    expect(storedExhausted.ok).toBe(true);
    if (!storedExhausted.ok) return;
    expect(storedExhausted.value?.terminal).toBe(true);
    expect(exhausted.value.pendingBoundary).toBeNull();

    const countRows = (table: string): number => {
      const db = openRaw(fixture.filePath);
      try {
        const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
        return Number(row.n);
      } finally {
        db.close();
      }
    };
    const stagesBefore = countRows("compact_continuation_stage_log");
    const messagesBefore = countRows("message");
    const third = await runCCTest(fixture.filePath, baseFacts({ attemptId: "install-fail-1" }), {
      failInstallBeforeWrite: true,
    });
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(third.value.replayedTerminalAttempt).toBe(true);
    expect(third.value.receipt.outcome).toBe("continue_current_body");
    expect(third.value.pendingBoundary).toBeNull();
    expect(countRows("compact_continuation_stage_log")).toBe(stagesBefore);
    expect(countRows("message")).toBe(messagesBefore);
    const afterReplay = await fixture.sdk.threadView.describe({ filePath: fixture.filePath });
    expect(afterReplay.ok).toBe(true);
    if (!afterReplay.ok) return;
    expect(afterReplay.value?.viewId).toBe(baseline.value.viewId);

    const fresh = await runCCTest(fixture.filePath, baseFacts({ attemptId: "install-fail-2" }));
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(fresh.value.receipt.refuseCode).toBeNull();
    expect(fresh.value.receipt.retry.attemptIndex).toBe(1);
  });

  it("P1: install fail → failed_repairable nonterminal → same attempt repair succeeds", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedOpenAgenticTurn(fixture.filePath);

    const failed = await runCCTest(fixture.filePath, baseFacts({ attemptId: "repair-install-1" }), {
      failInstallBeforeWrite: true,
    });
    expect(failed.ok).toBe(true);
    if (!failed.ok) return;
    expect(failed.value.receipt.refuseCode).toBeNull();
    expect(failed.value.receipt.outcome).toBe("retry_compact");
    expect(failed.value.receipt.retry.retryAuthorized).toBe(true);
    expect(failed.value.receipt.warnings.map((w) => w.code)).toEqual(["install_attempt_failed"]);
    expect(failed.value.receipt.residual.nextProviderRequestAllowed).toBe(true);
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

    const repaired = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        baseFacts({
          attemptId: "repair-install-1",
          writerClaim: "none",
          continuation: { kind: "active_non_tool" },
        }),
      ),
    );
    expect(repaired.ok).toBe(true);
    if (!repaired.ok) return;
    expect(repaired.value.forcedBoundaryThisAttempt).toBe(false);
    expect(repaired.value.continuationTurnId).toBe(cTurnId);
    expect(repaired.value.replayedTerminalAttempt).toBe(false);
    expect(["compact_continue_turn", "degraded_compact", "no_reduction"]).toContain(repaired.value.receipt.outcome);
    expect(repaired.value.receipt.refuseCode).toBeNull();
    expect(repaired.value.receipt.residual.markerServed).toBe(true);
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

    const steal = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        baseFacts({
          attemptId: "thief-1",
          continuation: { kind: "active_non_tool" },
        }),
      ),
    );
    expect(steal.ok).toBe(false);
    if (steal.ok) return;
    expect(steal.error.code).toBe("compact_continuation_attempt_conflict");
    expect(steal.error.reason).toContain("owner-fail-1");

    const owner = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        baseFacts({
          attemptId: "owner-fail-1",
          continuation: { kind: "active_non_tool" },
        }),
      ),
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
    expect(interrupted.value.pendingBoundary).toBeNull();

    const claim = await compactContinuation.getCompactContinuationWriterClaim({ filePath: fixture.filePath });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    expect(claim.value.claim).toBe("lhc");
    expect(claim.value.attemptId).toBe("force-gap-1");

    const resumed = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        baseFacts({
          attemptId: "force-gap-1",
          writerClaim: "lhc",
          continuation: { kind: "active_non_tool" },
        }),
      ),
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

    const first = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        baseFacts({ attemptId: "intent-replay-1" }),
      ),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const after = snapshotCanonical(fixture.filePath);

    const same = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        baseFacts({ attemptId: "intent-replay-1" }),
      ),
    );
    expect(same.ok).toBe(true);
    if (!same.ok) return;
    expect(same.value.replayedTerminalAttempt).toBe(true);
    expect(same.value.receipt.outcome).toBe(first.value.receipt.outcome);
    expect(snapshotCanonical(fixture.filePath)).toEqual(after);

    const different = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        baseFacts({
          attemptId: "intent-replay-1",
          continuation: { kind: "none" },
        }),
      ),
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

    const skip = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        baseFacts({
          attemptId: "preskip-pending-1",
          writerClaim: "lhc",
          seam: {
            ...SETTLED_SEAM,
            insideTransportRetry: true,
          },
        }),
      ),
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

    const repaired = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        baseFacts({
          attemptId: "preskip-pending-1",
          writerClaim: "none",
          continuation: { kind: "active_non_tool" },
        }),
      ),
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
    const result = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        // @ts-expect-error intentional invalid
        { attemptId: "" },
      ),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_compact_continuation_input");
  });

  it("native writer row: no authority means continue; stale row reclaims and compacts", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedOpenAgenticTurn(fixture.filePath);
    const before = snapshotCanonical(fixture.filePath);

    const noAuthority = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        baseFacts({ attemptId: "native-1", writerClaim: "native" }),
      ),
    );
    expect(noAuthority.ok).toBe(true);
    if (!noAuthority.ok) return;
    expect(noAuthority.value.receipt.refused).toBe(false);
    expect(noAuthority.value.receipt.refuseCode).toBeNull();
    expect(noAuthority.value.receipt.outcome).toBe("continue_current_body");
    expect(noAuthority.value.receipt.reasonCode).toBe("writer_owned_elsewhere");
    expect(noAuthority.value.receipt.warnings.map((w) => w.code)).toEqual(["writer_owned_elsewhere"]);
    expect(noAuthority.value.receipt.effects.some((e) => e.type === "claim_writer")).toBe(false);
    expect(noAuthority.value.receipt.effects.some((e) => e.type === "reclaim_writer")).toBe(false);
    expect(noAuthority.value.reclaimedStaleWriterRow).toBe(false);
    expect(noAuthority.value.receipt.residual.nextProviderRequestAllowed).toBe(true);
    expect(noAuthority.value.nextProviderRequestAllowed).toBe(true);
    expect(snapshotCanonical(fixture.filePath)).toEqual(before);

    const seenByCheck: { threadId: string; attemptId: string }[] = [];
    const reclaimed = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        baseFacts({ attemptId: "native-reclaim", writerClaim: "native" }),
        () => new Date(),
        {
          writerOwnershipCheck: (args) => {
            seenByCheck.push(args);
            return false;
          },
        },
      ),
    );
    expect(reclaimed.ok).toBe(true);
    if (!reclaimed.ok) return;
    expect(seenByCheck).toHaveLength(1);
    expect(seenByCheck[0]?.threadId).toMatch(/^th_/);
    expect(seenByCheck[0]?.attemptId).toBe("native-reclaim");
    expect(reclaimed.value.receipt.refuseCode).toBeNull();
    expect(reclaimed.value.reclaimedStaleWriterRow).toBe(true);
    const reclaimEffect = reclaimed.value.receipt.effects.find((e) => e.type === "reclaim_writer");
    expect(reclaimEffect).toEqual({ type: "reclaim_writer", priorClaim: "native", hostAuthority: "no_live_owner" });
    expect(reclaimed.value.receipt.warnings.map((w) => w.code)).toEqual(["stale_writer_row_reclaimed"]);
    const effectTypes = reclaimed.value.receipt.effects.map((e) => e.type);
    expect(effectTypes.indexOf("reclaim_writer")).toBeLessThan(effectTypes.indexOf("claim_writer"));
    expect(effectTypes).toContain("install_serving_view");
    expect(reclaimed.value.receipt.residual.nextProviderRequestAllowed).toBe(true);
    const after = snapshotCanonical(fixture.filePath);
    expect(after.markerCount).toBe(before.markerCount + 1);
    expect(after.viewId).not.toBe(before.viewId);
    expect(writerClaimOf(fixture.filePath)).toEqual({ claim: "none", attemptId: null });
  });

  it("two sessions on one LHC thread: one owner, loser continues without stealing", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedOpenAgenticTurn(fixture.filePath);
    const before = snapshotCanonical(fixture.filePath);

    const ownershipRegistry = new Map<string, string>();
    function session(sessionId: string) {
      let ownsSlotLocally = false;
      return {
        sessionId,
        claimThread(threadId: string): boolean {
          if (ownershipRegistry.has(threadId)) return false;
          ownershipRegistry.set(threadId, sessionId);
          ownsSlotLocally = true;
          return true;
        },
        releaseThread(threadId: string): void {
          if (ownershipRegistry.get(threadId) === sessionId) ownershipRegistry.delete(threadId);
          ownsSlotLocally = false;
        },
        ownsSlot(): boolean {
          return ownsSlotLocally;
        },
        writerOwnershipCheck({ threadId }: { threadId: string; attemptId: string }): boolean {
          const owner = ownershipRegistry.get(threadId);
          return owner !== undefined && owner !== sessionId;
        },
      };
    }

    const sessionA = session("session-a");
    const sessionB = session("session-b");

    const described = await threads.info({ filePath: fixture.filePath });
    expect(described.ok).toBe(true);
    if (!described.ok) return;
    const lhcThreadId = described.value.threadId;
    expect(sessionA.claimThread(lhcThreadId)).toBe(true);
    expect(sessionB.claimThread(lhcThreadId)).toBe(false);
    expect(sessionA.ownsSlot()).toBe(true);
    expect(sessionB.ownsSlot()).toBe(false);

    const loser = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        baseFacts({ attemptId: "session-b-attempt", writerClaim: "native" }),
        () => new Date(),
        { writerOwnershipCheck: (args) => sessionB.writerOwnershipCheck(args) },
      ),
    );
    expect(loser.ok).toBe(true);
    if (!loser.ok) return;
    expect(loser.value.receipt.refuseCode).toBeNull();
    expect(loser.value.receipt.outcome).toBe("continue_current_body");
    expect(loser.value.receipt.warnings.map((w) => w.code)).toEqual(["writer_owned_elsewhere"]);
    expect(loser.value.reclaimedStaleWriterRow).toBe(false);
    expect(loser.value.receipt.effects.some((e) => e.type === "reclaim_writer")).toBe(false);
    expect(ownershipRegistry.get(lhcThreadId)).toBe("session-a");
    expect(loser.value.nextProviderRequestAllowed).toBe(true);
    expect(snapshotCanonical(fixture.filePath)).toEqual(before);

    const owner = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        baseFacts({ attemptId: "session-a-attempt", writerClaim: "native" }),
        () => new Date(),
        { writerOwnershipCheck: (args) => sessionA.writerOwnershipCheck(args) },
      ),
    );
    expect(owner.ok).toBe(true);
    if (!owner.ok) return;
    expect(owner.value.reclaimedStaleWriterRow).toBe(true);
    expect(owner.value.receipt.warnings.map((w) => w.code)).toEqual(["stale_writer_row_reclaimed"]);
    expect(owner.value.receipt.effects.some((e) => e.type === "install_serving_view")).toBe(true);
    const afterOwner = snapshotCanonical(fixture.filePath);
    expect(afterOwner.viewId).not.toBe(before.viewId);

    sessionA.releaseThread(lhcThreadId);
    await seedOpenAgenticTurn(fixture.filePath);
    const beforeRetry = snapshotCanonical(fixture.filePath);
    const retried = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        baseFacts({ attemptId: "session-b-retry", writerClaim: "native" }),
        () => new Date(),
        { writerOwnershipCheck: (args) => sessionB.writerOwnershipCheck(args) },
      ),
    );
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.value.reclaimedStaleWriterRow).toBe(true);
    expect(retried.value.receipt.refuseCode).toBeNull();
    expect(snapshotCanonical(fixture.filePath).viewId).not.toBe(beforeRetry.viewId);
  });

  it("durable receipt and stage log are inspectable", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedOpenAgenticTurn(fixture.filePath);
    const result = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation({ filePath: fixture.filePath }, baseFacts({ attemptId: "inspect-1" })),
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
    await withEstimator(o200k, () =>
      intakeStream.messageEvents({ filePath: fixture.filePath }, [
        validEvent("tool_call", {
          payload: { toolCallId, toolName: "read_file", arguments: { path: "y.txt" } },
        }),
        validEvent("tool_result", {
          payload: { toolCallId, content: "preserve body ".repeat(20), isError: false },
        }),
      ]),
    );
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
    const expected = compactContinuation.computeOperationIdentity(facts);
    const { intentHash } = compactContinuation.hashAttemptIntent(expected);
    expect(inspected.value.intentHash).toBe(intentHash);

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
    });
    await withEstimator(o200k, () =>
      intakeStream.messageEvents({ filePath: fixture.filePath }, [
        validEvent("tool_call", {
          payload: { toolCallId, toolName: "read_file", arguments: { path: "y.txt" } },
        }),
        validEvent("tool_result", {
          payload: { toolCallId, content: "preserve body ".repeat(20), isError: false },
        }),
      ]),
    );

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

    const liveDrift = baseFacts({
      attemptId: "preserve-claim-only-1",
      writerClaim: "lhc",
      continuation: { kind: "active_non_tool" },
      policy: {
        upperTriggerTokens: 999_999,
        lowerTargetTokens: 1,
        hostCapability: "full_state_machine",
      },
      compact: { params: { lowerBound: 1 } },
    });
    const conflict = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation({ filePath: fixture.filePath }, liveDrift),
    );
    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.error.code).toBe("compact_continuation_attempt_conflict");
    expect(writerClaimOf(fixture.filePath)).toEqual({
      claim: "lhc",
      attemptId: "preserve-claim-only-1",
    });

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
    const recovered = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation({ filePath: fixture.filePath }, recoveredFacts),
    );
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(writerClaimOf(fixture.filePath)).toEqual({ claim: "none", attemptId: null });
    await seedOpenAgenticTurn(fixture.filePath);
    const fresh = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        baseFacts({ attemptId: "fresh-after-preserve-recovery", continuation: { kind: "active_non_tool" } }),
      ),
    );
    expect(fresh.ok).toBe(true);
  });

  it("SDK surface exposes compactContinuation on initLhc", async () => {
    const sdk: Lhc = initLhc({
      tokenFamily: "o200k",
      inferenceCallbacks: createInferenceCallbacksDouble(),
      mode: "manual",
    });
    const filePath = store.threadPath();
    const created = await threads.newThread({ filePath, registryPath: store.registryPath });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await withEstimator(o200k, () =>
      intakeStream.messageEvents({ filePath }, [validEvent("user_prompt"), validEvent("assistant_text")]),
    );

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

  it("BL1: claim-only crash re-entry on quiet/degraded seams releases owned claim; fresh can claim", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedOpenAgenticTurn(fixture.filePath);

    seedHeldWriter(fixture.filePath, "crashed-quiet");
    expect(writerClaimOf(fixture.filePath)).toEqual({ claim: "lhc", attemptId: "crashed-quiet" });
    const quiet = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
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
      ),
    );
    expect(quiet.ok).toBe(true);
    if (!quiet.ok) return;
    expect(quiet.value.receipt.outcome).toBe("continue_normal");
    expect(quiet.value.receipt.residual.writerReleased).toBe(true);
    expect(writerClaimOf(fixture.filePath)).toEqual({ claim: "none", attemptId: null });

    seedHeldWriter(fixture.filePath, "crashed-missing");
    const missing = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        baseFacts({
          attemptId: "crashed-missing",
          writerClaim: "lhc",
          providerUsage: { available: false, reason: "missing", domain: "provider_reported_input" },
        }),
      ),
    );
    expect(missing.ok).toBe(true);
    if (!missing.ok) return;
    expect(missing.value.receipt.residual.writerReleased).toBe(true);
    expect(writerClaimOf(fixture.filePath)).toEqual({ claim: "none", attemptId: null });

    seedHeldWriter(fixture.filePath, "crashed-health");
    const health = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        baseFacts({
          attemptId: "crashed-health",
          writerClaim: "lhc",
          captureComplete: false,
        }),
      ),
    );
    expect(health.ok).toBe(true);
    if (!health.ok) return;
    expect(health.value.receipt.refuseCode).toBeNull();
    expect(health.value.receipt.warnings.map((w) => w.code)).toEqual(["capture_incomplete"]);
    expect(["compact_continue_turn", "degraded_compact", "no_reduction"]).toContain(health.value.receipt.outcome);
    expect(health.value.receipt.residual.writerReleased).toBe(true);
    expect(health.value.receipt.residual.nextProviderRequestAllowed).toBe(true);
    expect(writerClaimOf(fixture.filePath)).toEqual({ claim: "none", attemptId: null });

    seedHeldWriter(fixture.filePath, "crashed-decline");
    const declined = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        baseFacts({
          attemptId: "crashed-decline",
          writerClaim: "lhc",
          continuation: {
            kind: "pending_correlated_tool_result",
            protectedToolCallIds: ["call-not-in-record"],
            correlationValid: true,
          },
        }),
      ),
    );
    expect(declined.ok).toBe(true);
    if (!declined.ok) return;
    expect(declined.value.receipt.refuseCode).toBeNull();
    expect(declined.value.receipt.outcome).toBe("decline_to_ordinary_compact");
    expect(declined.value.receipt.residual.writerReleased).toBe(true);
    expect(declined.value.receipt.residual.nextProviderRequestAllowed).toBe(true);
    expect(writerClaimOf(fixture.filePath)).toEqual({ claim: "none", attemptId: null });

    seedHeldWriter(fixture.filePath, "crashed-owner");
    const foreign = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
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
      ),
    );
    expect(foreign.ok).toBe(true);
    if (!foreign.ok) return;
    expect(writerClaimOf(fixture.filePath)).toEqual({ claim: "lhc", attemptId: "crashed-owner" });

    const resumed = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        baseFacts({ attemptId: "crashed-owner", writerClaim: "lhc" }),
      ),
    );
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(["compact_continue_turn", "degraded_compact", "no_reduction"]).toContain(resumed.value.receipt.outcome);
    expect(writerClaimOf(fixture.filePath)).toEqual({ claim: "none", attemptId: null });

    await seedOpenAgenticTurn(fixture.filePath);
    const fresh = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        baseFacts({ attemptId: "fresh-after-wedge" }),
      ),
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

      const stored = await compactContinuation.getCompactContinuationReceipt({ filePath: fixture.filePath }, attemptId);
      expect(stored.ok).toBe(true);
      if (!stored.ok) return;
      expect(stored.value).toBeNull();

      const claimAfter = writerClaimOf(fixture.filePath);
      expect(claimAfter).toEqual({ claim: "lhc", attemptId });

      const pending = await compactContinuation.getPendingCompactContinuationBoundary({
        filePath: fixture.filePath,
      });
      expect(pending.ok).toBe(true);
      if (!pending.ok) return;
      if (pending.value !== null) {
        expect(pending.value.status).not.toBe("complete");
        expect(pending.value.attemptId).toBe(attemptId);
      }

      const stages = await compactContinuation.listCompactContinuationStages({ filePath: fixture.filePath }, attemptId);
      expect(stages.ok).toBe(true);
      if (!stages.ok) return;
      expect(stages.value.some((s) => s.stage === "writer_released")).toBe(false);
      expect(stages.value.some((s) => s.stage === "claimed_writer")).toBe(true);

      const afterFail = snapshotCanonical(fixture.filePath);
      expect(afterFail.viewId === before.viewId || afterFail.viewId !== null).toBe(true);

      const recovered = await withEstimator(o200k, () =>
        compactContinuation.runCompactContinuation(
          { filePath: fixture.filePath },
          baseFacts({ attemptId, writerClaim: "lhc" }),
        ),
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

    const actorDrift = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        baseFacts({ attemptId: "identity-1", actor: "other-actor", writerClaim: "none" }),
      ),
    );
    expect(actorDrift.ok).toBe(false);
    if (actorDrift.ok) return;
    expect(actorDrift.error.code).toBe("compact_continuation_attempt_conflict");

    const policyDrift = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        baseFacts({
          attemptId: "identity-1",
          policy: { upperTriggerTokens: 100000, lowerTargetTokens: 999999, hostCapability: "full_state_machine" },
        }),
      ),
    );
    expect(policyDrift.ok).toBe(false);
    if (policyDrift.ok) return;
    expect(policyDrift.error.code).toBe("compact_continuation_attempt_conflict");

    const harnessDrift = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        baseFacts({ attemptId: "identity-1", harness: "other-harness" }),
      ),
    );
    expect(harnessDrift.ok).toBe(false);
    if (harnessDrift.ok) return;
    expect(harnessDrift.error.code).toBe("compact_continuation_attempt_conflict");

    const kindDrift = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        baseFacts({
          attemptId: "identity-1",
          continuation: { kind: "pending_correlated_tool_result", protectedToolCallIds: ["x"], correlationValid: true },
        }),
      ),
    );
    expect(kindDrift.ok).toBe(false);
    if (kindDrift.ok) return;
    expect(kindDrift.error.code).toBe("compact_continuation_attempt_conflict");

    const repaired = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
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
      ),
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
    const result = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        withHooks as CompactContinuationHostFacts,
      ),
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
    const first = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        baseFacts({ attemptId: "replay-repair-1" }),
      ),
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

    seedHeldWriter(fixture.filePath, "replay-repair-1");
    expect(writerClaimOf(fixture.filePath)).toEqual({ claim: "lhc", attemptId: "replay-repair-1" });

    const replay = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        baseFacts({ attemptId: "replay-repair-1" }),
      ),
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

  it("M4: activated view records the source it was assembled from; the marker remains canonical and live", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedOpenAgenticTurn(fixture.filePath);
    const result = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        baseFacts({ attemptId: "source-state-1" }),
      ),
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
      const marker = db
        .prepare(
          `SELECT event_order FROM event WHERE event_kind = 'compact_continuation_marker' ORDER BY event_order DESC LIMIT 1`,
        )
        .get() as { event_order: number | bigint } | undefined;
      expect(marker).toBeDefined();
      expect(Number(marker!.event_order)).toBe(maxEvent);
      const view = db.prepare(`SELECT compact_point FROM thread_view WHERE singleton = 1`).get() as {
        compact_point: number | bigint;
      };
      expect(Number(view.compact_point)).toBeLessThan(Number(marker!.event_order));
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

  async function seedEscalationTurn(filePath: string): Promise<void> {
    const events: MessageEventInput[] = [
      validEvent("user_prompt", { payload: { text: "sustained tool work" } }),
      validEvent("assistant_text", { payload: { text: "running the long tool loop" } }),
    ];
    for (let i = 1; i <= 10; i++) {
      events.push(
        validEvent("tool_call", {
          payload: { toolCallId: `call-old-${i}`, toolName: "read_file", arguments: { path: `old-${i}.txt` } },
        }),
        validEvent("tool_result", {
          payload: { toolCallId: `call-old-${i}`, content: `old bulky data ${i} `.repeat(2000), isError: false },
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
    const batch = await withEstimator(o200k, () => intakeStream.messageEvents({ filePath }, events));
    if (!batch.ok) throw new Error(batch.error.reason);
  }

  function escalationFacts(attemptId: string, safeRunwayThresholdTokens: number): CompactContinuationHostFacts {
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
        lowerTargetTokens: 5_000_000,
        hostCapability: "full_state_machine",
        safeRunwayThresholdTokens,
        safeRunwayThresholdSource: "host_safe_runway",
      },
      continuation: {
        kind: "pending_correlated_tool_result",
        protectedToolCallIds: [PROTECTED_ID],
        correlationValid: true,
      },
      compact: {
        params: { lowerBound: 1_000_000, percentages: { full: 100, smooth: 0, detailed: 0, brief: 0 } },
      },
    });
  }

  it("escalates ineffective preserve through protected boundary and installs (maximal retry)", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedEscalationTurn(fixture.filePath);
    const before = snapshotCanonical(fixture.filePath);

    const result = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        escalationFacts("escalate-install-1", 298000),
      ),
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

    const after = snapshotCanonical(fixture.filePath);
    expect(after.turnCount).toBe(before.turnCount + 1);
    expect(after.markerCount).toBe(1);
    expect(after.viewId).not.toBe(before.viewId);

    const listed = await messages.list({ filePath: fixture.filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const protectedResult = listed.value.find(
      (m) => m.kind === "tool_result" && m.blocks.some((b) => b.content["toolCallId"] === PROTECTED_ID),
    );
    expect(protectedResult?.blocks[0]?.content["content"]).toBe("protected verbatim payload");

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

  it("unsafe runway after maximal prune installs the best relief; no refuse", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedEscalationTurn(fixture.filePath);
    const before = snapshotCanonical(fixture.filePath);

    const result = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        escalationFacts("escalate-unsafe-1", 1000),
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const receipt = result.value.receipt;
    expect(receipt.refused).toBe(false);
    expect(receipt.refuseCode).toBeNull();
    expect(receipt.outcome).toBe("compact_preserve_tool_escalated");
    expect(receipt.reliefPath).toBe("host_validation_awaiting");
    expect(receipt.protectedToolCallIds).toEqual([PROTECTED_ID]);

    expect(receipt.warnings.map((w) => w.code)).toEqual(["unsafe_runway_projection"]);
    expect(receipt.pressure.projectedPressureSafe).toBe(false);
    expect(receipt.pressure.projectedPressureTokens).not.toBeNull();
    expect(receipt.pressure.projectedPressureTokens!).toBeLessThan(receipt.pressure.nextRequestPressureTokens!);

    expect(receipt.effects.some((e) => e.type === "insert_continuation_marker")).toBe(true);
    expect(receipt.effects.some((e) => e.type === "preserve_tool_pairs_verbatim")).toBe(true);
    expect(receipt.effects.some((e) => e.type === "advance_visibility_boundary")).toBe(true);
    expect(receipt.effects.some((e) => e.type === "install_serving_view")).toBe(true);
    expect(receipt.residual.markerPersisted).toBe(true);
    expect(receipt.residual.markerServed).toBe(true);
    expect(receipt.residual.priorServingViewIntact).toBe(false);
    expect(receipt.residual.visibilityBoundaryAfter).not.toBeNull();
    expect(receipt.residual.visibilityBoundaryAfter!).toBeGreaterThan(receipt.residual.visibilityBoundaryBefore ?? 0);

    const after = snapshotCanonical(fixture.filePath);
    expect(after.turnCount).toBe(before.turnCount + 1);
    expect(after.markerCount).toBe(1);
    expect(after.viewId).not.toBe(before.viewId);

    const listed = await messages.list({ filePath: fixture.filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const protectedResult = listed.value.find(
      (m) => m.kind === "tool_result" && m.blocks.some((b) => b.content["toolCallId"] === PROTECTED_ID),
    );
    expect(protectedResult?.blocks[0]?.content["content"]).toBe("protected verbatim payload");

    expect(receipt.residual.hostValidationStatus).toBe("awaiting");
    expect(receipt.residual.nextProviderRequestAllowed).toBe(false);
    const ack = await compactContinuation.recordCompactContinuationHostValidation(
      { filePath: fixture.filePath },
      "escalate-unsafe-1",
      "ok",
    );
    expect(ack.ok).toBe(true);
    const hv = await compactContinuation.getCompactContinuationHostValidation(
      { filePath: fixture.filePath },
      "escalate-unsafe-1",
    );
    expect(hv.ok).toBe(true);
    if (!hv.ok) return;
    expect(hv.value?.status).toBe("ok");
  });

  it("successful escalation finalizes complete/install_succeeded; terminal, idempotent replay", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedEscalationTurn(fixture.filePath);

    const result = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        escalationFacts("escalate-finalize-1", 298000),
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.receipt.outcome).toBe("compact_preserve_tool_escalated");
    expect(result.value.receipt.residual.markerPersisted).toBe(true);
    expect(result.value.receipt.residual.markerServed).toBe(true);

    expect(result.value.pendingBoundary).toBeNull();
    const db = openRaw(fixture.filePath);
    let row: { status: string; last_stage: string };
    try {
      row = db
        .prepare(`SELECT status, last_stage FROM compact_continuation_boundary ORDER BY forced_at DESC LIMIT 1`)
        .get() as { status: string; last_stage: string };
    } finally {
      db.close();
    }
    expect(row.status).toBe("complete");
    expect(row.last_stage).toBe("install_succeeded");

    const stored = await compactContinuation.getCompactContinuationReceipt(
      { filePath: fixture.filePath },
      "escalate-finalize-1",
    );
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.value?.terminal).toBe(true);
    expect(stored.value?.receipt.outcome).toBe("compact_preserve_tool_escalated");

    const before = snapshotCanonical(fixture.filePath);
    const replay = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        escalationFacts("escalate-finalize-1", 298000),
      ),
    );
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.replayedTerminalAttempt).toBe(true);
    expect(replay.value.receipt.outcome).toBe("compact_preserve_tool_escalated");
    const after = snapshotCanonical(fixture.filePath);
    expect(after.turnCount).toBe(before.turnCount);
    expect(after.markerCount).toBe(before.markerCount);
    expect(after.viewId).toBe(before.viewId);
  });

  it("stale_boundary_preview_is_clamped_to_prepared_compact_point", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedEscalationTurn(fixture.filePath);
    const describedBefore = await fixture.sdk.threadView.describe({ filePath: fixture.filePath });
    const storedPoint = (describedBefore.ok ? describedBefore.value?.compactPoint : 0) ?? 0;
    const prepared = await fixture.sdk.threadView.prepareCompact({ filePath: fixture.filePath });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const preview = await fixture.sdk.threadView.previewProtectedBoundary(
      { filePath: fixture.filePath },
      { protectedToolCallIds: [PROTECTED_ID], targetZoneTokens: 10_000_000 },
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(prepared.value.selection.compactPoint).toBeGreaterThan(storedPoint);
    expect(preview.value.proposedBoundary).toBeLessThan(prepared.value.selection.compactPoint);

    const result = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        (() => {
          const { compact: _compact, ...rest } = escalationFacts("stale-boundary-clamp-1", 10_000_000);
          return rest;
        })(),
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const compactPoint = result.value.receipt.effects.find(
      (e) => e.type === "advance_visibility_boundary",
    )?.compactPoint;
    const after = result.value.receipt.residual.visibilityBoundaryAfter ?? preview.value.proposedBoundary;
    expect(after).toBeLessThan(prepared.value.selection.compactPoint);
    if (compactPoint !== undefined) {
      expect(compactPoint).toBeLessThanOrEqual(after);
    }
  });

  it("protected pair stays in the full tail when compactPointUpperBound is the visibility boundary", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedEscalationTurn(fixture.filePath);
    const result = await withEstimator(o200k, () =>
      compactContinuation.runCompactContinuation(
        { filePath: fixture.filePath },
        (() => {
          const { compact: _compact, ...rest } = escalationFacts("protected-tail-bound-1", 298000);
          return rest;
        })(),
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const listed = await messages.list({ filePath: fixture.filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const protectedResult = listed.value.find(
      (m) => m.kind === "tool_result" && m.blocks.some((b) => b.content["toolCallId"] === PROTECTED_ID),
    );
    expect(protectedResult).toBeDefined();
    const compactPoint = result.value.receipt.effects.find(
      (e) => e.type === "advance_visibility_boundary",
    )?.compactPoint;
    const after = result.value.receipt.residual.visibilityBoundaryAfter;
    expect(compactPoint).toBeDefined();
    expect(after).not.toBeNull();
    expect(compactPoint!).toBeLessThanOrEqual(after!);
  });
});
