import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  clearTimeout as cancelTimer,
  setImmediate as scheduleMacrotask,
  setTimeout as scheduleTimer,
} from "node:timers";
import type { ResolvedSdkConfig } from "./derivation.js";
import {
  applyDerivationTerminalFailure,
  CLAIM_EXPIRED_REPEATEDLY,
  DerivationCompletionError,
  type DurableWorkDispatcher,
  type DurableWorkOperation,
  failRepeatedlyExpiredClaim,
} from "./durable-work/index.js";
import { type ErrorResult, type OpResult, storageFailure } from "./errors.js";
import {
  appendDerivationLog,
  type DerivationLogEventKind,
  type DerivationLogPayload,
} from "./logging/derivation-log.js";
import {
  type ClaimedWorkItem,
  claimNext,
  countLiveItems,
  requeueExpiredClaim,
  type WorkKind,
  type WorkSourceRef,
} from "./work-queue/index.js";

export type ThreadDbOpener = (path: string) => OpResult<DatabaseSync>;

export type SchedulerMode = "background" | "manual";

export interface DrainReport {
  ran: Array<{
    workItemId: string;
    kind: WorkKind;
    sourceRef: WorkSourceRef;
    disposition: "done" | "failed_terminal" | "stale_discarded" | "lost_lease";
    reason?: string;
  }>;
  stoppedBecause: "empty" | "in_flight" | "max_items";
  claimExpiresAt?: string;
  remaining: number;
}

export interface DrainDeps {
  lookupDispatcher: (operation: DurableWorkOperation | undefined, kind: string) => OpResult<DurableWorkDispatcher>;
  hasAnyHandler: () => boolean;
  config: ResolvedSdkConfig;
  openThreadDatabase: ThreadDbOpener;
}

function ranEntry(
  item: ClaimedWorkItem,
  disposition: "done" | "failed_terminal" | "stale_discarded" | "lost_lease",
  reason?: string,
): DrainReport["ran"][number] {
  const entry: DrainReport["ran"][number] = {
    workItemId: item.workItemId,
    kind: item.kind as WorkKind,
    sourceRef: item.sourceRef,
    disposition,
  };
  if (reason !== undefined) entry.reason = reason;
  return entry;
}

function logDerivationExecution(
  identity: { threadId: string; filePath: string } | undefined,
  db: DatabaseSync,
  derivations: ClaimedWorkItem["derivations"],
  eventKind: DerivationLogEventKind,
  payload: DerivationLogPayload,
): void {
  if (identity === undefined || derivations.length === 0) return;
  for (const target of derivations) {
    appendDerivationLog(
      { db, threadId: identity.threadId, filePath: identity.filePath },
      { target, eventKind, payload },
    );
  }
}

