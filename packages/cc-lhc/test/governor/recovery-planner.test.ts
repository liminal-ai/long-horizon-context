/**
 * LIM-80 Slice 1: pure recovery planner. No SQLite, no processes.
 */
import { describe, expect, it } from "vitest";

import {
  GOVERNOR_HANDOFF_OUTCOME_KINDS,
  isTerminalHandoffOutcomeKind,
  mergeRecoveryArtifacts,
  parseRecoveryAttempt,
  planRecovery,
  RECOVERY_STAGES,
  type RecoveryAttempt,
  type RecoveryStage,
  recoveryStageIndex,
} from "../../src/governor/recovery.js";
import type { ProcessIdentity, ProcessLivenessResult } from "../../src/runtime/process-identity.js";

const SELF: ProcessIdentity = { pid: 100, bootId: "boot-a", starttime: "111" };
const OTHER: ProcessIdentity = { pid: 200, bootId: "boot-a", starttime: "222" };
const LIVE: ProcessLivenessResult = { ok: true, identity: OTHER };
const DEAD: ProcessLivenessResult = { ok: false, code: "not_found", message: "no such process" };
const UNSURE: ProcessLivenessResult = { ok: false, code: "indeterminate", message: "EPERM" };

function attemptAt(stage: RecoveryStage, overrides: Partial<RecoveryAttempt> = {}): RecoveryAttempt {
  const t = "2026-08-17T00:00:00.000Z";
  return {
    receiptId: "r1",
    attemptId: "a1",
    claimEpoch: 1,
    owner: SELF,
    stage,
    artifacts:
      recoveryStageIndex(stage) >= recoveryStageIndex("rollout_written")
        ? { rebuiltSessionId: "rebuilt-1", oldSessionId: "old-1", viewId: "v9" }
        : recoveryStageIndex(stage) >= recoveryStageIndex("view_installed")
          ? { viewId: "v9" }
          : {},
    terminalOutcomeKind: stage === "terminal" ? "handoff_success" : null,
    claimedAt: t,
    stageUpdatedAt: t,
    createdAt: t,
    updatedAt: t,
    ...overrides,
  };
}

describe("recovery stage vocabulary", () => {
  it("is monotonic in production order", () => {
    expect(RECOVERY_STAGES).toEqual([
      "receipt_scheduled",
      "operation_claimed",
      "view_installed",
      "rollout_written",
      "old_child_exited",
      "replacement_ready",
      "lineage_recorded",
      "descriptor_published",
      "terminal",
    ]);
    for (let i = 1; i < RECOVERY_STAGES.length; i += 1) {
      expect(recoveryStageIndex(RECOVERY_STAGES[i]!)).toBeGreaterThan(recoveryStageIndex(RECOVERY_STAGES[i - 1]!));
    }
  });

  it("artifact merge confirms or adds identities and rejects contradictions", () => {
    const merged = mergeRecoveryArtifacts({ viewId: "v1" }, { rebuiltSessionId: "s1", viewId: "v1" });
    expect(merged).toEqual({ ok: true, artifacts: { viewId: "v1", rebuiltSessionId: "s1" } });
    expect(mergeRecoveryArtifacts({ rebuiltSessionId: "s1" }, { rebuiltSessionId: "s2" })).toEqual({
      ok: false,
      conflictKey: "rebuiltSessionId",
    });
    expect(mergeRecoveryArtifacts({ replacementChild: SELF }, { replacementChild: OTHER })).toEqual({
      ok: false,
      conflictKey: "replacementChild",
    });
  });

  it("parses only well-formed attempt payloads", () => {
    const a = attemptAt("view_installed");
    expect(parseRecoveryAttempt(JSON.parse(JSON.stringify(a)))).toEqual(a);
    expect(parseRecoveryAttempt({ ...a, stage: "bogus" })).toBeNull();
    expect(parseRecoveryAttempt({ ...a, claimEpoch: 0 })).toBeNull();
    // terminal stage and terminalOutcomeKind must agree
    expect(parseRecoveryAttempt({ ...a, stage: "terminal" })).toBeNull();
    expect(parseRecoveryAttempt({ ...a, terminalOutcomeKind: "handoff_success" })).toBeNull();
    // artifacts never carry payloads: an unknown key is ignored, a bad type is rejected
    expect(parseRecoveryAttempt({ ...a, artifacts: { viewId: 5 } })).toBeNull();
    // terminalOutcomeKind must be a real, non-scheduled GovernorHandoffOutcome kind
    const t = attemptAt("terminal");
    expect(parseRecoveryAttempt({ ...t, terminalOutcomeKind: "not_a_kind" })).toBeNull();
    expect(parseRecoveryAttempt({ ...t, terminalOutcomeKind: "scheduled" })).toBeNull();
    expect(parseRecoveryAttempt({ ...t, terminalOutcomeKind: "handoff_rolled_back" })?.terminalOutcomeKind).toBe(
      "handoff_rolled_back",
    );
    expect(GOVERNOR_HANDOFF_OUTCOME_KINDS).toContain("scheduled");
    expect(isTerminalHandoffOutcomeKind("scheduled")).toBe(false);
    expect(isTerminalHandoffOutcomeKind("mutation_noop")).toBe(true);
    expect(isTerminalHandoffOutcomeKind("bogus")).toBe(false);
  });
});

