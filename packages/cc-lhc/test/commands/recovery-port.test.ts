/**
 * LIM-80 Slice 3A: concrete store-backed RecoveryPort.
 *
 * The port turns each durable milestone into an advanceAttempt CAS on one owned
 * attempt and is strictly idempotent-or-forward:
 *  - baseline / view_installed / reservation / rollout_written advance stages;
 *  - a reservation is minted once and returned exactly on retry;
 *  - a lost attempt (reclaimed by a new attemptId) or any non-success store
 *    result throws rather than silently continuing;
 *  - it survives a store reopen (durable state, no process memory).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RolloutVerificationArtifacts } from "../../src/commands/recovery-ops.js";
import { createStoreBackedRecoveryPort, RecoveryPortCasError } from "../../src/commands/recovery-port.js";
import { BUILTIN_CONTEXT_POLICY } from "../../src/governor/config.js";
import { applyGovernorLifecycleBatch, createGovernorRuntimeState } from "../../src/governor/observe-state.js";
import { materializeGovernorReceipt, openGovernorReceiptStore } from "../../src/governor/receipt-store.js";
import type { GovernorObserveRecord, ResolvedContextPolicy } from "../../src/governor/types.js";
import { rolloutPathForSession } from "../../src/rollout/sessions-index.js";
import type { ProcessIdentity } from "../../src/runtime/process-identity.js";

const SELF: ProcessIdentity = { pid: 4242, bootId: "boot", starttime: "99" };

function armed(): ResolvedContextPolicy {
  const policy = { ...BUILTIN_CONTEXT_POLICY, autoCompact: true };
  const sources = Object.fromEntries(
    Object.keys(policy).map((k) => [k, "builtin"]),
  ) as ResolvedContextPolicy["sources"];
  return { policy, sources, armed: true, errors: [] };
}

function settledWouldCompact(samplingId = "s1"): GovernorObserveRecord {
  const { observes } = applyGovernorLifecycleBatch(
    createGovernorRuntimeState({ captureHealthy: true, captureGeneration: 3, descriptorReady: true }),
    [
      { kind: "turn_opened", reason: "user_prompt" },
      {
        kind: "sampling_observed",
        samplingId,
        providerUsage: { input_tokens: 200_000, cache_creation_input_tokens: 100_000, cache_read_input_tokens: 80_000 },
      },
      { kind: "post_measurement_estimate", tokens: 5_000, source: "lhc_token_estimate" },
      { kind: "turn_settled", reason: "end_turn" },
    ],
    armed(),
  );
  return observes.filter((o) => o.observePhase === "settled_seam")[0]!;
}

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

function freshDb(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return join(dir, "cc-lhc.sqlite");
}

/** Seed a scheduled receipt and claim one attempt owned by SELF. */
function seedClaimed(dbPath: string) {
  const store = openGovernorReceiptStore(dbPath);
  const receipt = materializeGovernorReceipt({
    observe: settledWouldCompact(),
    sessionId: "old-session",
    threadId: "th1",
    receiptId: "r1",
  });
  // Insert the receipt row via appendObserve then claim.
  store.appendObserve({ observe: receipt.observe, sessionId: "old-session", threadId: "th1" });
  const rows = store.listBySession("old-session");
  const receiptId = rows[0]!.receiptId;
  const claim = store.claimAttempt({ receiptId, owner: SELF });
  if (claim.kind !== "claimed") throw new Error(`expected claimed, got ${claim.kind}`);
  return { store, receiptId, attemptId: claim.attempt.attemptId };
}

const VERIFICATION = (sessionId: string, path: string): RolloutVerificationArtifacts => ({
  rebuiltSessionId: sessionId,
  rebuiltRolloutPath: path,
  rolloutFullSha256: "a".repeat(64),
  rolloutPrefixSha256: "b".repeat(64),
  rolloutPrefixLineCount: 3,
  rolloutPrefixByteLength: 120,
  rolloutLineCount: 4,
  rolloutByteLength: 180,
});