export async function drainOpenDb(
  db: DatabaseSync,
  deps: DrainDeps,
  opts?: { maxItems?: number },
  identity?: { threadId: string; filePath: string },
): Promise<DrainReport> {
  const { clock, lease, inferenceCallbacks } = deps.config;
  const ran: DrainReport["ran"] = [];
  let stoppedBecause: DrainReport["stoppedBecause"];
  let claimExpiresAt: string | undefined;

  for (;;) {
    if (opts?.maxItems !== undefined && ran.length >= opts.maxItems) {
      stoppedBecause = "max_items";
      break;
    }
    const claim = claimNext(db, clock().toISOString(), lease.durationMs);
    if (claim.outcome === "empty") {
      stoppedBecause = "empty";
      break;
    }
    if (claim.outcome === "in_flight") {
      stoppedBecause = "in_flight";
      claimExpiresAt = claim.claimExpiresAt;
      break;
    }
    const item = claim.item;
    if (claim.outcome === "expired") {
      const requeue = requeueExpiredClaim(db, item, clock().toISOString());
      if (requeue.outcome !== "repeated") continue;
      const reason = CLAIM_EXPIRED_REPEATEDLY;
      const terminal = failRepeatedlyExpiredClaim(db, item, clock().toISOString());
      if (terminal !== "lost_lease") {
        logDerivationExecution(identity, db, item.derivations, "terminal_failed", { reason });
      }
      ran.push(
        terminal === "lost_lease" ? ranEntry(item, "lost_lease", reason) : ranEntry(item, "failed_terminal", reason),
      );
      continue;
    }

    const lookedUp = deps.lookupDispatcher(item.operation, item.kind);
    if (!lookedUp.ok) {
      const terminal = applyDerivationTerminalFailure(
        db,
        { ...item, workItemId: item.workItemId },
        {
          reason: lookedUp.error.code,
          state: "failed",
          now: clock().toISOString(),
        },
      );
      ran.push(
        terminal === "lost_lease"
          ? ranEntry(item, "lost_lease", lookedUp.error.code)
          : ranEntry(item, "failed_terminal", lookedUp.error.code),
      );
      continue;
    }

    const run = {
      threadId: identity?.threadId ?? "",
      filePath: identity?.filePath ?? "",
      openDb: () => db,
      inferenceCallbacks,
      clock,
      config: deps.config,
    };
    const dispatchItem = item.operation === undefined ? undefined : { ...item, operation: item.operation };
    if (dispatchItem === undefined) {
      const terminal = applyDerivationTerminalFailure(
        db,
        { ...item, workItemId: item.workItemId },
        {
          reason: "unknown_work_kind",
          state: "failed",
          now: clock().toISOString(),
        },
      );
      ran.push(
        terminal === "lost_lease"
          ? ranEntry(item, "lost_lease", "unknown_work_kind")
          : ranEntry(item, "failed_terminal", "unknown_work_kind"),
      );
      continue;
    }
    let outcome: Awaited<ReturnType<DurableWorkDispatcher>>;
    try {
      outcome = await lookedUp.value(run, dispatchItem);
    } catch (cause) {
      if (cause instanceof DerivationCompletionError) throw cause;
      const detail = cause instanceof Error ? cause.message : String(cause);
      outcome = { disposition: "failed", reason: `handler threw: ${detail}` };
    }

    if (
      outcome.disposition === "done" ||
      outcome.disposition === "stale_discarded" ||
      outcome.disposition === "lost_lease"
    ) {
      ran.push(ranEntry(item, outcome.disposition));
      continue;
    }
    if (outcome.disposition === "blocked") {
      const terminal = applyDerivationTerminalFailure(
        db,
        { ...item, workItemId: item.workItemId },
        {
          reason: outcome.reason,
          state: "blocked",
          now: clock().toISOString(),
        },
      );
      if (terminal !== "lost_lease") {
        logDerivationExecution(identity, db, item.derivations, "terminal_failed", {
          reason: outcome.reason,
        });
      }
      ran.push(
        terminal === "lost_lease"
          ? ranEntry(item, "lost_lease", outcome.reason)
          : ranEntry(item, "failed_terminal", outcome.reason),
      );
      continue;
    }
    if (outcome.disposition !== "failed") {
      throw new Error(`unknown durable work disposition ${(outcome as { disposition: string }).disposition}`);
    }
    if (outcome.disposition === "failed") {
      const terminal = applyDerivationTerminalFailure(
        db,
        { ...item, workItemId: item.workItemId },
        {
          reason: outcome.reason,
          state: "failed",
          now: clock().toISOString(),
        },
      );
      if (terminal !== "lost_lease") {
        logDerivationExecution(identity, db, item.derivations, "terminal_failed", {
          reason: outcome.reason,
        });
      }
      ran.push(
        terminal === "lost_lease"
          ? ranEntry(item, "lost_lease", outcome.reason)
          : ranEntry(item, "failed_terminal", outcome.reason),
      );
    }
  }

  const report: DrainReport = { ran, stoppedBecause, remaining: countLiveItems(db) };
  if (claimExpiresAt !== undefined) report.claimExpiresAt = claimExpiresAt;
  return report;
}

function threadNotFound(filePath: string): { ok: false; error: ErrorResult } {
  return {
    ok: false,
    error: {
      errorClass: "caller_error",
      code: "thread_not_found",
      reason: `no thread file exists at ${filePath}`,
    },
  };
}

export async function runDrain(
  filePath: string,
  deps: DrainDeps,
  opts?: { maxItems?: number },
): Promise<OpResult<DrainReport>> {
  if (!existsSync(filePath)) return threadNotFound(filePath);
  const opened = deps.openThreadDatabase(filePath);
  if (!opened.ok) return opened;
  const db = opened.value;
  try {
    const threadId = readThreadId(db);
    if (threadId === null) return storageFailure(`thread file at ${filePath} lost its metadata row`);
    return { ok: true, value: await drainOpenDb(db, deps, opts, { threadId, filePath }) };
  } catch (cause) {
    if (cause instanceof DerivationCompletionError) {
      return {
        ok: false,
        error: { errorClass: cause.errorClass, code: cause.code, reason: cause.message },
      };
    }
    const detail = cause instanceof Error ? cause.message : String(cause);
    return storageFailure(`drain failed: ${detail}`);
  } finally {
    db.close();
  }
}

