/**
 * LIM-80 Slice 2: crash seams closed by durable state alone.
 *
 * Every recovery decision after "restart" is derived from the reopened attempt
 * store + fresh filesystem/SDK observations. No process-local value from before
 * the crash is passed into recovery.
 *
 * Seam A: crash after SDK compact install, before the attempt advanced to
 *         view_installed — the operation_claimed baseline vs the current stored
 *         view proves the install; reconcile, never compact again.
 * Seam B: crash after the rollout file was written, before rollout_written —
 *         only reservedSessionId/path/receipt are durable; the present file is
 *         inspected and reused, never rewritten.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeterministicInferenceCallbacks, initLhc, type ThreadRef, threads } from "lhc";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LhcCommandRuntime } from "../../src/commands/dispatch.js";
import {
  captureViewBaselineFingerprint,
  materializeRolloutFromInstalledView,
  observeCurrentStoredView,
  recoverReservedRollout,
} from "../../src/commands/recovery-ops.js";
import { openGovernorReceiptStore } from "../../src/governor/receipt-store.js";
import { planRecovery } from "../../src/governor/recovery.js";
import type { GovernorObserveRecord } from "../../src/governor/types.js";
import { encodeProjectPath } from "../../src/rollout/discover.js";
import { rolloutPathForSession } from "../../src/rollout/sessions-index.js";

const SELF = { pid: 4242, bootId: "boot-seam", starttime: "77" };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

function fakeSettledWouldCompact(): GovernorObserveRecord {
  return {
    event: "governor_observe",
    hostCapability: "capability_limited",
    observePhase: "settled_seam",
    decision: "would_compact",
    reason: "test",
    providerContextTotal: 400_000,
    providerContext: null,
    postMeasurementEstimate: { tokens: 0, source: "lhc_token_estimate", domain: "source_labelled_estimate" },
    pressure: {
      providerBaseTokens: 400_000,
      providerBaseDomain: "provider_reported_input",
      estimateTokens: 0,
      estimateSource: "lhc_token_estimate",
      estimateDomain: "source_labelled_estimate",
      nextRequestPressureTokens: 400_000,
      upperTriggerTokens: 360_000,
      atOrAboveTrigger: true,
    },
    upperBoundTokens: 360_000,
    lowerBoundTokens: 180_000,
    profile: "continuation",
    autoCompactIntent: true,
    observeOnly: false,
    wouldMutate: true,
    policyArmed: true,
    policySourcesSummary: "builtin",
    captureGeneration: 1,
    inputEpoch: 1,
    inputEpochAtTurnOpen: 1,
    observeSequence: 1,
    settleSequence: 1,
    samplingId: "s1",
  };
}

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "cc-lhc-seam-"));
  dirs.push(root);
  const projectsRoot = join(root, "projects");
  const cwd = join(root, "work");
  const filePath = join(root, "thread.sqlite");
  const registryPath = join(root, "registry.sqlite");
  const receiptDb = join(root, "cc-lhc.sqlite");
  const created = await threads.newThread({ filePath, registryPath });
  if (!created.ok) throw new Error(created.error.reason);
  const sdk = initLhc({ mode: "manual", inferenceCallbacks: createDeterministicInferenceCallbacks() });
  const threadRef = { filePath } as unknown as ThreadRef;
  for (let i = 0; i < 6; i += 1) {
    const send = await sdk.intakeStream.messageEvents({ filePath }, [
      {
        eventKind: "user_prompt",
        idempotencyKey: `u${i}`,
        actor: "user",
        harness: "cc",
        payload: { text: `p${i} ${"x".repeat(60)}` },
      },
      {
        eventKind: "assistant_text",
        idempotencyKey: `a${i}`,
        actor: "assistant",
        harness: "cc",
        payload: { text: `a${i} ${"y".repeat(60)}` },
      },
      { eventKind: "turn_end", idempotencyKey: `e${i}`, actor: "system", harness: "cc", payload: {} },
    ]);
    if (!send.ok) throw new Error(send.error.reason);
  }
  const drained = await sdk.work.drain({ filePath });
  if (!drained.ok) throw new Error(drained.error.reason);
  const runtime: LhcCommandRuntime = {
    captureDisabled: false,
    stats: { threadId: created.value.threadId } as unknown as LhcCommandRuntime["stats"],
    sdk,
    threadRef,
    cwd,
    sourceRolloutPath: undefined,
    sourceSessionId: "old-session",
  };
  const store = openGovernorReceiptStore(receiptDb);
  const receiptId = store.appendObserve({
    observe: fakeSettledWouldCompact(),
    sessionId: "old-session",
    threadId: created.value.threadId,
  }).receipt.receiptId;
  return { sdk, threadRef, runtime, store, receiptId, projectsRoot, cwd, receiptDb };
}

describe("recovery crash seams from durable state (LIM-80 Slice 2)", () => {
  it("Seam A: crash after install before view_installed → reconcile via baseline, zero second compact", async () => {
    const { sdk, threadRef, runtime, store, receiptId, receiptDb, projectsRoot } = await setup();
    const claimed = store.claimAttempt({ receiptId, owner: SELF });
    if (claimed.kind !== "claimed") throw new Error("claim failed");
    const baseline = await captureViewBaselineFingerprint(sdk, threadRef);
    store.advanceAttempt({
      receiptId,
      attemptId: claimed.attempt.attemptId,
      stage: "operation_claimed",
      artifacts: { preMutationViewFingerprint: baseline },
    });

    // SDK compact installs the view, then the process crashes before advance.
    const compact = await sdk.threadView.compact(threadRef, { profile: "continuation", params: { lowerBound: 200 } });
    expect(compact.ok).toBe(true);
    store.close();

    // Restart: durable attempt is still operation_claimed; recovery reads the
    // current stored view fresh (no process-local fingerprint).
    const reopened = openGovernorReceiptStore(receiptDb);
    const attempt = reopened.getAttempt(receiptId);
    expect(attempt?.stage).toBe("operation_claimed");
    const currentView = await observeCurrentStoredView(sdk, threadRef);
    const plan = planRecovery({
      receiptId,
      handoffOutcome: reopened.getById(receiptId)!.handoffOutcome,
      attempt,
      observed: { self: SELF, currentView },
    });
    expect(plan.kind).toBe("reconcile_installed_view");

    // Reconcile: expected fingerprint is the freshly observed current view.
    if (currentView.kind !== "present") throw new Error("expected installed view");
    const previewSpy = vi.spyOn(sdk.threadView, "previewCompact");
    const compactSpy = vi.spyOn(sdk.threadView, "compact");
    const reservedSessionId = "aaaa1111-2222-3333-4444-555566667777";
    const materialized = await materializeRolloutFromInstalledView({
      runtime,
      reservedSessionId,
      reservedRolloutPath: rolloutPathForSession(projectsRoot, runtime.cwd, reservedSessionId),
      expectedInstalledFingerprint: currentView.fingerprint,
      durableReceiptText: "[lhc compact:auto] recovered",
      operation: "auto_compact",
      projectsRoot,
    });
    expect(materialized.kind).toBe("materialized");
    expect(compactSpy).not.toHaveBeenCalled();
    expect(previewSpy).not.toHaveBeenCalled();
    reopened.close();
  });

  it("Seam A negative: crash before install (no view landed) → reprepare, compact is legal", async () => {
    const { sdk, threadRef, store, receiptId, receiptDb } = await setup();
    const claimed = store.claimAttempt({ receiptId, owner: SELF });
    if (claimed.kind !== "claimed") throw new Error("claim failed");
    const baseline = await captureViewBaselineFingerprint(sdk, threadRef);
    store.advanceAttempt({
      receiptId,
      attemptId: claimed.attempt.attemptId,
      stage: "operation_claimed",
      artifacts: { preMutationViewFingerprint: baseline },
    });
    store.close();

    const reopened = openGovernorReceiptStore(receiptDb);
    const currentView = await observeCurrentStoredView(sdk, threadRef);
    expect(currentView.kind).toBe("none");
    const plan = planRecovery({
      receiptId,
      handoffOutcome: reopened.getById(receiptId)!.handoffOutcome,
      attempt: reopened.getAttempt(receiptId),
      observed: { self: SELF, currentView },
    });
    expect(plan.kind).toBe("reprepare_from_scratch");
    reopened.close();
  });

  it("Seam B: crash after write before rollout_written → durable reservation only; present file reused, not rewritten", async () => {
    const { sdk, threadRef, runtime, store, receiptId, projectsRoot, cwd, receiptDb } = await setup();
    const claimed = store.claimAttempt({ receiptId, owner: SELF });
    if (claimed.kind !== "claimed") throw new Error("claim failed");
    const compact = await sdk.threadView.compact(threadRef, { profile: "continuation", params: { lowerBound: 200 } });
    expect(compact.ok).toBe(true);
    const view = await observeCurrentStoredView(sdk, threadRef);
    if (view.kind !== "present") throw new Error("expected installed view");

    const reservedSessionId = "beefbeef-1111-2222-3333-444455556666";
    const reservedRolloutPath = rolloutPathForSession(projectsRoot, cwd, reservedSessionId);
    const receipt = "[lhc compact:auto] written";
    // Reservation is what would be durably persisted BEFORE the write.
    store.advanceAttempt({
      receiptId,
      attemptId: claimed.attempt.attemptId,
      stage: "view_installed",
      artifacts: {
        viewId: view.viewId,
        installedViewFingerprint: view.fingerprint,
        rebuiltSessionId: reservedSessionId,
        rebuiltRolloutPath: reservedRolloutPath,
        durableReceipt: receipt,
      },
    });
    // Write the file, then crash before recording rollout_written.
    const written = await materializeRolloutFromInstalledView({
      runtime,
      reservedSessionId,
      reservedRolloutPath,
      expectedInstalledFingerprint: view.fingerprint,
      durableReceiptText: receipt,
      operation: "auto_compact",
      projectsRoot,
    });
    if (written.kind !== "materialized") throw new Error("write failed");
    const fileBefore = readFileSync(reservedRolloutPath, "utf8");
    store.close();

    // Restart: recovery inputs come ONLY from the reopened attempt artifacts.
    const reopened = openGovernorReceiptStore(receiptDb);
    const artifacts = reopened.getAttempt(receiptId)!.artifacts;
    expect(reopened.getAttempt(receiptId)?.stage).toBe("view_installed");
    expect(artifacts.rebuiltSessionId).toBe(reservedSessionId);
    // No `recorded` verification exists (crash before rollout_written).
    const recovered = await recoverReservedRollout({
      runtime,
      reservedSessionId: artifacts.rebuiltSessionId!,
      reservedRolloutPath: artifacts.rebuiltRolloutPath!,
      durableReceiptText: artifacts.durableReceipt!,
      expectedInstalledFingerprint: artifacts.installedViewFingerprint!,
      operation: "auto_compact",
      projectsRoot,
    });
    expect(recovered.kind).toBe("reused");
    if (recovered.kind === "reused") expect(recovered.handoff.rebuilt.sessionId).toBe(reservedSessionId);
    expect(readFileSync(reservedRolloutPath, "utf8")).toBe(fileBefore);
    reopened.close();
  });

  it("Seam B negative: crash before write (file absent) → rematerialize to the same reserved id", async () => {
    const { sdk, threadRef, runtime, store, receiptId, projectsRoot, cwd, receiptDb } = await setup();
    const claimed = store.claimAttempt({ receiptId, owner: SELF });
    if (claimed.kind !== "claimed") throw new Error("claim failed");
    const compact = await sdk.threadView.compact(threadRef, { profile: "continuation", params: { lowerBound: 200 } });
    expect(compact.ok).toBe(true);
    const view = await observeCurrentStoredView(sdk, threadRef);
    if (view.kind !== "present") throw new Error("expected installed view");
    const reservedSessionId = "cafecafe-1111-2222-3333-444455556666";
    const reservedRolloutPath = rolloutPathForSession(projectsRoot, cwd, reservedSessionId);
    const receipt = "[lhc compact:auto] never-written";
    store.advanceAttempt({
      receiptId,
      attemptId: claimed.attempt.attemptId,
      stage: "view_installed",
      artifacts: {
        viewId: view.viewId,
        installedViewFingerprint: view.fingerprint,
        rebuiltSessionId: reservedSessionId,
        rebuiltRolloutPath: reservedRolloutPath,
        durableReceipt: receipt,
      },
    });
    store.close();

    const reopened = openGovernorReceiptStore(receiptDb);
    const artifacts = reopened.getAttempt(receiptId)!.artifacts;
    const recovered = await recoverReservedRollout({
      runtime,
      reservedSessionId: artifacts.rebuiltSessionId!,
      reservedRolloutPath: artifacts.rebuiltRolloutPath!,
      durableReceiptText: artifacts.durableReceipt!,
      expectedInstalledFingerprint: artifacts.installedViewFingerprint!,
      operation: "auto_compact",
      projectsRoot,
    });
    expect(recovered.kind).toBe("rematerialized");
    if (recovered.kind === "rematerialized") {
      expect(recovered.rebuilt.sessionId).toBe(reservedSessionId);
      // The rematerialized file also writes its sessions-index entry.
      const buf = await readFile(reservedRolloutPath);
      expect(buf.byteLength).toBeGreaterThan(0);
    }
    void encodeProjectPath;
    reopened.close();
  });
});
