/**
 * LIM-80 Slice 3B1: executeHandoff recovery-stage instrumentation.
 *
 * Drives the REAL executeHandoff with a mock ports + mock stage port sharing one
 * ordered call log, proving: stage order, prepare-before-barrier cancel safety,
 * old_child_exited / replacement_ready failure routing to the existing rollback,
 * best-effort lineage/descriptor advances, and the non-durable-barrier withhold.
 */
import { describe, expect, it } from "vitest";

import type { HandoffRequest } from "../../src/commands/context-mutation.js";
import {
  executeHandoff,
  type HandoffChild,
  type HandoffPorts,
  type HandoffRecoveryStagePort,
  type RecoveryArtifact,
} from "../../src/wrapper/handoff.js";

function request(): HandoffRequest {
  return {
    operation: "auto_compact",
    oldSessionId: "old-1111",
    threadId: "th_h",
    rebuilt: {
      sessionId: "new-2222",
      rolloutPath: "/tmp/new-2222.jsonl",
      lineCount: 3,
      expectedReintakeLines: 3,
      replayedPrefixLines: 2,
      prefixBoundary: { kind: "verified", lineCount: 2, byteLength: 40, sha256: "aa".repeat(32) },
      totalByteLength: 60,
    },
    receiptLines: ["compact view=v1"],
    durableReceipt: "[lhc compact:auto] rebuilt LHC view 247k.",
    metrics: { origin: "auto" },
  };
}

function makeHarness(calls: string[], overrides: Partial<HandoffPorts> = {}) {
  const artifacts: RecoveryArtifact[] = [];
  let barrierActive = false;
  const childFor = (): HandoffChild => ({ write: () => {} });
  const ports: HandoffPorts = {
    preCommitGate: () => null,
    beginInputBarrier: () => {
      calls.push("beginInputBarrier");
      barrierActive = true;
    },
    flushInputBarrier: () => {
      calls.push("flushInputBarrier");
      barrierActive = false;
      return 0;
    },
    takeInputBarrierBuffer: () => {
      barrierActive = false;
      return Buffer.alloc(0);
    },
    closeOldDescriptor: () => calls.push("closeOldDescriptor"),
    terminateOldChild: async () => {
      calls.push("terminateOldChild");
      return { exited: true, escalated: false };
    },
    stopCurrentCapture: async () => {
      calls.push("stopCurrentCapture");
    },
    spawnChild: (sessionId: string) => {
      calls.push(`spawnChild:${sessionId}`);
      return childFor();
    },
    currentChild: () => childFor(),
    killCurrentChild: async () => {
      calls.push("killCurrentChild");
    },
    startRebuiltCapture: () => calls.push("startRebuiltCapture"),
    startRollbackCapture: (s: string) => calls.push(`startRollbackCapture:${s}`),
    awaitCaptureReady: async () => {
      calls.push("awaitCaptureReady");
      return "ready";
    },
    awaitChildStabilized: async () => {
      calls.push("awaitChildStabilized");
      return "stable";
    },
    registerSuccessLineage: async () => {
      calls.push("registerSuccessLineage");
      return { ok: true };
    },
    publishReadyDescriptor: () => {
      calls.push("publishReadyDescriptor");
      return true;
    },
    writeRecoveryArtifact: (a) => {
      calls.push("writeRecoveryArtifact");
      artifacts.push(a);
      return "/tmp/recovery.json";
    },
    inputBarrierDurable: () => true,
    log: () => {},
    ...overrides,
  };
  return { ports, artifacts, isBarrierActive: () => barrierActive };
}

function makeStages(calls: string[], overrides: Partial<HandoffRecoveryStagePort> = {}): HandoffRecoveryStagePort {
  return {
    prepareBarrier: () => {
      calls.push("stage:prepareBarrier");
      return { ok: true };
    },
    recordOldChildExited: () => calls.push("stage:old_child_exited"),
    recordReplacementReady: () => {
      calls.push("stage:replacement_ready");
      return { ok: true };
    },
    recordLineageRecorded: () => calls.push("stage:lineage_recorded"),
    recordDescriptorPublished: () => calls.push("stage:descriptor_published"),
    ...overrides,
  };
}

