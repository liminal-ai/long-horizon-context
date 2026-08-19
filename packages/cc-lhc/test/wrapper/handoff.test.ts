/**
 * The spawn-first handoff transaction.
 *
 * A working session exists at every moment: the replacement is spawned and
 * proven while the old child is still live and routed, routing switches in one
 * step, and the old child is killed last. There is no rollback, no pre-commit
 * input recheck, and no bookkeeping outcome that can kill a live replacement —
 * the suite this replaces asserted all three as intended behavior.
 */
import { describe, expect, it, vi } from "vitest";

import type { HandoffRequest } from "../../src/commands/context-mutation.js";
import {
  type CandidateChild,
  type CandidateViability,
  executeHandoff,
  formatHandoffResult,
  type HandoffPorts,
  type HandoffResult,
  type SwitchOutcome,
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

const VIABLE: CandidateViability = {
  kind: "viable",
  evidence: { processAlive: true, sessionFileWritten: true },
};

interface Harness {
  ports: HandoffPorts;
  calls: string[];
  warnings: string[];
  spawned: string[];
  switchedTo: string[];
}

function makeHarness(overrides: Partial<HandoffPorts> = {}): Harness {
  const calls: string[] = [];
  const warnings: string[] = [];
  const spawned: string[] = [];
  const switchedTo: string[] = [];
  let nextPid = 4000;

  const ports: HandoffPorts = {
    preHandoffStop: () => {
      calls.push("preHandoffStop");
      return null;
    },
    spawnCandidate: (sessionId: string): CandidateChild => {
      calls.push(`spawnCandidate:${sessionId}`);
      spawned.push(sessionId);
      nextPid += 1;
      return { sessionId, pid: nextPid, child: { write: () => {} } };
    },
    awaitCandidateViable: async () => {
      calls.push("awaitCandidateViable");
      return VIABLE;
    },
    discardCandidate: async (candidate) => {
      calls.push(`discardCandidate:${candidate.pid}`);
    },
    switchToCandidate: (candidate): SwitchOutcome => {
      calls.push("switchToCandidate");
      switchedTo.push(candidate.sessionId);
      return { switched: true, captureStarted: true };
    },
    killOldChild: async () => {
      calls.push("killOldChild");
      return { exited: true, pid: 999 };
    },
    awaitReplacementCaptureReady: async () => {
      calls.push("awaitReplacementCaptureReady");
      return "ready";
    },
    reconcileCapture: (reason: string) => {
      calls.push(`reconcileCapture:${reason}`);
    },
    registerSuccessLineage: async () => {
      calls.push("registerSuccessLineage");
      return { ok: true };
    },
    publishReadyDescriptor: () => {
      calls.push("publishReadyDescriptor");
      return true;
    },
    log: () => {},
    warn: (message: string) => {
      warnings.push(message);
    },
    ...overrides,
  };

  return { ports, calls, warnings, spawned, switchedTo };
}

describe("executeHandoff", () => {
  it("spawns off-route, proves viability, switches, then kills the old child last", async () => {
    const h = makeHarness();
    const result = await executeHandoff(request(), h.ports);
    expect(result.kind).toBe("success");
    expect(h.calls).toEqual([
      "preHandoffStop",
      "spawnCandidate:new-2222",
      "awaitCandidateViable",
      "switchToCandidate",
      "registerSuccessLineage",
      "killOldChild",
      "awaitReplacementCaptureReady",
      "publishReadyDescriptor",
    ]);
    expect(h.switchedTo).toEqual(["new-2222"]);
  });

  it("never touches the old child before the replacement is proven", async () => {
    const order: string[] = [];
    const h = makeHarness({
      awaitCandidateViable: async () => {
        order.push("viability");
        return VIABLE;
      },
      killOldChild: async () => {
        order.push("kill");
        return { exited: true, pid: 12 };
      },
      switchToCandidate: () => {
        order.push("switch");
        return { switched: true, captureStarted: true };
      },
    });
    await executeHandoff(request(), h.ports);
    expect(order).toEqual(["viability", "switch", "kill"]);
  });

  it("retries a spawn failure while the old session is still live, then succeeds", async () => {
    let attempt = 0;
    const h = makeHarness({
      spawnCandidate: (sessionId: string) => {
        attempt += 1;
        if (attempt === 1) throw new Error("EAGAIN");
        return { sessionId, pid: 7000, child: { write: () => {} } };
      },
    });
    const result = await executeHandoff(request(), h.ports, { replacementAttempts: 2 });
    expect(result.kind).toBe("success");
    if (result.kind === "success") expect(result.attempts).toBe(2);
    expect(h.calls).not.toContain("killOldChild:never");
  });

  it("discards a candidate that dies and retries a fresh one", async () => {
    let attempt = 0;
    const h = makeHarness({
      awaitCandidateViable: async () => {
        attempt += 1;
        return attempt === 1
          ? { kind: "exited", evidence: { processAlive: false, sessionFileWritten: false } }
          : VIABLE;
      },
    });
    const result = await executeHandoff(request(), h.ports, { replacementAttempts: 2 });
    expect(result.kind).toBe("success");
    expect(h.spawned).toEqual(["new-2222", "new-2222"]);
    expect(h.calls.filter((c) => c.startsWith("discardCandidate")).length).toBe(1);
  });

  it("keeps the old session live and untouched when the replacement never becomes viable", async () => {
    const h = makeHarness({
      awaitCandidateViable: async () => ({
        kind: "no_output",
        evidence: { processAlive: false, sessionFileWritten: false },
      }),
    });
    const result = await executeHandoff(request(), h.ports, { replacementAttempts: 2 });
    expect(result.kind).toBe("replacement_nonviable");
    if (result.kind === "replacement_nonviable") {
      expect(result.attempts).toBe(2);
      expect(result.oldSessionId).toBe("old-1111");
    }
    // Nothing was switched, nothing was killed, nothing was undone.
    expect(h.calls).not.toContain("switchToCandidate");
    expect(h.calls).not.toContain("killOldChild");
    expect(h.calls).not.toContain("registerSuccessLineage");
  });

  it("a pre-handoff stop changes nothing: no spawn, no switch, no termination", async () => {
    const h = makeHarness();
    h.ports.preHandoffStop = () => {
      h.calls.push("preHandoffStop");
      return "wrapper exiting";
    };
    const result = await executeHandoff(request(), h.ports);
    expect(result).toEqual({ kind: "cancelled", reason: "wrapper exiting" });
    expect(h.calls).toEqual(["preHandoffStop"]);
  });

  it("does not require session-file evidence: process viability alone completes the swap", async () => {
    const h = makeHarness({
      awaitCandidateViable: async () => ({
        kind: "viable",
        evidence: { processAlive: true, sessionFileWritten: false },
      }),
    });
    const result = await executeHandoff(request(), h.ports);
    expect(result.kind).toBe("success");
    if (result.kind === "success") expect(result.evidence.sessionFileWritten).toBe(false);
  });

  it("an unkillable old child is orphaned loudly by PID; the replacement stays live", async () => {
    const h = makeHarness({ killOldChild: async () => ({ exited: false, pid: 31337 }) });
    const result = await executeHandoff(request(), h.ports);
    expect(result.kind).toBe("success");
    if (result.kind === "success") expect(result.orphanPid).toBe(31337);
    expect(h.warnings.join("\n")).toContain("ORPHANED old Claude child pid=31337");
  });

  it("lineage failure is a warning, never a rollback", async () => {
    const h = makeHarness({
      registerSuccessLineage: async () => ({ ok: false, reason: "readonly database" }),
    });
    const result = await executeHandoff(request(), h.ports);
    expect(result.kind).toBe("success");
    if (result.kind === "success") expect(result.lineageWarning).toContain("readonly database");
    expect(h.calls).toContain("killOldChild");
  });

  it("descriptor publish failure is a warning: retrieval stays fail-closed, the session lives", async () => {
    const h = makeHarness({ publishReadyDescriptor: () => false });
    const result = await executeHandoff(request(), h.ports);
    expect(result.kind).toBe("success");
    if (result.kind === "success") expect(result.descriptorWarning).toContain("fail-closed");
  });

  it("a capture generation that will not start does not kill the replacement — it reconciles", async () => {
    const h = makeHarness({
      switchToCandidate: () => ({
        switched: true,
        captureStarted: false,
        captureWarning: "replacement capture start failed: EIO",
      }),
    });
    const result = await executeHandoff(request(), h.ports);
    expect(result.kind).toBe("success");
    expect(h.calls).not.toContain("awaitReplacementCaptureReady");
    expect(h.calls.some((c) => c.startsWith("reconcileCapture"))).toBe(true);
  });

  it("a capture-ready timeout does not kill the replacement — it reconciles", async () => {
    const h = makeHarness({ awaitReplacementCaptureReady: async () => "timeout" });
    const result = await executeHandoff(request(), h.ports);
    expect(result.kind).toBe("success");
    if (result.kind === "success") expect(result.captureWarning).toContain("timeout");
    expect(h.calls).toContain("reconcileCapture:replacement capture timeout");
  });

  it("publishes the retrieval descriptor only after capture has caught up", async () => {
    const h = makeHarness();
    await executeHandoff(request(), h.ports);
    expect(h.calls.indexOf("publishReadyDescriptor")).toBeGreaterThan(
      h.calls.indexOf("awaitReplacementCaptureReady"),
    );
  });

  it("does not promote a candidate that died between proving viable and the switch", async () => {
    // The exit race: viability was real when it was observed, and the process
    // was gone by the time routing tried to move to it.
    const h = makeHarness({
      switchToCandidate: (candidate) => {
        h.calls.push("switchToCandidate");
        return { switched: false, reason: `candidate pid=${candidate.pid} exited before the switch` };
      },
    });
    const result = await executeHandoff(request(), h.ports, { replacementAttempts: 1 });

    expect(result.kind).toBe("replacement_nonviable");
    if (result.kind === "replacement_nonviable") {
      expect(result.reason).toContain("exited before the switch");
      expect(result.oldSessionId).toBe("old-1111");
    }
    // Nothing downstream of the switch ran: the old child was never killed, no
    // lineage advanced, no descriptor published, no capture generation moved.
    expect(h.calls).not.toContain("killOldChild");
    expect(h.calls).not.toContain("registerSuccessLineage");
    expect(h.calls).not.toContain("publishReadyDescriptor");
    expect(h.calls).not.toContain("awaitReplacementCaptureReady");
    expect(h.calls.some((c) => c.startsWith("reconcileCapture"))).toBe(false);
    expect(h.warnings.join("\n")).toContain("continues live, still routed and untouched");
  });

  it("does not promote a candidate that went missing before the switch", async () => {
    const h = makeHarness({
      switchToCandidate: () => {
        h.calls.push("switchToCandidate");
        return { switched: false, reason: "candidate went missing before the switch" };
      },
    });
    const result = await executeHandoff(request(), h.ports, { replacementAttempts: 1 });
    expect(result.kind).toBe("replacement_nonviable");
    expect(h.calls).not.toContain("killOldChild");
    expect(h.calls).not.toContain("registerSuccessLineage");
  });

  it("spawns exactly one candidate on the happy path", async () => {
    const spawn = vi.fn((sessionId: string) => ({ sessionId, pid: 1, child: { write: () => {} } }));
    const h = makeHarness({ spawnCandidate: spawn });
    await executeHandoff(request(), h.ports);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

/**
 * Past the switch the replacement is live and talking to the operator. Every
 * remaining port records what already happened, so one that throws produces a
 * warning — never a failed handoff, never a dead replacement.
 */
describe("exceptions after the switch", () => {
  const boom = (): never => {
    throw new Error("EIO");
  };

  const cases: Array<{
    name: string;
    ports: Partial<HandoffPorts>;
    detail: (result: Extract<HandoffResult, { kind: "success" }>) => string | undefined;
  }> = [
    {
      name: "lineage registration",
      ports: { registerSuccessLineage: async () => boom() },
      detail: (result) => result.lineageWarning,
    },
    {
      name: "old-child cleanup",
      ports: { killOldChild: async () => boom() },
      detail: (result) => result.oldChildWarning,
    },
    {
      name: "capture readiness",
      ports: { awaitReplacementCaptureReady: async () => boom() },
      detail: (result) => result.captureWarning,
    },
    {
      name: "capture reconciliation",
      ports: { awaitReplacementCaptureReady: async () => "timeout", reconcileCapture: () => boom() },
      detail: (result) => result.captureWarning,
    },
    {
      name: "ready descriptor publication",
      ports: { publishReadyDescriptor: () => boom() },
      detail: (result) => result.descriptorWarning,
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.name} throwing still yields a live replacement`, async () => {
      const h = makeHarness(testCase.ports);
      const result = await executeHandoff(request(), h.ports);

      expect(result.kind).toBe("success");
      if (result.kind !== "success") return;
      expect(result.newSessionId).toBe("new-2222");
      expect(testCase.detail(result)).toBeDefined();
      expect(h.warnings.join("\n")).toContain("EIO");
      // The switch stands and no discard was attempted on the live child.
      expect(h.switchedTo).toEqual(["new-2222"]);
      expect(h.calls.some((c) => c.startsWith("discardCandidate"))).toBe(false);
    });
  }

  it("keeps going through the remaining steps after an early throw", async () => {
    const h = makeHarness({ registerSuccessLineage: async () => boom() });
    const result = await executeHandoff(request(), h.ports);
    expect(result.kind).toBe("success");
    // Lineage blew up first; the old child was still cleaned up and the
    // descriptor still published.
    expect(h.calls).toContain("killOldChild");
    expect(h.calls).toContain("publishReadyDescriptor");
  });

  it("names the old child it could not clean up, and keeps the replacement", async () => {
    const h = makeHarness({
      killOldChild: async () => {
        throw new Error("ESRCH");
      },
    });
    const result = await executeHandoff(request(), h.ports);
    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.oldChildWarning).toContain("old-1111");
      expect(result.oldChildWarning).toContain("may still be running");
      expect(result.orphanPid).toBeUndefined();
    }
  });

  it("reports a repaint that failed during the switch without failing the swap", async () => {
    const h = makeHarness({
      switchToCandidate: (candidate) => {
        h.switchedTo.push(candidate.sessionId);
        return {
          switched: true,
          captureStarted: true,
          switchWarnings: ["replacement is routed but its first repaint failed: EIO"],
        };
      },
    });
    const result = await executeHandoff(request(), h.ports);
    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.switchWarnings).toEqual(["replacement is routed but its first repaint failed: EIO"]);
    }
    expect(h.calls).toContain("killOldChild");
  });
});

describe("formatHandoffResult", () => {
  it("names the live replacement", () => {
    expect(
      formatHandoffResult({
        kind: "success",
        newSessionId: "new-2222",
        evidence: { processAlive: true, sessionFileWritten: true },
        attempts: 1,
      }),
    ).toBe("handoff complete — session new-2222 live");
  });

  it("names an orphaned old child on an otherwise successful swap", () => {
    expect(
      formatHandoffResult({
        kind: "success",
        newSessionId: "new-2222",
        evidence: { processAlive: true, sessionFileWritten: false },
        attempts: 1,
        orphanPid: 4242,
      }),
    ).toContain("old child pid 4242 ORPHANED");
  });

  it("says the old session continues, and never says rolled back", () => {
    const text = formatHandoffResult({
      kind: "replacement_nonviable",
      reason: "attempt 1: candidate exited",
      attempts: 2,
      oldSessionId: "old-1111",
      rebuiltSessionId: "new-2222",
    });
    expect(text).toContain("session old-1111 continues live and unchanged");
    expect(text).not.toContain("rolled back");
  });
});
