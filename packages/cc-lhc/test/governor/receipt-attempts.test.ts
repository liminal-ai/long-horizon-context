/**
 * LIM-80 Slice 1: durable attempt rows in the governor receipt store —
 * additive migration, exact replay, claim/reclaim CAS, monotonic stages,
 * transactional completion, reopen.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { BUILTIN_CONTEXT_POLICY } from "../../src/governor/config.js";
import { applyGovernorLifecycleBatch, createGovernorRuntimeState } from "../../src/governor/observe-state.js";
import { isTerminalHandoffOutcome, openGovernorReceiptStore } from "../../src/governor/receipt-store.js";
import {
  activeReplacementIdentity,
  planRecovery,
  type ReplacementGenerationEvent,
} from "../../src/governor/recovery.js";
import type { GovernorObserveRecord, ResolvedContextPolicy } from "../../src/governor/types.js";
import type { ProcessIdentity, ProcessLivenessResult } from "../../src/runtime/process-identity.js";

const A: ProcessIdentity = { pid: 1001, bootId: "boot", starttime: "10" };
const B: ProcessIdentity = { pid: 1002, bootId: "boot", starttime: "20" };
const DEAD: ProcessLivenessResult = { ok: false, code: "not_found", message: "gone" };
const UNSURE: ProcessLivenessResult = { ok: false, code: "indeterminate", message: "eperm" };
const LIVE_A: ProcessLivenessResult = { ok: true, identity: A };

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

describe("governor receipt attempts (LIM-80 Slice 1)", () => {
  it("additive migration: a pre-Slice-1 database with a scheduled row reopens as unclaimed recoverable work", () => {
    const dbPath = freshDb("cc-lhc-attempt-migrate-");
    // Simulate the old schema: create the receipts table WITHOUT the attempts table.
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE cc_governor_receipts (
        receipt_id TEXT PRIMARY KEY, session_id TEXT, thread_id TEXT,
        observe_sequence INTEGER NOT NULL, settle_sequence INTEGER, capture_generation INTEGER NOT NULL,
        decision TEXT NOT NULL, would_mutate INTEGER NOT NULL, observe_phase TEXT NOT NULL,
        payload_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, replay_key TEXT
      )
    `);
    raw.close();

    const store = openGovernorReceiptStore(dbPath);
    const settled = settledWouldCompact();
    const inserted = store.appendObserve({ observe: settled, sessionId: "old", threadId: "th" });
    expect(inserted.inserted).toBe(true);
    expect(inserted.receipt.handoffOutcome?.kind).toBe("scheduled");
    store.close();

    // Reopen: schema adds the attempts table; the old scheduled row is not corruption.
    const reopened = openGovernorReceiptStore(dbPath);
    const receipt = reopened.getById(inserted.receipt.receiptId);
    expect(receipt?.handoffOutcome?.kind).toBe("scheduled");
    expect(isTerminalHandoffOutcome(receipt?.handoffOutcome)).toBe(false);
    expect(reopened.getAttempt(inserted.receipt.receiptId)).toBeNull();
    const plan = planRecovery({
      receiptId: inserted.receipt.receiptId,
      handoffOutcome: receipt!.handoffOutcome,
      attempt: null,
      observed: { self: A },
    });
    expect(plan.kind).toBe("claim_scheduled_work");
    reopened.close();
  });

  it("exact replay after a claim keeps one receipt and its attempt; a second identity is held, not stolen", () => {
    const dbPath = freshDb("cc-lhc-attempt-replay-");
    const store = openGovernorReceiptStore(dbPath);
    const settled = settledWouldCompact();
    const first = store.appendObserve({ observe: settled, sessionId: "s", threadId: "th" });
    const claim = store.claimAttempt({ receiptId: first.receipt.receiptId, owner: A });
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") return;
    expect(claim.attempt.stage).toBe("operation_claimed");
    expect(claim.attempt.claimEpoch).toBe(1);

    // Exact replay (restart re-tail) returns the same receipt row.
    const replay = store.appendObserve({ observe: settled, sessionId: "s", threadId: "th" });
    expect(replay.inserted).toBe(false);
    expect(replay.receipt.receiptId).toBe(first.receipt.receiptId);
    expect(replay.receipt.handoffOutcome?.kind).toBe("scheduled");

    // A different process cannot claim while A owns it (unprobed / live / indeterminate).
    const held = store.claimAttempt({ receiptId: first.receipt.receiptId, owner: B });
    expect(held.kind).toBe("held");
    const heldLive = store.claimAttempt({
      receiptId: first.receipt.receiptId,
      owner: B,
      reclaim: { expectedAttemptId: claim.attempt.attemptId, ownerLiveness: LIVE_A },
    });
    expect(heldLive.kind).toBe("held");
    if (heldLive.kind === "held") expect(heldLive.ownerLiveness).toBe("ok");
    const heldUnsure = store.claimAttempt({
      receiptId: first.receipt.receiptId,
      owner: B,
      reclaim: { expectedAttemptId: claim.attempt.attemptId, ownerLiveness: UNSURE },
    });
    expect(heldUnsure.kind).toBe("held");
    if (heldUnsure.kind === "held") expect(heldUnsure.ownerLiveness).toBe("indeterminate");
    // Same owner re-claim is idempotent.
    const again = store.claimAttempt({ receiptId: first.receipt.receiptId, owner: A });
    expect(again.kind).toBe("already_owned");
    store.close();
  });

  it("concurrent double claim over two connections: exactly one wins", () => {
    const dbPath = freshDb("cc-lhc-attempt-race-");
    const seedStore = openGovernorReceiptStore(dbPath);
    const receiptId = seedStore.appendObserve({ observe: settledWouldCompact(), sessionId: "s", threadId: "th" })
      .receipt.receiptId;
    seedStore.close();

    const a = openGovernorReceiptStore(dbPath);
    const b = openGovernorReceiptStore(dbPath);
    const ra = a.claimAttempt({ receiptId, owner: A });
    const rb = b.claimAttempt({ receiptId, owner: B });
    const kinds = [ra.kind, rb.kind].sort();
    expect(kinds).toEqual(["claimed", "held"]);
    expect(a.getAttempt(receiptId)?.owner).toEqual(A);
    expect(b.getAttempt(receiptId)?.owner).toEqual(A);
    a.close();
    b.close();
  });

  it("dead-owner reclaim moves ownership by CAS, bumps epoch, preserves stage and artifacts; stale expectation loses", () => {
    const dbPath = freshDb("cc-lhc-attempt-reclaim-");
    const store = openGovernorReceiptStore(dbPath);
    const receiptId = store.appendObserve({ observe: settledWouldCompact(), sessionId: "s", threadId: "th" }).receipt
      .receiptId;
    const claimed = store.claimAttempt({ receiptId, owner: A });
    if (claimed.kind !== "claimed") throw new Error("expected claim");
    const advanced = store.advanceAttempt({
      receiptId,
      attemptId: claimed.attempt.attemptId,
      stage: "view_installed",
      artifacts: { viewId: "v42", threadId: "th" },
    });
    expect(advanced.kind).toBe("advanced");

    // B proves A dead and reclaims.
    const reclaimed = store.claimAttempt({
      receiptId,
      owner: B,
      reclaim: { expectedAttemptId: claimed.attempt.attemptId, ownerLiveness: DEAD },
    });
    expect(reclaimed.kind).toBe("reclaimed");
    if (reclaimed.kind !== "reclaimed") return;
    expect(reclaimed.previousAttemptId).toBe(claimed.attempt.attemptId);
    expect(reclaimed.attempt.attemptId).not.toBe(claimed.attempt.attemptId);
    expect(reclaimed.attempt.claimEpoch).toBe(2);
    expect(reclaimed.attempt.owner).toEqual(B);
    expect(reclaimed.attempt.stage).toBe("view_installed");
    expect(reclaimed.attempt.artifacts).toEqual({ viewId: "v42", threadId: "th" });

    // A (or anyone) trying to reclaim against the OLD attempt id now loses.
    const stale = store.claimAttempt({
      receiptId,
      owner: A,
      reclaim: { expectedAttemptId: claimed.attempt.attemptId, ownerLiveness: DEAD },
    });
    expect(stale.kind).toBe("stale_expectation");
    // A's old attemptId can no longer advance (cross-attempt overwrite rejected).
    const crossWrite = store.advanceAttempt({
      receiptId,
      attemptId: claimed.attempt.attemptId,
      stage: "rollout_written",
      artifacts: { rebuiltSessionId: "x" },
    });
    expect(crossWrite.kind).toBe("not_owner");
    store.close();
  });

  it("stages are monotonic: same stage is idempotent, regression rejected, artifact contradiction rejected", () => {
    const dbPath = freshDb("cc-lhc-attempt-stages-");
    const store = openGovernorReceiptStore(dbPath);
    const receiptId = store.appendObserve({ observe: settledWouldCompact(), sessionId: "s", threadId: "th" }).receipt
      .receiptId;
    const claimed = store.claimAttempt({ receiptId, owner: A });
    if (claimed.kind !== "claimed") throw new Error("expected claim");
    const id = claimed.attempt.attemptId;

    expect(
      store.advanceAttempt({ receiptId, attemptId: id, stage: "view_installed", artifacts: { viewId: "v1" } }).kind,
    ).toBe("advanced");
    expect(
      store.advanceAttempt({ receiptId, attemptId: id, stage: "view_installed", artifacts: { viewId: "v1" } }).kind,
    ).toBe("unchanged");
    const regress = store.advanceAttempt({ receiptId, attemptId: id, stage: "operation_claimed" });
    expect(regress.kind).toBe("stage_regression");
    const conflict = store.advanceAttempt({
      receiptId,
      attemptId: id,
      stage: "rollout_written",
      artifacts: { viewId: "v2", rebuiltSessionId: "r1" },
    });
    expect(conflict.kind).toBe("artifact_conflict");
    if (conflict.kind === "artifact_conflict") expect(conflict.conflictKey).toBe("viewId");
    // Still at view_installed after the rejected writes.
    expect(store.getAttempt(receiptId)?.stage).toBe("view_installed");

    // Skipping forward past warning-only stages is allowed (source semantics).
    const skip = store.advanceAttempt({
      receiptId,
      attemptId: id,
      stage: "rollout_written",
      artifacts: { rebuiltSessionId: "r1", rebuiltRolloutPath: "/tmp/r1.jsonl" },
    });
    expect(skip.kind).toBe("advanced");
    expect(
      store.advanceAttempt({ receiptId, attemptId: id, stage: "replacement_ready", artifacts: { replacementChild: B } })
        .kind,
    ).toBe("advanced");
    expect(store.advanceAttempt({ receiptId, attemptId: id, stage: "descriptor_published" }).kind).toBe("advanced");
    store.close();
  });

  it("generation event log accumulates 3+ two-phase generations durably; exact-prefix rejects tampering; survives reopen", () => {
    const dbPath = freshDb("cc-lhc-attempt-gens-");
    const store = openGovernorReceiptStore(dbPath);
    const receiptId = store.appendObserve({ observe: settledWouldCompact(), sessionId: "s", threadId: "th" }).receipt
      .receiptId;
    const claimed = store.claimAttempt({ receiptId, owner: A });
    if (claimed.kind !== "claimed") throw new Error("expected claim");
    const id = claimed.attempt.attemptId;
    store.advanceAttempt({
      receiptId,
      attemptId: id,
      stage: "descriptor_published",
      artifacts: { rebuiltSessionId: "r1", rebuiltRolloutPath: "/tmp/r1.jsonl", replacementChild: B },
    });

    const idOf = (n: number): ProcessIdentity => ({ pid: 2000 + n, bootId: "boot", starttime: `${n}` });
    const events: ReplacementGenerationEvent[] = [];
    const append = (ev: ReplacementGenerationEvent): void => {
      events.push(ev);
      const adv = store.advanceAttempt({
        receiptId,
        attemptId: id,
        stage: "descriptor_published",
        artifacts: { replacementGenerationEvents: [...events] },
      });
      expect(adv.kind).toBe("advanced");
    };
    // Three re-establishment generations: two two-phase respawns + one adopt.
    append({
      kind: "respawn_prepared",
      generationId: "g1",
      originAttemptId: id,
      oldChild: idOf(11),
      journalPath: "/j/1",
      journalId: "j1",
    });
    append({ kind: "respawn_ready", generationId: "g1", originAttemptId: id, replacement: idOf(1) });
    append({
      kind: "respawn_prepared",
      generationId: "g2",
      originAttemptId: id,
      oldChild: idOf(12),
      journalPath: "/j/2",
      journalId: "j2",
    });
    append({ kind: "respawn_ready", generationId: "g2", originAttemptId: id, replacement: idOf(2) });
    append({ kind: "adopt_ready", generationId: "g3", originAttemptId: id, replacement: idOf(3) });

    const now = store.getAttempt(receiptId)!;
    expect(now.artifacts.replacementGenerationEvents).toHaveLength(5);
    expect(activeReplacementIdentity(now.artifacts)).toEqual(idOf(3));
    // The immutable original identity was never rewritten.
    expect(now.artifacts.replacementChild).toEqual(B);

    // Tampering with an earlier event (non-exact-prefix) is rejected.
    const tampered = [...events];
    tampered[0] = {
      kind: "respawn_prepared",
      generationId: "g1",
      originAttemptId: id,
      oldChild: idOf(99),
      journalPath: "/j/1",
      journalId: "j1",
    };
    const conflict = store.advanceAttempt({
      receiptId,
      attemptId: id,
      stage: "descriptor_published",
      artifacts: { replacementGenerationEvents: tampered },
    });
    expect(conflict.kind).toBe("artifact_conflict");
    if (conflict.kind === "artifact_conflict") expect(conflict.conflictKey).toBe("replacementGenerationEvents");
    store.close();

    // Survives reopen (the strict parser accepts the well-formed 5-event log).
    const reopened = openGovernorReceiptStore(dbPath);
    expect(reopened.getAttempt(receiptId)?.artifacts.replacementGenerationEvents).toHaveLength(5);
    reopened.close();
  });

  it("completeAttempt terminalizes the attempt and attaches the receipt outcome atomically; survives reopen", () => {
    const dbPath = freshDb("cc-lhc-attempt-complete-");
    const store = openGovernorReceiptStore(dbPath);
    const receiptId = store.appendObserve({ observe: settledWouldCompact(), sessionId: "s", threadId: "th" }).receipt
      .receiptId;
    const claimed = store.claimAttempt({ receiptId, owner: A });
    if (claimed.kind !== "claimed") throw new Error("expected claim");
    const id = claimed.attempt.attemptId;
    store.advanceAttempt({ receiptId, attemptId: id, stage: "rollout_written", artifacts: { rebuiltSessionId: "r1" } });

    // Wrong attempt id cannot complete.
    expect(
      store.completeAttempt({ receiptId, attemptId: "nope", outcome: { kind: "handoff_cancelled", detail: "x" } }).kind,
    ).toBe("not_owner");
    const done = store.completeAttempt({
      receiptId,
      attemptId: id,
      outcome: { kind: "handoff_success", newSessionId: "r1", flushedInputBytes: 0 },
    });
    expect(done.kind).toBe("completed");
    if (done.kind !== "completed") return;
    expect(done.attempt.stage).toBe("terminal");
    expect(done.attempt.terminalOutcomeKind).toBe("handoff_success");
    expect(done.receipt.handoffOutcome?.kind).toBe("handoff_success");
    // Second completion is refused; claim on a terminal receipt is refused.
    expect(
      store.completeAttempt({ receiptId, attemptId: id, outcome: { kind: "mutation_noop", detail: "x" } }).kind,
    ).toBe("already_terminal");
    expect(store.claimAttempt({ receiptId, owner: B }).kind).toBe("receipt_terminal");
    store.close();

    const reopened = openGovernorReceiptStore(dbPath);
    expect(reopened.getById(receiptId)?.handoffOutcome?.kind).toBe("handoff_success");
    expect(reopened.getAttempt(receiptId)?.stage).toBe("terminal");
    expect(reopened.listOpenAttempts()).toHaveLength(0);
    const plan = planRecovery({
      receiptId,
      handoffOutcome: reopened.getById(receiptId)!.handoffOutcome,
      attempt: reopened.getAttempt(receiptId),
      observed: { self: B },
    });
    expect(plan.kind).toBe("terminal_complete");
    reopened.close();
  });

  it("restart planning over reopened attempt rows: installed view is authoritative, rollout is reused, later stages reconcile", () => {
    const dbPath = freshDb("cc-lhc-attempt-restart-");
    const store = openGovernorReceiptStore(dbPath);
    const ids = ["s1", "s2", "s3", "s4"].map(
      (sid) =>
        store.appendObserve({ observe: settledWouldCompact(sid), sessionId: "s", threadId: "th" }).receipt.receiptId,
    );
    const claims = ids.map((receiptId) => {
      const c = store.claimAttempt({ receiptId, owner: A });
      if (c.kind !== "claimed") throw new Error("expected claim");
      return c.attempt.attemptId;
    });
    // s1: crashed after view install; s2: after rollout; s3: after replacement ready; s4: still just claimed.
    store.advanceAttempt({
      receiptId: ids[0]!,
      attemptId: claims[0]!,
      stage: "view_installed",
      artifacts: { viewId: "v1" },
    });
    store.advanceAttempt({
      receiptId: ids[1]!,
      attemptId: claims[1]!,
      stage: "rollout_written",
      artifacts: { viewId: "v2", rebuiltSessionId: "reb-2", rebuiltRolloutPath: "/tmp/reb-2.jsonl" },
    });
    store.advanceAttempt({
      receiptId: ids[2]!,
      attemptId: claims[2]!,
      stage: "replacement_ready",
      artifacts: { viewId: "v3", rebuiltSessionId: "reb-3", replacementChild: B },
    });
    store.close();

    // New process (B) restarts and inspects.
    const reopened = openGovernorReceiptStore(dbPath);
    expect(
      reopened
        .listOpenAttempts()
        .map((a) => a.stage)
        .sort(),
    ).toEqual(["operation_claimed", "replacement_ready", "rollout_written", "view_installed"].sort());
    const planFor = (receiptId: string, observed: Parameters<typeof planRecovery>[0]["observed"]) =>
      planRecovery({
        receiptId,
        handoffOutcome: reopened.getById(receiptId)!.handoffOutcome,
        attempt: reopened.getAttempt(receiptId),
        observed,
      });
    // Owner A is dead: every plan is a reclaim whose resume is stage-specific.
    const p1 = planFor(ids[0]!, { self: B, ownerLiveness: DEAD, viewInstalled: "present" });
    expect(p1.kind).toBe("reclaim_dead_owner");
    if (p1.kind === "reclaim_dead_owner") expect(p1.resume.kind).toBe("reconcile_installed_view");
    const p2 = planFor(ids[1]!, { self: B, ownerLiveness: DEAD, rolloutPresent: "present" });
    expect(p2.kind).toBe("reclaim_dead_owner");
    if (p2.kind === "reclaim_dead_owner") expect(p2.resume.kind).toBe("verify_reuse_rollout");
    const p3 = planFor(ids[2]!, { self: B, ownerLiveness: DEAD, replacementLiveness: { ok: true, identity: B } });
    expect(p3.kind).toBe("reclaim_dead_owner");
    if (p3.kind === "reclaim_dead_owner") expect(p3.resume.kind).toBe("reconcile_lineage_descriptor");
    // Same stage with no replacement observation: verify, never assume live.
    const p3u = planFor(ids[2]!, { self: B, ownerLiveness: DEAD });
    if (p3u.kind === "reclaim_dead_owner") expect(p3u.resume.kind).toBe("verify_replacement");
    const p4 = planFor(ids[3]!, { self: B, ownerLiveness: DEAD });
    expect(p4.kind).toBe("reclaim_dead_owner");
    if (p4.kind === "reclaim_dead_owner") expect(p4.resume.kind).toBe("reprepare_from_scratch");
    // With A live, everything is wait-only.
    expect(planFor(ids[1]!, { self: B, ownerLiveness: LIVE_A }).kind).toBe("wait_for_owner");
    reopened.close();
  });

  it("malformed attempt rows fail loudly from both getAttempt and listOpenAttempts", () => {
    const dbPath = freshDb("cc-lhc-attempt-corrupt-");
    const store = openGovernorReceiptStore(dbPath);
    const receiptId = store.appendObserve({ observe: settledWouldCompact(), sessionId: "s", threadId: "th" }).receipt
      .receiptId;
    const claimed = store.claimAttempt({ receiptId, owner: A });
    if (claimed.kind !== "claimed") throw new Error("expected claim");
    store.close();

    // Damage the payload out-of-band: an invalid stage and a bogus outcome kind.
    const raw = new DatabaseSync(dbPath);
    const row = raw.prepare("SELECT payload_json FROM cc_governor_attempts WHERE receipt_id = ?").get(receiptId) as {
      payload_json: string;
    };
    const damaged = { ...JSON.parse(row.payload_json), stage: "terminal", terminalOutcomeKind: "not_a_kind" };
    raw
      .prepare("UPDATE cc_governor_attempts SET payload_json = ?, stage = 'view_installed' WHERE receipt_id = ?")
      .run(JSON.stringify(damaged), receiptId);
    raw.close();

    const reopened = openGovernorReceiptStore(dbPath);
    expect(() => reopened.getAttempt(receiptId)).toThrow(/malformed/);
    expect(() => reopened.listOpenAttempts()).toThrow(/malformed/);
    // Claim/advance paths read the same row and surface the damage too.
    expect(() => reopened.claimAttempt({ receiptId, owner: B })).toThrow(/malformed/);
    reopened.close();
  });

  it("validates attempt row metadata before filtering terminal rows", () => {
    const dbPath = freshDb("cc-lhc-attempt-column-corrupt-");
    const store = openGovernorReceiptStore(dbPath);
    const receiptId = store.appendObserve({ observe: settledWouldCompact(), sessionId: "s", threadId: "th" }).receipt
      .receiptId;
    const claimed = store.claimAttempt({ receiptId, owner: A });
    if (claimed.kind !== "claimed") throw new Error("expected claim");
    store.close();

    const raw = new DatabaseSync(dbPath);
    // A WHERE stage != 'terminal' query would silently hide this row. The
    // payload remains non-terminal, so the duplicated column contradicts it.
    raw.prepare("UPDATE cc_governor_attempts SET stage = 'terminal' WHERE receipt_id = ?").run(receiptId);
    raw.close();

    const reopened = openGovernorReceiptStore(dbPath);
    expect(() => reopened.getAttempt(receiptId)).toThrow(/malformed/);
    expect(() => reopened.listOpenAttempts()).toThrow(/malformed/);
    reopened.close();

    const versionDbPath = freshDb("cc-lhc-attempt-version-corrupt-");
    const versionStore = openGovernorReceiptStore(versionDbPath);
    const versionReceiptId = versionStore.appendObserve({
      observe: settledWouldCompact("version"),
      sessionId: "s",
      threadId: "th",
    }).receipt.receiptId;
    const versionClaim = versionStore.claimAttempt({ receiptId: versionReceiptId, owner: A });
    if (versionClaim.kind !== "claimed") throw new Error("expected version claim");
    versionStore.close();

    const versionRaw = new DatabaseSync(versionDbPath);
    versionRaw
      .prepare("UPDATE cc_governor_attempts SET payload_version = 99 WHERE receipt_id = ?")
      .run(versionReceiptId);
    versionRaw.close();

    const versionReopened = openGovernorReceiptStore(versionDbPath);
    expect(() => versionReopened.getAttempt(versionReceiptId)).toThrow(/unsupported payload version 99/);
    expect(() => versionReopened.listOpenAttempts()).toThrow(/unsupported payload version 99/);
    versionReopened.close();
  });
});