describe("executeHandoff recovery stages (LIM-80 Slice 3B1)", () => {
  it("advances stages in exact order: prepare(before barrier) -> old_child_exited -> replacement_ready -> lineage -> descriptor -> flush", async () => {
    const calls: string[] = [];
    const h = makeHarness(calls);
    const result = await executeHandoff(request(), h.ports, { recoveryStages: makeStages(calls) });
    expect(result.kind).toBe("success");
    expect(calls).toEqual([
      "stage:prepareBarrier",
      "beginInputBarrier",
      "closeOldDescriptor",
      "terminateOldChild",
      "stage:old_child_exited",
      "stopCurrentCapture",
      "spawnChild:new-2222",
      "startRebuiltCapture",
      "awaitCaptureReady",
      "awaitChildStabilized",
      "stage:replacement_ready",
      "registerSuccessLineage",
      "stage:lineage_recorded",
      "publishReadyDescriptor",
      "stage:descriptor_published",
      "flushInputBarrier",
    ]);
  });

  it("prepareBarrier failure cancels safely: no barrier, no descriptor close, old child untouched", async () => {
    const calls: string[] = [];
    const h = makeHarness(calls);
    const stages = makeStages(calls, {
      prepareBarrier: () => {
        calls.push("stage:prepareBarrier");
        return { ok: false, reason: "old-child identity not_found" };
      },
    });
    const result = await executeHandoff(request(), h.ports, { recoveryStages: stages });
    expect(result.kind).toBe("cancelled");
    if (result.kind === "cancelled") expect(result.reason).toMatch(/identity/);
    expect(calls).toEqual(["stage:prepareBarrier"]);
    expect(calls).not.toContain("beginInputBarrier");
    expect(calls).not.toContain("terminateOldChild");
  });

  it("recordOldChildExited failure stops forward progress and rolls back (old child already exited)", async () => {
    const calls: string[] = [];
    const h = makeHarness(calls);
    const stages = makeStages(calls, {
      recordOldChildExited: () => {
        throw new Error("old_child_exited CAS not_owner");
      },
    });
    const result = await executeHandoff(request(), h.ports, { recoveryStages: stages });
    expect(result.kind).toBe("rolled_back");
    if (result.kind === "rolled_back") expect(result.reason).toMatch(/old_child_exited stage failed/);
    // Never spawned the replacement; rolled back to the old session.
    expect(calls).toContain("startRollbackCapture:old-1111");
    expect(calls).not.toContain("spawnChild:new-2222");
    expect(calls).not.toContain("stage:replacement_ready");
  });

  it("replacement identity unavailable is NOT ready: kill + rollback, replacement_ready never claimed", async () => {
    const calls: string[] = [];
    const h = makeHarness(calls);
    const stages = makeStages(calls, {
      recordReplacementReady: () => ({ ok: false, reason: "replacement identity indeterminate" }),
    });
    const result = await executeHandoff(request(), h.ports, { recoveryStages: stages });
    expect(result.kind).toBe("rolled_back");
    if (result.kind === "rolled_back") expect(result.reason).toMatch(/replacement not ready.*indeterminate/);
    expect(calls).toContain("killCurrentChild");
    expect(calls).toContain("startRollbackCapture:old-1111");
    expect(calls).not.toContain("stage:lineage_recorded");
  });

  it("lineage failure is a warning: lineage stage not advanced, descriptor stage still advances, success stands", async () => {
    const calls: string[] = [];
    const h = makeHarness(calls, {
      registerSuccessLineage: async () => ({ ok: false, reason: "lineage db locked" }),
    });
    const result = await executeHandoff(request(), h.ports, { recoveryStages: makeStages(calls) });
    expect(result.kind).toBe("success");
    if (result.kind === "success") expect(result.lineageWarning).toMatch(/lineage/);
    expect(calls).not.toContain("stage:lineage_recorded");
    expect(calls).toContain("stage:descriptor_published");
  });

  it("descriptor publish failure is a warning: descriptor stage not advanced, success stands", async () => {
    const calls: string[] = [];
    const h = makeHarness(calls, { publishReadyDescriptor: () => false });
    const result = await executeHandoff(request(), h.ports, { recoveryStages: makeStages(calls) });
    expect(result.kind).toBe("success");
    if (result.kind === "success") expect(result.descriptorWarning).toMatch(/descriptor/);
    expect(calls).toContain("stage:lineage_recorded");
    expect(calls).not.toContain("stage:descriptor_published");
  });

  it("a non-durable barrier withholds delivery: failed with a recovery artifact, no flush", async () => {
    const calls: string[] = [];
    const h = makeHarness(calls, { inputBarrierDurable: () => false });
    const result = await executeHandoff(request(), h.ports, { recoveryStages: makeStages(calls) });
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.reason).toMatch(/journal not durable/);
      expect(result.childAlive).toBe(true);
    }
    expect(calls).toContain("writeRecoveryArtifact");
    expect(calls).not.toContain("flushInputBarrier");
  });

  it("rollback also withholds delivery on a non-durable barrier (same journal protocol)", async () => {
    const calls: string[] = [];
    // Force rollback via unavailable replacement identity; the rollback child is
    // healthy but the barrier is non-durable, so its delivery is withheld too.
    const h = makeHarness(calls, { inputBarrierDurable: () => false });
    const stages = makeStages(calls, {
      recordReplacementReady: () => ({ ok: false, reason: "replacement identity indeterminate" }),
    });
    const result = await executeHandoff(request(), h.ports, { recoveryStages: stages });
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.reason).toMatch(/journal not durable/);
    expect(calls).toContain("startRollbackCapture:old-1111");
    expect(calls).toContain("writeRecoveryArtifact");
    expect(calls).not.toContain("flushInputBarrier");
  });

  it("no stage port = manual: no stage calls, classic success (byte-for-byte behavior unchanged)", async () => {
    const calls: string[] = [];
    const h = makeHarness(calls);
    const result = await executeHandoff(request(), h.ports);
    expect(result.kind).toBe("success");
    expect(calls.some((c) => c.startsWith("stage:"))).toBe(false);
  });

  // ── post-commit throw seams: no raw exception may escape (findings 5-8) ──
  it("terminateOldChild throw fails closed with the child assumed alive", async () => {
    const calls: string[] = [];
    const h = makeHarness(calls, {
      terminateOldChild: async () => {
        throw new Error("kill syscall EPERM");
      },
    });
    const result = await executeHandoff(request(), h.ports, { recoveryStages: makeStages(calls) });
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.reason).toMatch(/termination threw/);
      expect(result.childAlive).toBe(true);
    }
    expect(calls).toContain("writeRecoveryArtifact");
  });

  it("closeOldDescriptor throw is a warning, not a gate — handoff still succeeds", async () => {
    const calls: string[] = [];
    const h = makeHarness(calls, {
      closeOldDescriptor: () => {
        throw new Error("descriptor revoke threw");
      },
    });
    const result = await executeHandoff(request(), h.ports, { recoveryStages: makeStages(calls) });
    expect(result.kind).toBe("success");
  });

  it("capture-drain throw AFTER proven exit keeps old_child_exited and rolls back", async () => {
    const calls: string[] = [];
    const h = makeHarness(calls, {
      stopCurrentCapture: async () => {
        calls.push("stopCurrentCapture");
        throw new Error("watcher drain EIO");
      },
    });
    const result = await executeHandoff(request(), h.ports, { recoveryStages: makeStages(calls) });
    expect(result.kind).toBe("rolled_back");
    // old_child_exited was recorded BEFORE the drain that threw.
    const exitIdx = calls.indexOf("stage:old_child_exited");
    const stopIdx = calls.indexOf("stopCurrentCapture");
    expect(exitIdx).toBeGreaterThanOrEqual(0);
    expect(exitIdx).toBeLessThan(stopIdx);
    expect(calls).toContain("startRollbackCapture:old-1111");
  });

  it("old-child-survived withholds delivery when the journal is not durable (never bypassed)", async () => {
    const calls: string[] = [];
    const h = makeHarness(calls, {
      terminateOldChild: async () => ({ exited: false, escalated: true }),
      inputBarrierDurable: () => false,
    });
    const result = await executeHandoff(request(), h.ports, { recoveryStages: makeStages(calls) });
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.reason).toMatch(/did not exit.*not durable/);
      expect(result.childAlive).toBe(true);
    }
    expect(calls).not.toContain("flushInputBarrier");
    expect(calls).toContain("writeRecoveryArtifact");
  });

  it("old-child-survived returns bytes to the old child when the journal is durable", async () => {
    const calls: string[] = [];
    const h = makeHarness(calls, {
      terminateOldChild: async () => ({ exited: false, escalated: true }),
    });
    const result = await executeHandoff(request(), h.ports, { recoveryStages: makeStages(calls) });
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.childAlive).toBe(true);
    expect(calls).toContain("flushInputBarrier");
  });

  it("registerSuccessLineage throw degrades to a warning; success stands", async () => {
    const calls: string[] = [];
    const h = makeHarness(calls, {
      registerSuccessLineage: async () => {
        throw new Error("lineage db EIO");
      },
    });
    const result = await executeHandoff(request(), h.ports, { recoveryStages: makeStages(calls) });
    expect(result.kind).toBe("success");
    if (result.kind === "success") expect(result.lineageWarning).toMatch(/lineage/);
    expect(calls).not.toContain("stage:lineage_recorded");
  });

  it("publishReadyDescriptor throw degrades to a warning; success stands", async () => {
    const calls: string[] = [];
    const h = makeHarness(calls, {
      publishReadyDescriptor: () => {
        throw new Error("descriptor publish EIO");
      },
    });
    const result = await executeHandoff(request(), h.ports, { recoveryStages: makeStages(calls) });
    expect(result.kind).toBe("success");
    if (result.kind === "success") expect(result.descriptorWarning).toMatch(/descriptor/);
    expect(calls).not.toContain("stage:descriptor_published");
  });

  it("inputBarrierDurable throw is treated as non-durable and withholds delivery", async () => {
    const calls: string[] = [];
    const h = makeHarness(calls, {
      inputBarrierDurable: () => {
        throw new Error("durability probe threw");
      },
    });
    const result = await executeHandoff(request(), h.ports, { recoveryStages: makeStages(calls) });
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.reason).toMatch(/not durable/);
    expect(calls).not.toContain("flushInputBarrier");
    expect(calls).toContain("writeRecoveryArtifact");
  });

  it("a throw during delivery (markDelivering/child.write/markDelivered) is ambiguous → failed, never auto-replay", async () => {
    const calls: string[] = [];
    const h = makeHarness(calls, {
      flushInputBarrier: () => {
        calls.push("flushInputBarrier");
        throw new Error("child.write EPIPE mid-send");
      },
    });
    const result = await executeHandoff(request(), h.ports, { recoveryStages: makeStages(calls) });
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.reason).toMatch(/ambiguous, never auto-replay/);
      expect(result.childAlive).toBe(true);
    }
    expect(calls).toContain("writeRecoveryArtifact");
  });
});
