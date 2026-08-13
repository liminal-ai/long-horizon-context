/**
 * LIM-61: staged compact-continuation runtime against real thread state.
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
  threads,
  turns,
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
  // Populated open turn so force_turn_end has members to close.
  const batch = await intakeStream.messageEvents({ filePath }, [
    validEvent("user_prompt", { payload: { text: "continue the investigation" } }),
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

describe("LIM-61 compact-continuation runtime", () => {
  it("below trigger / no authoritative usage: no mutation", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    const beforeTurns = await turns.listTurns({ filePath: fixture.filePath });
    expect(beforeTurns.ok).toBe(true);
    if (!beforeTurns.ok) return;
    const turnCount = beforeTurns.value.length;
    const viewBefore = await fixture.sdk.threadView.describe({ filePath: fixture.filePath });

    const below = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({
        attemptId: "below-1",
        continuation: { kind: "active_non_tool" },
        providerUsage: {
          available: true,
          inputTokens: 1000,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          total: 1000,
          domain: "provider_reported_input",
        },
        postMeasurementEstimate: { tokens: 0, source: "lhc_token_estimate", domain: "source_labelled_estimate" },
        policy: { upperTriggerTokens: 100000, lowerTargetTokens: 400, hostCapability: "full_state_machine" },
      }),
    );
    expect(below.ok).toBe(true);
    if (!below.ok) return;
    expect(below.value.receipt.outcome).toBe("continue_normal");
    expect(below.value.receipt.residual.nextProviderRequestAllowed).toBe(true);

    const noUsage = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({
        attemptId: "no-usage-1",
        continuation: { kind: "active_non_tool" },
        providerUsage: { available: false, reason: "missing", domain: "provider_reported_input" },
      }),
    );
    expect(noUsage.ok).toBe(true);
    if (!noUsage.ok) return;
    expect(noUsage.value.receipt.outcome).toBe("continue_normal");

    const afterTurns = await turns.listTurns({ filePath: fixture.filePath });
    expect(afterTurns.ok).toBe(true);
    if (!afterTurns.ok) return;
    expect(afterTurns.value.length).toBe(turnCount);
    const viewAfter = await fixture.sdk.threadView.describe({ filePath: fixture.filePath });
    expect(viewAfter).toEqual(viewBefore);
  });

  it("normal completion creates no continuation turn", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    const before = await turns.listTurns({ filePath: fixture.filePath });
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    const result = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({
        attemptId: "complete-1",
        continuation: { kind: "none" },
        providerUsage: {
          available: true,
          inputTokens: 90000,
          cacheCreationTokens: 5000,
          cacheReadTokens: 10000,
          total: 105000,
          domain: "provider_reported_input",
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.receipt.outcome).toBe("normal_complete");
    expect(result.value.receipt.continuation.opened).toBe(false);
    expect(result.value.forcedBoundaryThisAttempt).toBe(false);

    const after = await turns.listTurns({ filePath: fixture.filePath });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.length).toBe(before.value.length);
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

    expect(result.value.receipt.outcome).toMatch(/compact_continue_turn|degraded_compact|no_reduction/);
    expect(result.value.forcedBoundaryThisAttempt).toBe(true);
    expect(result.value.continuationTurnId).toMatch(/^t\d+$/);
    expect(result.value.receipt.residual.forcedContinuationBoundaryApplied).toBe(true);
    expect(result.value.receipt.residual.continuationTurnOpened).toBe(true);
    expect(result.value.receipt.turnEndReason).toBe(CONTEXT_COMPACT_CONTINUE_REASON);

    const cTurnId = result.value.continuationTurnId!;
    const hasMarker = await compactContinuation.hasCompactContinuationMarker({ filePath: fixture.filePath }, cTurnId);
    expect(hasMarker.ok).toBe(true);
    if (!hasMarker.ok) return;
    expect(hasMarker.value).toBe(true);
    expect(result.value.markerPersisted).toBe(true);

    // Ordinary user chat hides the marker.
    const userChat = await messages.list({ filePath: fixture.filePath }, { forUserChat: true });
    expect(userChat.ok).toBe(true);
    if (!userChat.ok) return;
    expect(userChat.value.every((m) => m.kind !== "compact_continuation_marker")).toBe(true);

    // Default list / inspect still sees it.
    const all = await messages.list({ filePath: fixture.filePath });
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    const markers = all.value.filter((m) => m.kind === "compact_continuation_marker");
    expect(markers).toHaveLength(1);
    expect(markers[0]?.blocks[0]?.blockType).toBe("compact_continuation_marker");

    // Model-serving representation includes the marker text.
    const ctx = await fixture.sdk.threadView.getLlmRequestContext({ filePath: fixture.filePath });
    expect(ctx.ok).toBe(true);
    if (!ctx.ok) return;
    const joined = ctx.value.messages.map((m) => m.content.map((c) => c.text).join("")).join("\n");
    expect(joined).toContain("[compact continuation]");
    expect(joined).toContain(`continuationTurnId=${cTurnId}`);

    // Exactly one empty continuation turn (marker may be sole member).
    const turnList = await turns.listTurns({ filePath: fixture.filePath });
    expect(turnList.ok).toBe(true);
    if (!turnList.ok) return;
    const open = turnList.value.filter((t) => t.status === "open");
    expect(open).toHaveLength(1);
    expect(open[0]?.turnId).toBe(cTurnId);

    // Durable receipt readback.
    const stored = await compactContinuation.getCompactContinuationReceipt(
      { filePath: fixture.filePath },
      "active-success-1",
    );
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.value?.receipt.outcome).toBe(result.value.receipt.outcome);
    expect(stored.value?.continuationTurnId).toBe(cTurnId);

    // No empty extra continuation turn beyond the one boundary.
    const forceEffects = result.value.receipt.effects.filter((e) => e.type === "force_turn_end");
    expect(forceEffects).toHaveLength(1);
  });

  it("repeated compactions in one thread create distinct markers", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedOpenAgenticTurn(fixture.filePath);

    const first = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({ attemptId: "repeat-1" }),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const tA = first.value.continuationTurnId!;

    // Populate the continuation turn so the next force can close it.
    await seedOpenAgenticTurn(fixture.filePath);

    const second = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({ attemptId: "repeat-2" }),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const tB = second.value.continuationTurnId!;

    expect(tA).not.toBe(tB);
    expect(compactContinuationMarkerIdempotencyKey(tA)).not.toBe(compactContinuationMarkerIdempotencyKey(tB));

    const all = await messages.list({ filePath: fixture.filePath });
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    const markers = all.value.filter((m) => m.kind === "compact_continuation_marker");
    expect(markers.length).toBeGreaterThanOrEqual(2);
    const turnIds = new Set(markers.map((m) => String(m.blocks[0]?.content["continuationTurnId"] ?? "")));
    expect(turnIds.has(tA)).toBe(true);
    expect(turnIds.has(tB)).toBe(true);
  });

  it("tool-result branch: compact success preserves tool pair; no marker", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    const toolCallId = "call-preserve-1";
    await seedPendingToolTurn(fixture.filePath, toolCallId);

    const result = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({
        attemptId: "tool-success-1",
        continuation: {
          kind: "pending_correlated_tool_result",
          toolCallId,
          correlationValid: true,
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(["compact_preserve_tool", "degraded_compact", "no_reduction"]).toContain(result.value.receipt.outcome);
    expect(result.value.forcedBoundaryThisAttempt).toBe(false);
    expect(result.value.receipt.residual.originalAgenticTurnStillOpen).toBe(true);
    expect(result.value.receipt.effects.some((e) => e.type === "insert_continuation_marker")).toBe(false);
    expect(result.value.receipt.effects.some((e) => e.type === "preserve_tool_pair_verbatim")).toBe(true);

    const listed = await messages.list({ filePath: fixture.filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const toolMsgs = listed.value.filter((m) => m.kind === "tool_call" || m.kind === "tool_result");
    const pair = toolMsgs.filter((m) => m.blocks.some((b) => b.content["toolCallId"] === toolCallId));
    expect(pair.some((m) => m.kind === "tool_call")).toBe(true);
    expect(pair.some((m) => m.kind === "tool_result")).toBe(true);
    const resultMsg = pair.find((m) => m.kind === "tool_result");
    expect(resultMsg?.blocks[0]?.content["content"]).toBe("tool result verbatim payload that must survive");

    // No orphaned pair: both present, same id.
    expect(pair).toHaveLength(2);
  });

  it("tool-result branch: install failure keeps prior view and pair; no marker", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    // Install a baseline view first.
    const baseline = await fixture.sdk.threadView.compact(
      { filePath: fixture.filePath },
      { params: { lowerBound: 400, percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 } } },
    );
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;
    const viewIdBefore = baseline.value.viewId;

    const toolCallId = "call-preserve-install-fail";
    await seedPendingToolTurn(fixture.filePath, toolCallId);

    const result = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({
        attemptId: "tool-install-fail-1",
        continuation: {
          kind: "pending_correlated_tool_result",
          toolCallId,
          correlationValid: true,
        },
        testHooks: { failInstallBeforeWrite: true },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.receipt.outcome).toBe("refuse");
    expect(result.value.receipt.refuseCode).toBe("install_failed");
    expect(result.value.receipt.residual.priorServingViewIntact).toBe(true);
    expect(result.value.receipt.residual.originalAgenticTurnStillOpen).toBe(true);

    const described = await fixture.sdk.threadView.describe({ filePath: fixture.filePath });
    expect(described.ok).toBe(true);
    if (!described.ok) return;
    expect(described.value?.viewId).toBe(viewIdBefore);
  });

  it("tool-result branch: compact failure refuses with prior view intact", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    const toolCallId = "call-preserve-compact-fail";
    await seedPendingToolTurn(fixture.filePath, toolCallId);

    const result = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({
        attemptId: "tool-compact-fail-1",
        continuation: {
          kind: "pending_correlated_tool_result",
          toolCallId,
          correlationValid: true,
        },
        testHooks: {
          skipRealCompact: true,
          forceCompactStructurallyValid: false,
          forceCanProduceValidProviderRequest: false,
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.receipt.outcome).toBe("refuse");
    expect(["compact_failed", "no_valid_provider_request"]).toContain(result.value.receipt.refuseCode);
    expect(result.value.receipt.residual.priorServingViewIntact).toBe(true);
    expect(result.value.receipt.effects.some((e) => e.type === "insert_continuation_marker")).toBe(false);
  });

  it("tool-result branch: degraded success still installs; no marker", async () => {
    const fixture = await derivedThreadFixture(store, { failures: true });
    const toolCallId = "call-preserve-degraded";
    await seedPendingToolTurn(fixture.filePath, toolCallId);

    const result = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({
        attemptId: "tool-degraded-1",
        continuation: {
          kind: "pending_correlated_tool_result",
          toolCallId,
          correlationValid: true,
        },
        testHooks: { forceDerivationsMissingOrFailed: true },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Degraded may still be compact_preserve_tool or degraded_compact depending on material.
    expect(result.value.receipt.refused).toBe(false);
    expect(result.value.receipt.effects.some((e) => e.type === "insert_continuation_marker")).toBe(false);
  });

  it("tool-result branch: no useful reduction is not a hard failure", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    const toolCallId = "call-preserve-no-red";
    await seedPendingToolTurn(fixture.filePath, toolCallId);

    const result = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({
        attemptId: "tool-no-red-1",
        continuation: {
          kind: "pending_correlated_tool_result",
          toolCallId,
          correlationValid: true,
        },
        testHooks: {
          skipRealCompact: true,
          forceUsefulReduction: false,
          forceInstallSucceeds: true,
          forceCompactStructurallyValid: true,
          forceCanProduceValidProviderRequest: true,
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.receipt.outcome).toBe("no_reduction");
    expect(result.value.receipt.refused).toBe(false);
  });

  it("active branch: install failure keeps marker persisted, prior view intact", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    const baseline = await fixture.sdk.threadView.compact(
      { filePath: fixture.filePath },
      { params: { lowerBound: 400, percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 } } },
    );
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;
    const viewIdBefore = baseline.value.viewId;

    await seedOpenAgenticTurn(fixture.filePath);
    const result = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({
        attemptId: "active-install-fail-1",
        testHooks: { failInstallBeforeWrite: true },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.receipt.outcome).toBe("refuse");
    expect(result.value.receipt.refuseCode).toBe("install_failed");
    expect(result.value.receipt.residual.markerPersisted).toBe(true);
    expect(result.value.receipt.residual.markerServed).toBe(false);
    expect(result.value.receipt.residual.priorServingViewIntact).toBe(true);
    expect(result.value.forcedBoundaryThisAttempt).toBe(true);

    const described = await fixture.sdk.threadView.describe({ filePath: fixture.filePath });
    expect(described.ok).toBe(true);
    if (!described.ok) return;
    expect(described.value?.viewId).toBe(viewIdBefore);
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

    const turnList1 = await turns.listTurns({ filePath: fixture.filePath });
    expect(turnList1.ok).toBe(true);
    if (!turnList1.ok) return;
    const closedWithReason = turnList1.value.filter((t) => t.outcomeReason === CONTEXT_COMPACT_CONTINUE_REASON);
    expect(closedWithReason.length).toBe(1);

    // Repair: same attempt id, writerClaim lhc-compatible (none after release).
    const repaired = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({
        attemptId: "repair-boundary-1b",
        continuation: { kind: "active_non_tool" },
      }),
    );
    expect(repaired.ok).toBe(true);
    if (!repaired.ok) return;
    // Second call must not force another boundary.
    expect(repaired.value.forcedBoundaryThisAttempt).toBe(false);
    expect(repaired.value.continuationTurnId).toBe(cTurnId);

    const turnList2 = await turns.listTurns({ filePath: fixture.filePath });
    expect(turnList2.ok).toBe(true);
    if (!turnList2.ok) return;
    const closed2 = turnList2.value.filter((t) => t.outcomeReason === CONTEXT_COMPACT_CONTINUE_REASON);
    expect(closed2.length).toBe(1);
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

    const listed1 = await messages.list({ filePath: fixture.filePath });
    expect(listed1.ok).toBe(true);
    if (!listed1.ok) return;
    const markers1 = listed1.value.filter((m) => m.kind === "compact_continuation_marker");
    expect(markers1).toHaveLength(1);

    const repaired = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({
        attemptId: "repair-marker-2",
        continuation: { kind: "active_non_tool" },
      }),
    );
    expect(repaired.ok).toBe(true);
    if (!repaired.ok) return;
    expect(repaired.value.forcedBoundaryThisAttempt).toBe(false);

    const listed2 = await messages.list({ filePath: fixture.filePath });
    expect(listed2.ok).toBe(true);
    if (!listed2.ok) return;
    const markers2 = listed2.value.filter((m) => m.kind === "compact_continuation_marker");
    expect(markers2).toHaveLength(1);
    expect(markers2[0]?.blocks[0]?.content["continuationTurnId"]).toBe(cTurnId);

    // Idempotency key was reasserted (skip on intake), not duplicated.
    const events = await intakeStream.listEvents({ filePath: fixture.filePath });
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    const key = compactContinuationMarkerIdempotencyKey(cTurnId);
    const keyHits = events.value.filter((e) => e.idempotencyKey === key);
    expect(keyHits).toHaveLength(1);
  });

  it("repair after failed install is idempotent", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedOpenAgenticTurn(fixture.filePath);

    const first = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({
        attemptId: "repair-install-1",
        testHooks: { failInstallBeforeWrite: true },
      }),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.receipt.refuseCode).toBe("install_failed");
    const cTurnId = first.value.continuationTurnId!;

    const second = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({
        attemptId: "repair-install-2",
        // Allow install on repair.
      }),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.forcedBoundaryThisAttempt).toBe(false);
    expect(second.value.continuationTurnId).toBe(cTurnId);
    // Marker still single.
    const listed = await messages.list({ filePath: fixture.filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.filter((m) => m.kind === "compact_continuation_marker")).toHaveLength(1);
  });

  it("input epoch change skips without mutation; writer released out-of-band when held", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    const before = await turns.listTurns({ filePath: fixture.filePath });
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    // Simulate held claim then skip.
    const db = openRaw(fixture.filePath);
    try {
      db.prepare(
        `UPDATE compact_continuation_writer SET claim = 'lhc', attempt_id = ?, claimed_at = ? WHERE singleton = 1`,
      ).run("epoch-skip-1", new Date().toISOString());
    } finally {
      db.close();
    }

    const result = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({
        attemptId: "epoch-skip-1",
        writerClaim: "lhc",
        seam: {
          ...SETTLED_SEAM,
          inputEpochAtDecision: 1,
          inputEpochAtApply: 2,
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.receipt.skipped).toBe(true);
    expect(result.value.receipt.skipCode).toBe("input_epoch_changed");
    expect(result.value.receipt.residual.writerReleased).toBe(true);

    const claim = await compactContinuation.getCompactContinuationWriterClaim({ filePath: fixture.filePath });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    expect(claim.value.claim).toBe("none");

    const after = await turns.listTurns({ filePath: fixture.filePath });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.length).toBe(before.value.length);
  });

  it("writer conflict (native) refuses without claiming LHC", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    const result = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({
        attemptId: "native-1",
        writerClaim: "native",
        continuation: { kind: "active_non_tool" },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.receipt.outcome).toBe("refuse");
    expect(result.value.receipt.refuseCode).toBe("native_writer_conflict");
    expect(result.value.receipt.effects.some((e) => e.type === "claim_writer")).toBe(false);

    const claim = await compactContinuation.getCompactContinuationWriterClaim({ filePath: fixture.filePath });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    expect(claim.value.claim).toBe("none");
  });

  it("structurally invalid install fails closed with prior valid view intact", async () => {
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
        attemptId: "invalid-install-1",
        testHooks: {
          skipRealCompact: true,
          forceCompactStructurallyValid: true,
          forceCanProduceValidProviderRequest: false,
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.receipt.outcome).toBe("refuse");
    expect(result.value.receipt.refuseCode).toBe("no_valid_provider_request");
    expect(result.value.receipt.residual.priorServingViewIntact).toBe(true);

    const described = await fixture.sdk.threadView.describe({ filePath: fixture.filePath });
    expect(described.ok).toBe(true);
    if (!described.ok) return;
    expect(described.value?.viewId).toBe(baseline.value.viewId);
  });

  it("no conversation message created only for telemetry (receipt not in messages)", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedOpenAgenticTurn(fixture.filePath);
    const before = await messages.list({ filePath: fixture.filePath });
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    const result = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({ attemptId: "no-telemetry-msg-1" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const after = await messages.list({ filePath: fixture.filePath });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    // New messages may include marker only — never a receipt dump.
    const newOnes = after.value.slice(before.value.length);
    for (const m of newOnes) {
      expect(
        m.kind === "compact_continuation_marker" ||
          m.kind === "user_prompt" ||
          m.kind === "assistant_text" ||
          m.kind === "tool_call" ||
          m.kind === "tool_result",
      ).toBe(true);
      if (m.kind === "compact_continuation_marker") {
        expect(m.blocks[0]?.content["cause"]).toBe("context_compacted_task_in_progress");
      }
    }
    // Receipt lives in its own table.
    const receipts = await compactContinuation.listCompactContinuationReceipts({ filePath: fixture.filePath });
    expect(receipts.ok).toBe(true);
    if (!receipts.ok) return;
    expect(receipts.value.some((r) => r.attemptId === "no-telemetry-msg-1")).toBe(true);
  });

  it("refuse-receipt fidelity describes installed view only", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedOpenAgenticTurn(fixture.filePath);
    const result = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({
        attemptId: "fidelity-note-1",
        testHooks: {
          failInstallBeforeWrite: true,
          forceDerivationsMissingOrFailed: true,
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.refuseReceiptFidelityDescribes).toBe("installed_view_only");
    if (result.value.receipt.refused) {
      // Oracle hardcodes full fidelity on refuse even if degrade effect present.
      expect(result.value.receipt.fidelity).toBe("full");
    }
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
