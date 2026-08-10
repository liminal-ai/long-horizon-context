import { describe, expect, it, vi } from "vitest";

import type { HandoffRequest } from "../../src/commands/context-mutation.js";
import {
  executeHandoff,
  type HandoffChild,
  type HandoffPorts,
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
    durableReceipt: "[lhc compact:auto] trigger context 508k; rebuilt LHC view 247k (240k target).",
    metrics: { origin: "auto", triggerContextTokens: 508_000, viewTokens: 247_000, targetTokens: 240_000 },
  };
}

interface Harness {
  ports: HandoffPorts;
  calls: string[];
  writesBySession: Record<string, string[]>;
  artifacts: RecoveryArtifact[];
  buffer: Buffer[];
  setBuffer(bytes: string[]): void;
}

function makeHarness(overrides: Partial<HandoffPorts> = {}): Harness {
  const calls: string[] = [];
  const writesBySession: Record<string, string[]> = {};
  const artifacts: RecoveryArtifact[] = [];
  let buffer: Buffer[] = [];
  let barrierActive = false;

  const childFor = (sessionId: string): HandoffChild => ({
    write: (data: string) => {
      (writesBySession[sessionId] ??= []).push(data);
    },
  });

  const ports: HandoffPorts = {
    preCommitGate: () => {
      calls.push("preCommitGate");
      return null;
    },
    beginInputBarrier: () => {
      calls.push("beginInputBarrier");
      barrierActive = true;
    },
    flushInputBarrier: (child: HandoffChild) => {
      calls.push("flushInputBarrier");
      if (!barrierActive) throw new Error("flush without barrier");
      barrierActive = false;
      const bytes = Buffer.concat(buffer);
      buffer = [];
      if (bytes.length > 0) child.write(bytes.toString("latin1"));
      return bytes.length;
    },
    takeInputBarrierBuffer: () => {
      calls.push("takeInputBarrierBuffer");
      barrierActive = false;
      const bytes = Buffer.concat(buffer);
      buffer = [];
      return bytes;
    },
    closeOldDescriptor: () => {
      calls.push("closeOldDescriptor");
    },
    terminateOldChild: async () => {
      calls.push("terminateOldChild");
      return { exited: true, escalated: false };
    },
    stopCurrentCapture: async () => {
      calls.push("stopCurrentCapture");
    },
    spawnChild: (sessionId: string) => {
      calls.push(`spawnChild:${sessionId}`);
      return childFor(sessionId);
    },
    currentChild: () => childFor("current"),
    killCurrentChild: () => {
      calls.push("killCurrentChild");
    },
    startRebuiltCapture: () => {
      calls.push("startRebuiltCapture");
    },
    startRollbackCapture: (oldSessionId: string) => {
      calls.push(`startRollbackCapture:${oldSessionId}`);
    },
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
    writeRecoveryArtifact: (artifact) => {
      calls.push("writeRecoveryArtifact");
      artifacts.push(artifact);
      return "/tmp/recovery.json";
    },
    log: () => {},
    ...overrides,
  };

  return {
    ports,
    calls,
    writesBySession,
    artifacts,
    buffer,
    setBuffer: (bytes: string[]) => {
      buffer.length = 0;
      for (const b of bytes) buffer.push(Buffer.from(b));
      barrierActive = true;
    },
  };
}

