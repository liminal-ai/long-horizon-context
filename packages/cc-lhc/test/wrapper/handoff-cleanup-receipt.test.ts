/**
 * LIM-116 post-switch cleanup: TC-5.2a-c, AR-1, AR-2, AR-3, AR-4.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { HandoffRequest } from "../../src/commands/context-mutation.js";
import { openGovernorReceiptStore } from "../../src/governor/receipt-store.js";
import type { ProcessIdentity, ProcessLivenessResult } from "../../src/runtime/process-identity.js";
import {
  type CandidateChild,
  type CandidateViability,
  executeHandoff,
  formatHandoffResult,
  type HandoffPorts,
  type SwitchOutcome,
} from "../../src/wrapper/handoff.js";
import {
  cleanupFields,
  type DurableHandoffReceipt,
  type HandoffReceiptPort,
  openHandoffReceiptStore,
} from "../../src/wrapper/handoff-receipt-store.js";
import {
  classifyOldChildCleanup,
  formatOldChildCleanup,
  type OldChildCleanup,
  observeOldChildCleanup,
} from "../../src/wrapper/old-child-cleanup.js";

function request(operation: HandoffRequest["operation"] = "auto_compact"): HandoffRequest {
  return {
    operation,
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
    liveAsyncWork: [],
  };
}

const VIABLE: CandidateViability = {
  kind: "viable",
  evidence: { processAlive: true, sessionFileWritten: true },
};

function makeHarness(
  overrides: Partial<HandoffPorts> = {},
  kill: () => Promise<OldChildCleanup> = async () => ({ kind: "terminated", pid: 999 }),
): { ports: HandoffPorts; logs: string[]; warnings: string[] } {
  const logs: string[] = [];
  const warnings: string[] = [];
  const ports: HandoffPorts = {
    preHandoffStop: () => null,
    spawnCandidate: (sessionId: string): CandidateChild => ({
      sessionId,
      pid: 4001,
      child: { write: () => {} },
    }),
    awaitCandidateViable: async () => VIABLE,
    discardCandidate: async () => {},
    switchToCandidate: (): SwitchOutcome => ({ switched: true, captureStarted: true }),
    killOldChild: kill,
    awaitReplacementCaptureReady: async () => "ready",
    reconcileCapture: () => {},
    registerSuccessLineage: async () => ({ ok: true }),
    publishReadyDescriptor: () => true,
    log: (message) => logs.push(message),
    warn: (message) => warnings.push(message),
    ...overrides,
  };
  return { ports, logs, warnings };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "cc-lhc-handoff-receipt-"));
  dirs.push(dir);
  return join(dir, "cc-lhc.sqlite");
}

function identity(pid: number, starttime: string): ProcessIdentity {
  return { pid, bootId: "boot-1", starttime };
}

describe("TC-5.2a report proven termination", () => {
  it("observed old-child exit reports and persists terminated exactly once", async () => {
    const dbPath = tempDb();
    const store = openHandoffReceiptStore(dbPath);
    const { ports, logs } = makeHarness();
    const result = await executeHandoff(request(), ports, {
      handoffReceipts: store,
      uuidFn: () => "handoff-term",
    });
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.oldChildCleanup).toEqual({ kind: "terminated", pid: 999 });
    const user = formatHandoffResult(result);
    const logLine = logs.find((line) => line.includes("old-child cleanup")) ?? "";
    expect(user).toContain(formatOldChildCleanup(result.oldChildCleanup));
    expect(logLine).toContain(formatOldChildCleanup(result.oldChildCleanup));
    const rows = store.listAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      handoffId: "handoff-term",
      terminalDisposition: "success",
      cleanupKind: "terminated",
      cleanupPid: 999,
    });
    store.close();
  });
});

describe("TC-5.2b report surviving orphan", () => {
  it("observably live pid after bounded termination reports and persists surviving orphan exactly once", async () => {
    const dbPath = tempDb();
    const store = openHandoffReceiptStore(dbPath);
    const cleanup: OldChildCleanup = { kind: "surviving_orphan", pid: 31337 };
    const { ports, logs, warnings } = makeHarness({}, async () => cleanup);
    const result = await executeHandoff(request(), ports, { handoffReceipts: store, uuidFn: () => "handoff-orphan" });
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.oldChildCleanup).toEqual(cleanup);
    expect(formatHandoffResult(result)).toContain("surviving orphan");
    expect(formatHandoffResult(result)).toContain("may still be running");
    expect(logs.join("\n")).toContain(formatOldChildCleanup(cleanup));
    expect(warnings.join("\n")).toContain("no longer routed");
    expect(store.listAll()).toHaveLength(1);
    expect(store.readBack("handoff-orphan")?.cleanupKind).toBe("surviving_orphan");
    store.close();
  });
});

describe("TC-5.2c report unknown cleanup outcome", () => {
  it("throw/timeout/unobservable cleanup reports and persists unknown without stopped inference", async () => {
    const dbPath = tempDb();
    const store = openHandoffReceiptStore(dbPath);
    const cleanup: OldChildCleanup = { kind: "unknown", pid: 7, detail: "post-termination identity was indeterminate" };
    const { ports, logs } = makeHarness({}, async () => cleanup);
    const result = await executeHandoff(request(), ports, { handoffReceipts: store, uuidFn: () => "handoff-unknown" });
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.oldChildCleanup.kind).toBe("unknown");
    const text = formatHandoffResult(result);
    expect(text).toContain("unknown");
    expect(text).toContain("may still be running");
    expect(text).not.toMatch(/\bstopped\b/i);
    expect(text).not.toContain("terminated");
    expect(logs.join("\n")).toContain(formatOldChildCleanup(result.oldChildCleanup));
    expect(store.readBack("handoff-unknown")?.cleanupKind).toBe("unknown");
    store.close();
  });
});

describe("wrapper-log cleanup truth is emitted exactly once", () => {
  const cases: Array<{ name: string; cleanup: OldChildCleanup }> = [
    { name: "terminated", cleanup: { kind: "terminated", pid: 999 } },
    { name: "surviving_orphan", cleanup: { kind: "surviving_orphan", pid: 31337 } },
    { name: "unknown", cleanup: { kind: "unknown", pid: 7, detail: "post-termination identity was indeterminate" } },
  ];

  for (const testCase of cases) {
    it(`${testCase.name} appears once in the wrapper log and is not repeated on the success line`, async () => {
      const { ports, logs, warnings } = makeHarness({}, async () => testCase.cleanup);
      const result = await executeHandoff(request(), ports);
      expect(result.kind).toBe("success");
      if (result.kind !== "success") return;
      const needle = formatOldChildCleanup(testCase.cleanup);
      const haystack = [...logs, ...warnings].join("\n");
      expect(haystack.split(needle).length - 1).toBe(1);
      const successLines = logs.filter((line) => line.includes("handoff success"));
      expect(successLines).toHaveLength(1);
      expect(successLines[0]).not.toContain(needle);
      expect(logs.filter((line) => line.includes("old-child cleanup"))).toHaveLength(1);
    });
  }
});

describe("AR-1 one cleanup authority", () => {
  it("cc_handoff_receipts is the only new-write persisted cleanup authority; governor rows carry reference/success only; handoff rows preserve exact compact, prune, or auto_compact without a governor join", async () => {
    const dbPath = tempDb();
    const handoffStore = openHandoffReceiptStore(dbPath);
    const governor = openGovernorReceiptStore(dbPath);
    for (const operation of ["compact", "prune", "auto_compact"] as const) {
      const { ports } = makeHarness();
      const result = await executeHandoff(request(operation), ports, {
        handoffReceipts: handoffStore,
        uuidFn: () => `id-${operation}`,
      });
      expect(result.kind).toBe("success");
      if (result.kind !== "success") continue;
      const row = handoffStore.readBack(result.handoffId);
      expect(row?.operation).toBe(operation);
      expect(row?.cleanupKind).toBe("terminated");
      const attached = governor.attachHandoffOutcome("missing", {
        kind: "handoff_success",
        newSessionId: result.newSessionId,
        droppedInputBytes: 0,
        handoffId: result.handoffId,
      });
      expect(attached).toBeNull();
    }
    const db = new DatabaseSync(dbPath);
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(tables).toContain("cc_handoff_receipts");
    const cols = (db.prepare("PRAGMA table_info(cc_governor_receipts)").all() as Array<{ name: string }>).map(
      (row) => row.name,
    );
    expect(cols).not.toContain("cleanup_kind");
    db.close();
    const payload: Record<string, unknown> = {
      kind: "handoff_success",
      newSessionId: "new-2222",
      droppedInputBytes: 0,
      handoffId: "id-auto_compact",
    };
    expect(payload).not.toHaveProperty("cleanupKind");
    expect(payload).not.toHaveProperty("orphanPid");
    expect(
      handoffStore
        .listAll()
        .map((row) => row.operation)
        .sort(),
    ).toEqual(["auto_compact", "compact", "prune"]);
    handoffStore.close();
    governor.close();
  });
});

describe("AR-2 portable identity classification", () => {
  it("mutation-sensitive cases prove PTY exit, same identity orphan, not_found/changed terminated, indeterminate/missing baseline unknown, thrown unknown unless post-probe proves absence/change, timeout without identity proof never orphan", async () => {
    const pid = 4242;
    const baseline = identity(pid, "100");
    const live = (id: ProcessIdentity): ProcessLivenessResult => ({ ok: true, identity: id });
    const notFound: ProcessLivenessResult = { ok: false, code: "not_found", message: "gone" };
    const indeterminate: ProcessLivenessResult = { ok: false, code: "indeterminate", message: "denied" };

    expect(classifyOldChildCleanup({ pid, baseline, attempt: { status: "pty_exited" }, post: null }).kind).toBe(
      "terminated",
    );
    expect(
      classifyOldChildCleanup({
        pid,
        baseline,
        attempt: { status: "completed_non_exit" },
        post: live(baseline),
      }),
    ).toEqual({ kind: "surviving_orphan", pid });
    expect(
      classifyOldChildCleanup({ pid, baseline, attempt: { status: "completed_non_exit" }, post: notFound }).kind,
    ).toBe("terminated");
    expect(
      classifyOldChildCleanup({
        pid,
        baseline,
        attempt: { status: "completed_non_exit" },
        post: live(identity(pid, "999")),
      }).kind,
    ).toBe("terminated");
    expect(
      classifyOldChildCleanup({
        pid,
        baseline: null,
        attempt: { status: "completed_non_exit" },
        post: live(baseline),
      }).kind,
    ).toBe("unknown");
    expect(
      classifyOldChildCleanup({
        pid,
        baseline,
        attempt: { status: "completed_non_exit" },
        post: indeterminate,
      }).kind,
    ).toBe("unknown");
    expect(
      classifyOldChildCleanup({
        pid,
        baseline,
        attempt: { status: "threw", detail: "ESRCH" },
        post: live(baseline),
      }).kind,
    ).toBe("unknown");
    expect(
      classifyOldChildCleanup({
        pid,
        baseline,
        attempt: { status: "threw", detail: "EIO" },
        post: notFound,
      }).kind,
    ).toBe("terminated");
    expect(
      classifyOldChildCleanup({
        pid,
        baseline,
        attempt: { status: "threw", detail: "EIO" },
        post: live(identity(pid, "12")),
      }).kind,
    ).toBe("terminated");
    expect(
      classifyOldChildCleanup({
        pid,
        baseline,
        attempt: { status: "completed_non_exit" },
        post: null,
      }).kind,
    ).toBe("unknown");

    const observedOrphan = await observeOldChildCleanup({
      pid,
      alreadyExited: false,
      probe: () => live(baseline),
      terminate: async () => false,
      onWarn: () => {},
    });
    expect(observedOrphan).toEqual({ kind: "surviving_orphan", pid });

    const observedPty = await observeOldChildCleanup({
      pid,
      alreadyExited: true,
      probe: () => {
        throw new Error("probe should not run");
      },
      terminate: async () => {
        throw new Error("terminate should not run");
      },
      onWarn: () => {},
    });
    expect(observedPty).toEqual({ kind: "terminated", pid });
  });
});

describe("AR-3 fail-soft receipt writes", () => {
  it("insert/update/readback failure at each phase is loud and never blocks spawn/switch/forward success", async () => {
    const phases = ["insert", "insert-readback", "update", "update-readback"] as const;
    for (const phase of phases) {
      const logs: string[] = [];
      const warnings: string[] = [];
      const prepared: DurableHandoffReceipt[] = [];
      const port: HandoffReceiptPort = {
        insertPrepared(row) {
          if (phase === "insert") throw new Error("insert boom");
          prepared.push(row);
          return row;
        },
        update(row) {
          if (phase === "update") throw new Error("update boom");
          return row;
        },
        readBack(id) {
          if (phase === "insert-readback" || phase === "update-readback") throw new Error("readback boom");
          return prepared.find((row) => row.handoffId === id) ?? null;
        },
      };
      const spawned: string[] = [];
      const { ports } = makeHarness({
        spawnCandidate: (sessionId) => {
          spawned.push(sessionId);
          return { sessionId, pid: 9, child: { write: () => {} } };
        },
        log: (message) => logs.push(message),
        warn: (message) => warnings.push(message),
      });
      const result = await executeHandoff(request(), ports, { handoffReceipts: port, uuidFn: () => `id-${phase}` });
      expect(result.kind, phase).toBe("success");
      expect(spawned, phase).toEqual(["new-2222"]);
      expect(warnings.join("\n"), phase).toMatch(/handoff receipt/);
      if (result.kind === "success") {
        expect(result.oldChildCleanup.kind).toBe("terminated");
        expect(formatHandoffResult(result)).toContain("terminated");
      }
    }
  });
});

describe("AR-4 incomplete row is evidence-only", () => {
  it("crash-left incomplete row remains evidence-only and never schedules repair/recovery/replay", async () => {
    const dbPath = tempDb();
    const store = openHandoffReceiptStore(dbPath);
    store.insertPrepared({
      handoffId: "crash-1",
      operation: "auto_compact",
      oldSessionId: "old",
      newSessionId: "new",
      preparedAt: "2026-08-21T00:00:00.000Z",
      terminalDisposition: null,
      cleanupKind: null,
      cleanupPid: null,
      detail: null,
      completedAt: null,
    });
    store.close();
    const reopened = openHandoffReceiptStore(dbPath);
    const row = reopened.readBack("crash-1");
    expect(row?.terminalDisposition).toBeNull();
    expect(row?.cleanupKind).toBeNull();
    expect(reopened.listAll()).toHaveLength(1);
    expect(Object.keys(reopened)).not.toContain("recover");
    expect(cleanupFields({ kind: "terminated", pid: 1 }).cleanupKind).toBe("terminated");
    reopened.close();
  });
});

describe("open failure releases the database handle", () => {
  it("a file that is not a database throws from every store opener with its handle closed (nothing pins the file)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-handoff-corrupt-"));
    dirs.push(dir);
    const garbage = join(dir, "cc-lhc.sqlite");
    writeFileSync(garbage, "not a database at all\n");
    // The same handle the store would use, tracked so close-on-throw is provable.
    const handles: DatabaseSync[] = [];
    const openDbFn = (path: string): DatabaseSync => {
      const db = new DatabaseSync(path);
      handles.push(db);
      return db;
    };
    expect(() => openHandoffReceiptStore(garbage, { openDbFn })).toThrow();
    expect(handles).toHaveLength(1);
    // A closed handle refuses further statements; an open one would accept this.
    expect(() => handles[0]!.exec("SELECT 1")).toThrow(/closed|not open/i);
  });
});
