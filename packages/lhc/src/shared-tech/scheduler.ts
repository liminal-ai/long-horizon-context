// SDK-internal scheduler and drain: the one component holding cross-operation
// in-memory state. The drain loop lives here: claim under BEGIN IMMEDIATE,
// dispatch through the handler map with no open transaction, and complete in a
// second short transaction. Background mode adds per-thread single-flight with
// pending-flag coalescing, post-commit pokes, first-touch catch-up, and
// drainSettled. The in-memory state is advisory only: cross-process safety
// comes from the durable lease alone, so a fresh handle sees identical drain
// behavior because the queue is the rows.
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
  DerivationCompletionError,
  type DurableWorkDispatcher,
  type DurableWorkOperation,
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
  retryClaimedItem,
  type WorkKind,
  type WorkSourceRef,
} from "./work-queue/index.js";

// The type of the thread DB opener function, injected by SDK wiring to avoid
// importing from the threads domain.
export type ThreadDbOpener = (path: string) => OpResult<DatabaseSync>;

export type SchedulerMode = "background" | "manual";

// Drain report shape. `superseded` never appears here: the cascade deletes
// superseded items and reports them on the mutation result; a drain never sees
// them.
export interface DrainReport {
  ran: Array<{
    workItemId: string;
    kind: WorkKind;
    sourceRef: WorkSourceRef;
    disposition: "done" | "failed_terminal" | "stale_discarded" | "lost_lease";
    attempts: number;
    reason?: string;
  }>;
  stoppedBecause: "empty" | "in_flight" | "waiting" | "max_items";
  waitingUntil?: string; // head's eligible_at when stoppedBecause = "waiting"
  claimExpiresAt?: string; // head's claim_expires_at when stoppedBecause = "in_flight"
  remaining: number; // live items left behind the stop point
}

export interface DrainDeps {
  lookupDispatcher: (operation: DurableWorkOperation | undefined, kind: string) => OpResult<DurableWorkDispatcher>;
  // Whether any handler is registered at all. Background scheduling is gated
  // on this, fail-closed: with an empty map a background drain could only
  // turn queued rows into failed_terminal — destruction, not processing — so
  // pokes and catch-up stay inert until a handler table is populated
  // explicitly.
  hasAnyHandler: () => boolean;
  config: ResolvedSdkConfig;
  // The thread DB opener, injected by SDK wiring to avoid importing from the
  // threads domain.
  openThreadDatabase: ThreadDbOpener;
}