interface ThreadDrainState {
  threadId: string;
  filePath: string;
  running: boolean;
  pending: boolean;
  passes: number;
  waiters: Array<() => void>;
  wakeTimer: ReturnType<typeof scheduleTimer> | undefined;
}

const WAKE_MIN_DELAY_MS = 5;

export interface Scheduler {
  readonly mode: SchedulerMode;
  poke(threadId: string): void;
  touch(filePath: string, db: DatabaseSync): void;
  drainSettled(threadId: string): Promise<void>;
  testPassCount(threadId: string): number;
}

function readThreadId(db: DatabaseSync): string | null {
  const row = db.prepare("SELECT thread_id FROM thread_metadata WHERE id = 1").get() as
    | { thread_id: string }
    | undefined;
  return row?.thread_id ?? null;
}

export function peekThreadId(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(filePath, { readOnly: true });
    return readThreadId(db);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export function createScheduler(mode: SchedulerMode, deps: DrainDeps): Scheduler {
  const states = new Map<string, ThreadDrainState>();
  const seen = new Set<string>();

  function stateFor(threadId: string): ThreadDrainState {
    let st = states.get(threadId);
    if (st === undefined) {
      st = {
        threadId,
        filePath: "",
        running: false,
        pending: false,
        passes: 0,
        waiters: [],
        wakeTimer: undefined,
      };
      states.set(threadId, st);
    }
    return st;
  }

  function clearWake(st: ThreadDrainState): void {
    if (st.wakeTimer !== undefined) {
      cancelTimer(st.wakeTimer);
      st.wakeTimer = undefined;
    }
  }

  function armWake(st: ThreadDrainState, wakeAt: string): void {
    clearWake(st);
    const nowMs = deps.config.clock().getTime();
    const parsed = Date.parse(wakeAt);
    const delay = Number.isFinite(parsed) ? Math.max(WAKE_MIN_DELAY_MS, parsed - nowMs) : WAKE_MIN_DELAY_MS;
    const timer = scheduleTimer(() => {
      st.wakeTimer = undefined;
      schedule(st.threadId);
    }, delay);
    if (st.waiters.length === 0) timer.unref();
    st.wakeTimer = timer;
  }

  function nextWakeAt(report: DrainReport | undefined): string | undefined {
    if (report?.stoppedBecause === "in_flight") return report.claimExpiresAt;
    return undefined;
  }

  async function runLoop(st: ThreadDrainState): Promise<void> {
    await new Promise((resolve) => scheduleMacrotask(resolve));
    let lastReport: DrainReport | undefined;
    try {
      do {
        st.pending = false;
        st.passes += 1;
        const result = await runDrain(st.filePath, deps);
        lastReport = result.ok ? result.value : undefined;
      } while (st.pending);
    } finally {
      st.running = false;
      const wakeAt = nextWakeAt(lastReport);
      if (st.wakeTimer === undefined && wakeAt !== undefined) {
        armWake(st, wakeAt);
      } else {
        for (const waiter of st.waiters.splice(0)) waiter();
      }
    }
  }

  function schedule(threadId: string): void {
    const st = stateFor(threadId);
    clearWake(st);
    if (st.filePath === "") return;
    if (st.running) {
      st.pending = true;
      return;
    }
    st.running = true;
    void runLoop(st);
  }

  return {
    mode,
    poke(threadId: string): void {
      if (mode !== "background") return;
      if (!deps.hasAnyHandler()) return;
      schedule(threadId);
    },
    touch(filePath: string, db: DatabaseSync): void {
      if (mode !== "background") return;
      const threadId = readThreadId(db);
      if (threadId === null) return;
      const st = stateFor(threadId);
      st.filePath = filePath;
      if (seen.has(threadId)) return;
      seen.add(threadId);
      if (deps.hasAnyHandler() && countLiveItems(db) > 0) schedule(threadId);
    },
    drainSettled(threadId: string): Promise<void> {
      const st = states.get(threadId);
      if (st === undefined || (!st.running && !st.pending && st.wakeTimer === undefined)) {
        return Promise.resolve();
      }
      st.wakeTimer?.ref();
      return new Promise((resolve) => st.waiters.push(resolve));
    },
    testPassCount(threadId: string): number {
      return states.get(threadId)?.passes ?? 0;
    },
  };
}