describe("store-backed RecoveryPort (LIM-80 Slice 3A)", () => {
  it("advances baseline → view_installed → reservation → rollout_written and records identity", () => {
    const dbPath = freshDb("cc-lhc-port-");
    const { store, receiptId, attemptId } = seedClaimed(dbPath);
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-port-proj-"));
    dirs.push(projectsRoot);
    let mints = 0;
    const port = createStoreBackedRecoveryPort({
      store,
      receiptId,
      attemptId,
      cwd: "/work/app",
      threadId: "th1",
      oldSessionId: "old-session",
      projectsRoot,
      newSessionId: () => {
        mints += 1;
        return "new-session-xyz";
      },
    });

    port.recordBaseline("baseline-fp");
    let attempt = store.getAttempt(receiptId)!;
    expect(attempt.stage).toBe("operation_claimed");
    expect(attempt.artifacts.preMutationViewFingerprint).toBe("baseline-fp");
    expect(attempt.artifacts.threadId).toBe("th1");
    expect(attempt.artifacts.oldSessionId).toBe("old-session");

    port.recordViewInstalled({ viewId: "v9", installedViewFingerprint: "installed-fp" });
    attempt = store.getAttempt(receiptId)!;
    expect(attempt.stage).toBe("view_installed");
    expect(attempt.artifacts.viewId).toBe("v9");

    const reserved = port.reserveRebuiltSession("[lhc compact:auto] x.");
    expect(reserved.sessionId).toBe("new-session-xyz");
    expect(reserved.rolloutPath).toBe(rolloutPathForSession(projectsRoot, "/work/app", "new-session-xyz"));
    attempt = store.getAttempt(receiptId)!;
    expect(attempt.stage).toBe("view_installed");
    expect(attempt.artifacts.rebuiltSessionId).toBe("new-session-xyz");
    expect(attempt.artifacts.durableReceipt).toBe("[lhc compact:auto] x.");

    port.recordRolloutWritten(VERIFICATION("new-session-xyz", reserved.rolloutPath));
    attempt = store.getAttempt(receiptId)!;
    expect(attempt.stage).toBe("rollout_written");
    expect(attempt.artifacts.rolloutFullSha256).toBe("a".repeat(64));
    expect(mints).toBe(1);
    store.close();
  });

  it("reservation is idempotent: a retry returns the exact existing reservation, minting no new id", () => {
    const dbPath = freshDb("cc-lhc-port-idem-");
    const { store, receiptId, attemptId } = seedClaimed(dbPath);
    let mints = 0;
    const port = createStoreBackedRecoveryPort({
      store,
      receiptId,
      attemptId,
      cwd: "/work/app",
      threadId: "th1",
      oldSessionId: "old-session",
      projectsRoot: "/proj",
      newSessionId: () => {
        mints += 1;
        return `sid-${mints}`;
      },
    });
    port.recordViewInstalled({ viewId: "v1", installedViewFingerprint: "fp" });
    const first = port.reserveRebuiltSession("receipt-text");
    // Idempotent only for the EXACT same durable receipt.
    const second = port.reserveRebuiltSession("receipt-text");
    expect(second).toEqual(first);
    expect(mints).toBe(1);
    store.close();
  });

  it("reservation reuse with a DIFFERENT durable receipt is a correlation conflict (never silently reused)", () => {
    const dbPath = freshDb("cc-lhc-port-mismatch-");
    const { store, receiptId, attemptId } = seedClaimed(dbPath);
    const port = createStoreBackedRecoveryPort({
      store,
      receiptId,
      attemptId,
      cwd: "/work/app",
      threadId: "th1",
      oldSessionId: "old-session",
      projectsRoot: "/proj",
      newSessionId: () => "sid-1",
    });
    port.recordViewInstalled({ viewId: "v1", installedViewFingerprint: "fp" });
    port.reserveRebuiltSession("receipt-A");
    try {
      port.reserveRebuiltSession("receipt-B");
      throw new Error("expected reservation mismatch to throw");
    } catch (cause) {
      expect(cause).toBeInstanceOf(RecoveryPortCasError);
      expect((cause as RecoveryPortCasError).conflict).toBe("reservation_receipt_mismatch");
    }
    store.close();
  });

  it("a partial reservation (id/path present, receipt missing) is structurally invalid", () => {
    const dbPath = freshDb("cc-lhc-port-partial-");
    const { store, receiptId, attemptId } = seedClaimed(dbPath);
    // Simulate a crash that recorded only id+path, not the durable receipt.
    const reservedPath = rolloutPathForSession("/proj", "/work/app", "sid-partial");
    const adv = store.advanceAttempt({
      receiptId,
      attemptId,
      stage: "view_installed",
      artifacts: { rebuiltSessionId: "sid-partial", rebuiltRolloutPath: reservedPath },
    });
    expect(adv.kind).toBe("advanced");
    const port = createStoreBackedRecoveryPort({
      store,
      receiptId,
      attemptId,
      cwd: "/work/app",
      threadId: "th1",
      oldSessionId: "old-session",
      projectsRoot: "/proj",
    });
    try {
      port.reserveRebuiltSession("receipt-x");
      throw new Error("expected partial reservation to throw");
    } catch (cause) {
      expect(cause).toBeInstanceOf(RecoveryPortCasError);
      expect((cause as RecoveryPortCasError).conflict).toBe("reservation_invalid");
    }
    store.close();
  });

  it("survives reopen: a fresh port on the reopened store continues idempotently from durable state", () => {
    const dbPath = freshDb("cc-lhc-port-reopen-");
    const { store, receiptId, attemptId } = seedClaimed(dbPath);
    const port = createStoreBackedRecoveryPort({
      store,
      receiptId,
      attemptId,
      cwd: "/work/app",
      threadId: "th1",
      oldSessionId: "old-session",
      projectsRoot: "/proj",
      newSessionId: () => "sid-1",
    });
    port.recordViewInstalled({ viewId: "v1", installedViewFingerprint: "fp" });
    const reserved = port.reserveRebuiltSession("rx");
    store.close();

    // Reopen: a new port bound to the same receipt+attempt reads the durable
    // reservation and returns the same one (no pre-crash memory).
    const store2 = openGovernorReceiptStore(dbPath);
    const port2 = createStoreBackedRecoveryPort({
      store: store2,
      receiptId,
      attemptId,
      cwd: "/work/app",
      threadId: "th1",
      oldSessionId: "old-session",
      projectsRoot: "/proj",
      newSessionId: () => "sid-DIFFERENT",
    });
    expect(port2.reserveRebuiltSession("rx")).toEqual(reserved);
    store2.close();
  });

  it("throws when the attempt was reclaimed by a new attemptId (ownership lost)", () => {
    const dbPath = freshDb("cc-lhc-port-lost-");
    const { store, receiptId, attemptId } = seedClaimed(dbPath);
    const port = createStoreBackedRecoveryPort({
      store,
      receiptId,
      attemptId,
      cwd: "/work/app",
      threadId: "th1",
      oldSessionId: "old-session",
      projectsRoot: "/proj",
    });
    // A different owner kernel-proven-reclaims the attempt (new attemptId).
    const other: ProcessIdentity = { pid: 5, bootId: "boot", starttime: "1" };
    const reclaim = store.claimAttempt({
      receiptId,
      owner: other,
      reclaim: { expectedAttemptId: attemptId, ownerLiveness: { ok: false, code: "not_found", message: "gone" } },
    });
    expect(reclaim.kind).toBe("reclaimed");
    try {
      port.recordBaseline("fp");
      throw new Error("expected recordBaseline to throw");
    } catch (cause) {
      expect(cause).toBeInstanceOf(RecoveryPortCasError);
      expect((cause as RecoveryPortCasError).conflict).toBe("not_owner");
    }
    try {
      port.reserveRebuiltSession("x");
      throw new Error("expected reserve to throw");
    } catch (cause) {
      expect(cause).toBeInstanceOf(RecoveryPortCasError);
      expect((cause as RecoveryPortCasError).conflict).toBe("not_owner");
    }
    store.close();
  });

  it("throws a typed CAS conflict on a contradictory artifact (installed fingerprint conflict)", () => {
    const dbPath = freshDb("cc-lhc-port-conflict-");
    const { store, receiptId, attemptId } = seedClaimed(dbPath);
    const port = createStoreBackedRecoveryPort({
      store,
      receiptId,
      attemptId,
      cwd: "/work/app",
      threadId: "th1",
      oldSessionId: "old-session",
      projectsRoot: "/proj",
    });
    port.recordViewInstalled({ viewId: "v1", installedViewFingerprint: "fp-A" });
    try {
      port.recordViewInstalled({ viewId: "v1", installedViewFingerprint: "fp-B" });
      throw new Error("expected artifact conflict to throw");
    } catch (cause) {
      expect(cause).toBeInstanceOf(RecoveryPortCasError);
      expect((cause as RecoveryPortCasError).conflict).toBe("artifact_conflict");
    }
    store.close();
  });
});