function ranEntry(
  item: ClaimedWorkItem,
  disposition: "done" | "failed_terminal" | "stale_discarded" | "lost_lease",
  attempts: number,
  reason?: string,
): DrainReport["ran"][number] {
  const entry: DrainReport["ran"][number] = {
    workItemId: item.workItemId,
    kind: item.kind as WorkKind,
    sourceRef: item.sourceRef,
    disposition,
    attempts,
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

// The drain loop against an open handle. Claim → dispatch → complete, one
// item at a time, until the head stops it (empty / in_flight / waiting) or
// maxItems is reached. The handler runs with NO open transaction; the only
// exits from a handler failure are failAttempt and the terminal paths — the
// drain never catches an error and records success.
export async function drainOpenDb(
  db: DatabaseSync,
  deps: DrainDeps,
  opts?: { maxItems?: number },
  identity?: { threadId: string; filePath: string },
): Promise<DrainReport> {
  const { clock, lease, retry, inferenceCallbacks } = deps.config;
  const ran: DrainReport["ran"] = [];
  let stoppedBecause: DrainReport["stoppedBecause"];
  let waitingUntil: string | undefined;
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
    if (claim.outcome === "waiting") {
      stoppedBecause = "waiting";
      waitingUntil = claim.waitingUntil;
      break;
    }
    const item = claim.item;

    const lookedUp = deps.lookupDispatcher(item.operation, item.kind);
    if (!lookedUp.ok) {
      // Unregistered kind: the normal terminal transaction, not a try/catch
      // skip. failed_terminal with the stable code lands failed derivations
      // when resolvable from the payload, and the drain continues.
      const terminal = applyDerivationTerminalFailure(
        db,
        { ...item, workItemId: item.workItemId, claimEpoch: item.claimEpoch },
        {
          reason: lookedUp.error.code,
          state: "failed",
          attempts: item.attempts,
          now: clock().toISOString(),
        },
      );
      ran.push(
        terminal === "lost_lease"
          ? ranEntry(item, "lost_lease", item.attempts, lookedUp.error.code)
          : ranEntry(item, "failed_terminal", item.attempts, lookedUp.error.code),
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
        { ...item, workItemId: item.workItemId, claimEpoch: item.claimEpoch },
        {
          reason: "unknown_work_kind",
          state: "failed",
          attempts: item.attempts,
          now: clock().toISOString(),
        },
      );
      ran.push(
        terminal === "lost_lease"
          ? ranEntry(item, "lost_lease", item.attempts, "unknown_work_kind")
          : ranEntry(item, "failed_terminal", item.attempts, "unknown_work_kind"),
      );
      continue;
    }
    let outcome: Awaited<ReturnType<DurableWorkDispatcher>>;
    try {
      outcome = await lookedUp.value(run, dispatchItem);
    } catch (cause) {
      if (cause instanceof DerivationCompletionError) throw cause;
      // A throwing handler is a bug by the error contract, but the queue
      // must not wedge on it: route it through the normal retry path so it
      // counts attempts and exhausts visibly.
      const detail = cause instanceof Error ? cause.message : String(cause);
      outcome = { disposition: "failed", retryable: true, reason: `handler threw: ${detail}` };
    }

    if (
      outcome.disposition === "done" ||
      outcome.disposition === "stale_discarded" ||
      outcome.disposition === "lost_lease"
    ) {
      ran.push(ranEntry(item, outcome.disposition, item.attempts));
      continue;
    }
    if (outcome.disposition === "blocked") {
      const terminal = applyDerivationTerminalFailure(
        db,
        { ...item, workItemId: item.workItemId, claimEpoch: item.claimEpoch },
        {
          reason: outcome.reason,
          state: "blocked",
          attempts: item.attempts + 1,
          now: clock().toISOString(),
        },
      );
      if (terminal !== "lost_lease") {
        logDerivationExecution(identity, db, item.derivations, "terminal_failed", {
          reason: outcome.reason,
          attempts: item.attempts + 1,
        });
      }
      ran.push(
        terminal === "lost_lease"
          ? ranEntry(item, "lost_lease", item.attempts + 1, outcome.reason)
          : ranEntry(item, "failed_terminal", item.attempts + 1, outcome.reason),
      );
      continue;
    }
    if (outcome.disposition !== "failed") {
      throw new Error(`unknown durable work disposition ${(outcome as { disposition: string }).disposition}`);
    }
    if (outcome.disposition === "failed") {
      const attempts = item.attempts + 1;
      if (outcome.retryable && attempts < retry.budget) {
        const backoffMs = Math.min(retry.backoffBaseMs * 2 ** attempts, retry.backoffCapMs);
        const eligibleAt = new Date(Date.parse(clock().toISOString()) + backoffMs).toISOString();
        const owned = retryClaimedItem(db, item, { reason: outcome.reason, attempts, eligibleAt });
        if (!owned) {
          ran.push(ranEntry(item, "lost_lease", attempts, outcome.reason));
        } else {
          logDerivationExecution(identity, db, item.derivations, "retry_scheduled", {
            reason: outcome.reason,
            attempts,
          });
        }
      } else {
        const terminal = applyDerivationTerminalFailure(
          db,
          { ...item, workItemId: item.workItemId, claimEpoch: item.claimEpoch },
          {
            reason: outcome.reason,
            state: "failed",
            attempts,
            now: clock().toISOString(),
          },
        );
        if (terminal !== "lost_lease") {
          logDerivationExecution(identity, db, item.derivations, "terminal_failed", {
            reason: outcome.reason,
            attempts,
          });
        }
        ran.push(
          terminal === "lost_lease"
            ? ranEntry(item, "lost_lease", attempts, outcome.reason)
            : ranEntry(item, "failed_terminal", attempts, outcome.reason),
        );
      }
    }
    // Under budget the item went back to queued (possibly backing off); the
    // next claimNext re-reads the head — a backing-off head ends the drain
    // with "waiting" and gates everything behind it.
  }

  const report: DrainReport = { ran, stoppedBecause, remaining: countLiveItems(db) };
  if (waitingUntil !== undefined) report.waitingUntil = waitingUntil;
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

// The drain operation against a thread file: open (validates + migrates),
// drain, close. Both the SDK's work.drain and the background loop's passes
// run through here — manual and background modes share one drain.
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
  passes: number; // test-only observability (TC-1.2); must not become API
  waiters: Array<() => void>;
  // At most one pending wake per thread; used for both backoff eligibility and
  // claim expiry. A poke or newer wake clears it. unref'd so it never keeps
  // the process alive. Background only — manual never reaches the drain loop.
  wakeTimer: ReturnType<typeof scheduleTimer> | undefined;
}

// A wake floored to a sane minimum: an already-past wake target must nudge
// once, not busy-spin (the durable claimNext gate is the real guard).
const WAKE_MIN_DELAY_MS = 5;

export interface Scheduler {
  readonly mode: SchedulerMode;
  // Post-commit nudge that work was queued for a thread. Manual mode is no-op
  // by contract. Background mode starts a drain, or coalesces into the pending
  // flag if one is already running for the thread.
  poke(threadId: string): void;
  // Thread-file open announcement: learns threadId → filePath and, on the first
  // touch of a thread this process lifetime, schedules catch-up if the queue
  // has leftover live work.
  touch(filePath: string, db: DatabaseSync): void;
  // Resolves when the scheduler has no running or pending drain for the
  // thread (issue 3). Manual mode resolves immediately.
  drainSettled(threadId: string): Promise<void>;
  // Test-only observability for coalescing exactness (TC-1.2): drain passes
  // started for a thread. Named as a test hook on purpose — not API.
  testPassCount(threadId: string): number;
}

function readThreadId(db: DatabaseSync): string | null {
  const row = db.prepare("SELECT thread_id FROM thread_metadata WHERE id = 1").get() as
    | { thread_id: string }
    | undefined;
  return row?.thread_id ?? null;
}

// Read a thread file's id without side effects (no migration, no touch) —
// drainSettled must observe scheduler state, never schedule work.
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
  const seen = new Set<string>(); // first-touch catch-up guard, process lifetime

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

  // Arm the lone scheduler wake: when a background pass stops on retry backoff
  // or an unexpired claim, schedule one nudge at the row's next check time
  // through the existing poke path. The delay reads the SDK clock seam; a bad
  // timestamp degrades to the minimum delay, while correctness still rides
  // claimNext's durable gate.
  function armWake(st: ThreadDrainState, wakeAt: string): void {
    clearWake(st);
    const nowMs = deps.config.clock().getTime();
    const parsed = Date.parse(wakeAt);
    const delay = Number.isFinite(parsed) ? Math.max(WAKE_MIN_DELAY_MS, parsed - nowMs) : WAKE_MIN_DELAY_MS;
    const timer = scheduleTimer(() => {
      st.wakeTimer = undefined;
      schedule(st.threadId);
    }, delay);
    timer.unref();
    st.wakeTimer = timer;
  }

  function nextWakeAt(report: DrainReport | undefined): string | undefined {
    if (report?.stoppedBecause === "waiting") return report.waitingUntil;
    if (report?.stoppedBecause === "in_flight") return report.claimExpiresAt;
    return undefined;
  }

  async function runLoop(st: ThreadDrainState): Promise<void> {
    // Defer past the committing operation's synchronous tail so the drain
    // never contends with the transaction whose commit scheduled it.
    await new Promise((resolve) => scheduleMacrotask(resolve));
    let lastReport: DrainReport | undefined;
    try {
      do {
        st.pending = false;
        st.passes += 1;
        // A failed pass (storage error) has no caller to report to in
        // background mode; the durable rows are untouched and the next poke
        // or touch retries. A pass stopping on "waiting" or "in_flight" leaves
        // a head that has a known next-check timestamp handled below.
        const result = await runDrain(st.filePath, deps);
        lastReport = result.ok ? result.value : undefined;
      } while (st.pending);
    } finally {
      st.running = false;
      // Honor retry eligibility and claim expiry in background mode. Either
      // stop can leave a head that no later poke is guaranteed to revisit, so
      // keep the thread unsettled until the timer fires and re-enters schedule.
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
    // A poke (or the wake itself) supersedes any pending backoff wake — we are
    // about to drain or coalesce, so the timer's job is done (one wake max).
    clearWake(st);
    if (st.filePath === "") return; // never touched here: no path to drain
    if (st.running) {
      st.pending = true; // burst coalesce: at most one further pass
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
      // Catch-up: leftover live work from a previous process runs on first
      // touch. One indexed query on the already-open handle keeps the
      // empty-queue case cheap.
      if (deps.hasAnyHandler() && countLiveItems(db) > 0) schedule(threadId);
    },
    drainSettled(threadId: string): Promise<void> {
      const st = states.get(threadId);
      // A pending backoff wake counts as unsettled (Fix 1): the retry it will
      // fire is part of this drain cycle, so the awaitable must span it.
      if (st === undefined || (!st.running && !st.pending && st.wakeTimer === undefined)) {
        return Promise.resolve();
      }
      return new Promise((resolve) => st.waiters.push(resolve));
    },
    testPassCount(threadId: string): number {
      return states.get(threadId)?.passes ?? 0;
    },
  };
}