describe("executeHandoff", () => {
  it("success path runs in the exact transaction order and flushes input once, in order, to the new child", async () => {
    const h = makeHarness();
    // Buffer arrives after commit (simulated as pre-loaded ordered bytes).
    const result = await executeHandoff(request(), h.ports);
    // Load bytes via a second run would reset; instead assert order + flush count here:
    expect(result.kind).toBe("success");
    expect(h.calls).toEqual([
      "preCommitGate",
      "beginInputBarrier",
      "closeOldDescriptor",
      "terminateOldChild",
      "stopCurrentCapture",
      "spawnChild:new-2222",
      "startRebuiltCapture",
      "awaitCaptureReady",
      "awaitChildStabilized",
      "registerSuccessLineage",
      "publishReadyDescriptor",
      "flushInputBarrier",
    ]);
    expect(h.calls.filter((c) => c === "flushInputBarrier")).toHaveLength(1);
  });

  it("delivers buffered bytes in arrival order to exactly the rebound child", async () => {
    const h = makeHarness();
    const origBegin = h.ports.beginInputBarrier;
    h.ports.beginInputBarrier = () => {
      origBegin();
      h.setBuffer(["first ", "second ", "third"]);
    };
    const result = await executeHandoff(request(), h.ports);
    expect(result.kind).toBe("success");
    if (result.kind === "success") expect(result.flushedInputBytes).toBe("first second third".length);
    expect(h.writesBySession["new-2222"]).toEqual(["first second third"]);
    expect(h.writesBySession["old-1111"]).toBeUndefined();
  });

  it("pre-commit gate refusal changes nothing: no barrier, no descriptor close, no termination", async () => {
    const h = makeHarness({
      preCommitGate: () => "input arrived before commit",
    });
    const result = await executeHandoff(request(), h.ports);
    expect(result).toEqual({ kind: "cancelled", reason: "input arrived before commit" });
    expect(h.calls).not.toContain("beginInputBarrier");
    expect(h.calls).not.toContain("closeOldDescriptor");
    expect(h.calls).not.toContain("terminateOldChild");
  });

  it("SIGKILL escalation still succeeds when the child dies on escalation", async () => {
    const h = makeHarness({
      terminateOldChild: async () => ({ exited: true, escalated: true }),
    });
    const result = await executeHandoff(request(), h.ports);
    expect(result.kind).toBe("success");
  });

  it("an unkillable old child returns its stdin and reports failed with the child alive", async () => {
    const h = makeHarness({
      terminateOldChild: async () => ({ exited: false, escalated: true }),
    });
    const origBegin = h.ports.beginInputBarrier;
    h.ports.beginInputBarrier = () => {
      origBegin();
      h.setBuffer(["typed"]);
    };
    const result = await executeHandoff(request(), h.ports);
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.childAlive).toBe(true);
      expect(result.retainedInputBytes).toBe(0);
    }
    // Bytes went back to the still-live current child; no replacement was spawned.
    expect(h.writesBySession.current).toEqual(["typed"]);
    expect(h.calls.some((c) => c.startsWith("spawnChild:"))).toBe(false);
  });

  it("replacement spawn failure rolls back to the old session and flushes input to it after capture is ready", async () => {
    const h = makeHarness();
    const origBegin = h.ports.beginInputBarrier;
    h.ports.beginInputBarrier = () => {
      origBegin();
      h.setBuffer(["queued prompt\r"]);
    };
    h.ports.spawnChild = (sessionId: string) => {
      h.calls.push(`spawnChild:${sessionId}`);
      if (sessionId === "new-2222") throw new Error("ENOENT");
      return {
        write: (data: string) => {
          (h.writesBySession[sessionId] ??= []).push(data);
        },
      };
    };
    const result = await executeHandoff(request(), h.ports);
    expect(result.kind).toBe("rolled_back");
    expect(h.calls).toContain("startRollbackCapture:old-1111");
    expect(h.writesBySession["old-1111"]).toEqual(["queued prompt\r"]);
    // Success-only lineage: a failed replacement must never register.
    expect(h.calls).not.toContain("registerSuccessLineage");
  });

  it("replay failure (capture degraded) kills the replacement and rolls back", async () => {
    const h = makeHarness();
    let readyCall = 0;
    h.ports.awaitCaptureReady = async () => {
      h.calls.push("awaitCaptureReady");
      readyCall += 1;
      return readyCall === 1 ? "degraded" : "ready";
    };
    const result = await executeHandoff(request(), h.ports);
    expect(result.kind).toBe("rolled_back");
    expect(h.calls).toContain("killCurrentChild");
    expect(h.calls).toContain("startRollbackCapture:old-1111");
    expect(h.calls).not.toContain("registerSuccessLineage");
  });

  it("capture-ready timeout rolls back the same way", async () => {
    const h = makeHarness();
    let readyCall = 0;
    h.ports.awaitCaptureReady = async () => {
      readyCall += 1;
      return readyCall === 1 ? "timeout" : "ready";
    };
    const result = await executeHandoff(request(), h.ports);
    expect(result.kind).toBe("rolled_back");
    if (result.kind === "rolled_back") expect(result.reason).toMatch(/timeout/);
  });

  it("rollback spawn failure retains the buffer in a recovery artifact and never claims success", async () => {
    const h = makeHarness();
    const origBegin = h.ports.beginInputBarrier;
    h.ports.beginInputBarrier = () => {
      origBegin();
      h.setBuffer(["do not lose me"]);
    };
    h.ports.spawnChild = () => {
      throw new Error("spawn broken");
    };
    const result = await executeHandoff(request(), h.ports);
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.childAlive).toBe(false);
      expect(result.recoveryArtifactPath).toBe("/tmp/recovery.json");
      expect(result.retainedInputBytes).toBe("do not lose me".length);
    }
    expect(h.artifacts).toHaveLength(1);
    expect(Buffer.from(h.artifacts[0]!.bufferedInputBase64, "base64").toString()).toBe("do not lose me");
    expect(h.artifacts[0]!.oldSessionId).toBe("old-1111");
    expect(h.artifacts[0]!.rebuiltSessionId).toBe("new-2222");
  });

  it("rollback capture failure keeps the old child alive, retains the buffer, and does not flush", async () => {
    const h = makeHarness();
    const origBegin = h.ports.beginInputBarrier;
    h.ports.beginInputBarrier = () => {
      origBegin();
      h.setBuffer(["held"]);
    };
    h.ports.spawnChild = (sessionId: string) => {
      h.calls.push(`spawnChild:${sessionId}`);
      if (sessionId === "new-2222") throw new Error("ENOENT");
      return { write: () => {} };
    };
    h.ports.awaitCaptureReady = async () => "timeout";
    const result = await executeHandoff(request(), h.ports);
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.childAlive).toBe(true);
      expect(result.retainedInputBytes).toBe(4);
    }
    expect(h.calls).not.toContain("flushInputBarrier");
    expect(h.artifacts).toHaveLength(1);
  });

  it("capture ready but child exited before liveness proof: rollback, no lineage, no descriptor, no flush", async () => {
    const h = makeHarness();
    const origBegin = h.ports.beginInputBarrier;
    h.ports.beginInputBarrier = () => {
      origBegin();
      h.setBuffer(["held bytes"]);
    };
    let loadCall = 0;
    h.ports.awaitChildStabilized = async () => {
      h.calls.push("awaitChildStabilized");
      loadCall += 1;
      // Replacement fails liveness; the rollback child stabilizes normally.
      return loadCall === 1 ? "exited" : "stable";
    };
    // Rollback capture becomes ready; the rollback child needs no growth gate.
    const result = await executeHandoff(request(), h.ports);
    expect(result.kind).toBe("rolled_back");
    if (result.kind === "rolled_back") expect(result.reason).toMatch(/child liveness exited/);
    // The failed replacement never advanced canonical state or received input.
    expect(h.calls).not.toContain("registerSuccessLineage");
    expect(h.writesBySession["new-2222"]).toBeUndefined();
    expect(h.calls).toContain("killCurrentChild");
    expect(h.calls).toContain("startRollbackCapture:old-1111");
    // Buffered input went to the rolled-back old child only, after its capture proof.
    expect(h.writesBySession["old-1111"]).toEqual(["held bytes"]);
    expect(loadCall).toBe(2);
  });

  it("capture ready but the child never emits output (timeout): rollback, no lineage, no flush to the replacement", async () => {
    const h = makeHarness();
    let livenessCall = 0;
    h.ports.awaitChildStabilized = async () => {
      livenessCall += 1;
      return livenessCall === 1 ? "timeout" : "stable";
    };
    const result = await executeHandoff(request(), h.ports);
    expect(result.kind).toBe("rolled_back");
    if (result.kind === "rolled_back") expect(result.reason).toMatch(/child liveness timeout/);
    expect(h.calls).not.toContain("registerSuccessLineage");
    expect(h.writesBySession["new-2222"]).toBeUndefined();
  });

  it("capture replay alone is not child evidence: success requires output + stability, which permit it", async () => {
    // Default harness returns ready + stable → success (the positive arm).
    const h = makeHarness();
    const result = await executeHandoff(request(), h.ports);
    expect(result.kind).toBe("success");
    // Lineage/descriptor/flush all sit AFTER the child-load proof.
    const loadIdx = h.calls.indexOf("awaitChildStabilized");
    expect(loadIdx).toBeGreaterThan(h.calls.indexOf("awaitCaptureReady"));
    expect(h.calls.indexOf("registerSuccessLineage")).toBeGreaterThan(loadIdx);
    expect(h.calls.indexOf("publishReadyDescriptor")).toBeGreaterThan(loadIdx);
    expect(h.calls.indexOf("flushInputBarrier")).toBeGreaterThan(loadIdx);
  });

  it("rollback child failing liveness (mute or delayed exit) retains the buffer and never flushes", async () => {
    const h = makeHarness();
    const origBegin = h.ports.beginInputBarrier;
    h.ports.beginInputBarrier = () => {
      origBegin();
      h.setBuffer(["precious bytes"]);
    };
    // Replacement spawn fails → rollback; the rollback child never proves liveness.
    h.ports.spawnChild = (sessionId: string) => {
      h.calls.push(`spawnChild:${sessionId}`);
      if (sessionId === "new-2222") throw new Error("ENOENT");
      return {
        write: (data: string) => {
          (h.writesBySession[sessionId] ??= []).push(data);
        },
      };
    };
    h.ports.awaitChildStabilized = async () => {
      h.calls.push("awaitChildStabilized");
      return "timeout"; // mute rollback child
    };
    const result = await executeHandoff(request(), h.ports);
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.reason).toMatch(/rollback child liveness timeout/);
      expect(result.childAlive).toBe(true);
      expect(result.retainedInputBytes).toBe("precious bytes".length);
    }
    // Same input-loss invariant as the forward path: no flush to an unproven child.
    expect(h.calls).not.toContain("flushInputBarrier");
    expect(h.writesBySession["old-1111"]).toBeUndefined();
    expect(h.artifacts).toHaveLength(1);
    expect(Buffer.from(h.artifacts[0]!.bufferedInputBase64, "base64").toString()).toBe("precious bytes");
  });

  it("rollback child that exits during liveness reports failed with no live child", async () => {
    const h = makeHarness();
    h.ports.spawnChild = (sessionId: string) => {
      h.calls.push(`spawnChild:${sessionId}`);
      if (sessionId === "new-2222") throw new Error("ENOENT");
      return { write: () => {} };
    };
    h.ports.awaitChildStabilized = async () => "exited";
    const result = await executeHandoff(request(), h.ports);
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.childAlive).toBe(false);
    expect(h.calls).not.toContain("flushInputBarrier");
  });

  it("a stable rollback child receives the buffer only after both capture and liveness proofs", async () => {
    const h = makeHarness();
    const origBegin = h.ports.beginInputBarrier;
    h.ports.beginInputBarrier = () => {
      origBegin();
      h.setBuffer(["queued"]);
    };
    h.ports.spawnChild = (sessionId: string) => {
      h.calls.push(`spawnChild:${sessionId}`);
      if (sessionId === "new-2222") throw new Error("ENOENT");
      return {
        write: (data: string) => {
          (h.writesBySession[sessionId] ??= []).push(data);
        },
      };
    };
    const result = await executeHandoff(request(), h.ports);
    expect(result.kind).toBe("rolled_back");
    expect(h.writesBySession["old-1111"]).toEqual(["queued"]);
    const flushIdx = h.calls.indexOf("flushInputBarrier");
    expect(flushIdx).toBeGreaterThan(h.calls.lastIndexOf("awaitCaptureReady"));
    expect(flushIdx).toBeGreaterThan(h.calls.lastIndexOf("awaitChildStabilized"));
  });

  it("lineage registration failure is a warning, not a rollback: input still flushes to the live child", async () => {
    const h = makeHarness({
      registerSuccessLineage: async () => ({ ok: false, reason: "disk full" }),
    });
    const result = await executeHandoff(request(), h.ports);
    expect(result.kind).toBe("success");
    if (result.kind === "success") expect(result.lineageWarning).toMatch(/disk full/);
    expect(h.calls).toContain("flushInputBarrier");
  });

  it("descriptor publish failure is a warning: retrieval stays fail-closed, session lives", async () => {
    const h = makeHarness({
      publishReadyDescriptor: () => false,
    });
    const result = await executeHandoff(request(), h.ports);
    expect(result.kind).toBe("success");
    if (result.kind === "success") expect(result.descriptorWarning).toMatch(/fail-closed/);
  });

  it("lineage and descriptor advance ONLY after ready-after-replay is proven", async () => {
    const h = makeHarness();
    let readyCall = 0;
    h.ports.awaitCaptureReady = async () => {
      readyCall += 1;
      return readyCall === 1 ? "degraded" : "ready";
    };
    await executeHandoff(request(), h.ports);
    // The rebuilt generation never proved ready → lineage never registered for it.
    expect(h.calls).not.toContain("registerSuccessLineage");
    // The rollback generation may publish a descriptor, but only after its own ready.
    const publishIdx = h.calls.indexOf("publishReadyDescriptor");
    const rollbackReadyIdx = h.calls.lastIndexOf("awaitCaptureReady");
    if (publishIdx !== -1) expect(publishIdx).toBeGreaterThan(rollbackReadyIdx);
  });
});