describe("planRecovery", () => {
  it("terminal receipt outcome → terminal_complete", () => {
    const plan = planRecovery({
      receiptId: "r1",
      handoffOutcome: { kind: "handoff_success", newSessionId: "n", flushedInputBytes: 0 },
      attempt: attemptAt("terminal"),
      observed: { self: SELF },
    });
    expect(plan.kind).toBe("terminal_complete");
    if (plan.kind === "terminal_complete") expect(plan.outcomeKind).toBe("handoff_success");
    // Legacy: terminal receipt with no attempt row at all is also complete.
    expect(
      planRecovery({
        receiptId: "r1",
        handoffOutcome: { kind: "mutation_refused", detail: "x" },
        attempt: null,
        observed: { self: SELF },
      }).kind,
    ).toBe("terminal_complete");
  });

  it("scheduled receipt with no attempt row (legacy or pre-claim crash) → claim, not refuse", () => {
    const plan = planRecovery({
      receiptId: "r1",
      handoffOutcome: { kind: "scheduled" },
      attempt: null,
      observed: { self: SELF },
    });
    expect(plan.kind).toBe("claim_scheduled_work");
  });

  it("live foreign owner → wait(ok); indeterminate → wait(indeterminate); unprobed → wait(unprobed), never ok", () => {
    const foreign = attemptAt("view_installed", { owner: OTHER });
    for (const [liveness, label] of [
      [LIVE, "ok"],
      [UNSURE, "indeterminate"],
      [undefined, "unprobed"],
    ] as const) {
      const plan = planRecovery({
        receiptId: "r1",
        handoffOutcome: { kind: "scheduled" },
        attempt: foreign,
        observed: { self: SELF, ...(liveness === undefined ? {} : { ownerLiveness: liveness }) },
      });
      expect(plan.kind).toBe("wait_for_owner");
      if (plan.kind === "wait_for_owner") expect(plan.ownerLiveness).toBe(label);
    }
  });

  it("dead foreign owner → reclaim with resume plan by stage", () => {
    const foreign = attemptAt("rollout_written", { owner: OTHER });
    const plan = planRecovery({
      receiptId: "r1",
      handoffOutcome: { kind: "scheduled" },
      attempt: foreign,
      observed: { self: SELF, ownerLiveness: DEAD, rolloutPresent: "present" },
    });
    expect(plan.kind).toBe("reclaim_dead_owner");
    if (plan.kind === "reclaim_dead_owner") expect(plan.resume.kind).toBe("verify_reuse_rollout");
  });

  it("repeated kernel-proven-dead owners remain reclaimable: claimEpoch is audit evidence, not a limit", () => {
    for (const claimEpoch of [1, 8, 250]) {
      const plan = planRecovery({
        receiptId: "r1",
        handoffOutcome: { kind: "scheduled" },
        attempt: attemptAt("view_installed", { owner: OTHER, claimEpoch }),
        observed: { self: SELF, ownerLiveness: DEAD, viewInstalled: "present" },
      });
      expect(plan.kind).toBe("reclaim_dead_owner");
    }
  });

  it("owned operation_claimed (stale, non-durable preparation) → reprepare_from_scratch", () => {
    const plan = planRecovery({
      receiptId: "r1",
      handoffOutcome: { kind: "scheduled" },
      attempt: attemptAt("operation_claimed"),
      observed: { self: SELF },
    });
    expect(plan.kind).toBe("reprepare_from_scratch");
  });

  it("owned view_installed → reconcile installed view (no duplicate compact); absent view → refuse", () => {
    const base = {
      receiptId: "r1",
      handoffOutcome: { kind: "scheduled" } as const,
      attempt: attemptAt("view_installed"),
    };
    expect(planRecovery({ ...base, observed: { self: SELF } }).kind).toBe("reconcile_installed_view");
    expect(planRecovery({ ...base, observed: { self: SELF, viewInstalled: "present" } }).kind).toBe(
      "reconcile_installed_view",
    );
    expect(planRecovery({ ...base, observed: { self: SELF, viewInstalled: "absent" } }).kind).toBe("terminal_refuse");
  });

  it("owned rollout_written → verify/reuse rollout; missing rollout is not terminal", () => {
    const base = {
      receiptId: "r1",
      handoffOutcome: { kind: "scheduled" } as const,
      attempt: attemptAt("rollout_written"),
    };
    expect(planRecovery({ ...base, observed: { self: SELF, rolloutPresent: "present" } }).kind).toBe(
      "verify_reuse_rollout",
    );
    expect(planRecovery({ ...base, observed: { self: SELF } }).kind).toBe("verify_reuse_rollout");
    expect(planRecovery({ ...base, observed: { self: SELF, rolloutPresent: "absent" } }).kind).toBe(
      "reconcile_installed_view",
    );
    // structural contradiction: stage says written but no session id recorded
    expect(
      planRecovery({
        ...base,
        attempt: attemptAt("rollout_written", { artifacts: {} }),
        observed: { self: SELF },
      }).kind,
    ).toBe("terminal_refuse");
  });

  it("owned old_child_exited → continue replacement; a live old child contradicts and refuses", () => {
    const base = {
      receiptId: "r1",
      handoffOutcome: { kind: "scheduled" } as const,
      attempt: attemptAt("old_child_exited"),
    };
    expect(planRecovery({ ...base, observed: { self: SELF } }).kind).toBe("continue_replacement");
    expect(planRecovery({ ...base, observed: { self: SELF, oldChildLiveness: DEAD } }).kind).toBe(
      "continue_replacement",
    );
    expect(planRecovery({ ...base, observed: { self: SELF, oldChildLiveness: LIVE } }).kind).toBe("terminal_refuse");
  });

  it("late stages require current proof: unprobed/indeterminate replacement → verify; dead → respawn; live → bookkeeping", () => {
    for (const stage of ["replacement_ready", "lineage_recorded", "descriptor_published"] as const) {
      const base = {
        receiptId: "r1",
        handoffOutcome: { kind: "scheduled" } as const,
        attempt: attemptAt(stage, {
          artifacts: { rebuiltSessionId: "rebuilt-1", replacementChild: OTHER },
        }),
      };
      // No observation at all: never inferred live from the durable stage.
      const unprobed = planRecovery({ ...base, observed: { self: SELF } });
      expect(unprobed.kind).toBe("verify_replacement");
      if (unprobed.kind === "verify_replacement") expect(unprobed.replacementLiveness).toBe("unprobed");
      const unsure = planRecovery({ ...base, observed: { self: SELF, replacementLiveness: UNSURE } });
      expect(unsure.kind).toBe("verify_replacement");
      if (unsure.kind === "verify_replacement") expect(unsure.replacementLiveness).toBe("indeterminate");
      expect(planRecovery({ ...base, observed: { self: SELF, replacementLiveness: DEAD } }).kind).toBe(
        "continue_replacement",
      );
      // Live but bookkeeping unknown/absent → reconcile, never attach success.
      expect(planRecovery({ ...base, observed: { self: SELF, replacementLiveness: LIVE } }).kind).toBe(
        "reconcile_lineage_descriptor",
      );
      expect(
        planRecovery({
          ...base,
          observed: {
            self: SELF,
            replacementLiveness: LIVE,
            lineageRecorded: "present",
            descriptorPublished: "absent",
          },
        }).kind,
      ).toBe("reconcile_lineage_descriptor");
      expect(
        planRecovery({
          ...base,
          observed: {
            self: SELF,
            replacementLiveness: LIVE,
            lineageRecorded: "absent",
            descriptorPublished: "present",
          },
        }).kind,
      ).toBe("reconcile_lineage_descriptor");
      // Live + lineage + descriptor all observed present → attach handoff_success.
      const done = planRecovery({
        ...base,
        observed: { self: SELF, replacementLiveness: LIVE, lineageRecorded: "present", descriptorPublished: "present" },
      });
      expect(done.kind).toBe("attach_terminal_outcome");
      if (done.kind === "attach_terminal_outcome") expect(done.outcomeKind).toBe("handoff_success");
    }
  });

  it("descriptor_published with dead or unprobed replacement never attaches success", () => {
    const base = {
      receiptId: "r1",
      handoffOutcome: { kind: "scheduled" } as const,
      attempt: attemptAt("descriptor_published", {
        artifacts: { rebuiltSessionId: "rebuilt-1", replacementChild: OTHER },
      }),
    };
    expect(
      planRecovery({
        ...base,
        observed: { self: SELF, replacementLiveness: DEAD, lineageRecorded: "present", descriptorPublished: "present" },
      }).kind,
    ).toBe("continue_replacement");
    expect(
      planRecovery({ ...base, observed: { self: SELF, lineageRecorded: "present", descriptorPublished: "present" } })
        .kind,
    ).toBe("verify_replacement");
  });

  it("terminal receipt with a non-terminal attempt → reconcile_attempt_terminal carrying the receipt outcome", () => {
    for (const [outcome, stage] of [
      [{ kind: "handoff_success", newSessionId: "n", flushedInputBytes: 0 }, "descriptor_published"],
      [{ kind: "handoff_cancelled", detail: "x" }, "rollout_written"],
      [{ kind: "mutation_refused", detail: "x" }, "operation_claimed"],
      [{ kind: "handoff_failed", detail: "x", oldSessionId: "o", rebuiltSessionId: "r" }, "replacement_ready"],
    ] as const) {
      const plan = planRecovery({
        receiptId: "r1",
        handoffOutcome: outcome,
        attempt: attemptAt(stage),
        observed: { self: SELF },
      });
      expect(plan.kind).toBe("reconcile_attempt_terminal");
      if (plan.kind === "reconcile_attempt_terminal") expect(plan.outcomeKind).toBe(outcome.kind);
    }
  });

  it("structural contradictions refuse: terminal attempt under scheduled receipt; receipt id mismatch", () => {
    expect(
      planRecovery({
        receiptId: "r1",
        handoffOutcome: { kind: "scheduled" },
        attempt: attemptAt("terminal"),
        observed: { self: SELF },
      }).kind,
    ).toBe("terminal_refuse");
    expect(
      planRecovery({
        receiptId: "r-other",
        handoffOutcome: { kind: "scheduled" },
        attempt: attemptAt("view_installed"),
        observed: { self: SELF },
      }).kind,
    ).toBe("terminal_refuse");
  });
});
