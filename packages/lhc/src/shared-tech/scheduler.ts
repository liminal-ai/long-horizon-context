// SDK-internal scheduler and drain (DD-4): the one component holding
// cross-operation in-memory state. The drain loop lives here per the tech
// design's placement — claim under BEGIN IMMEDIATE, dispatch through the
// handler map with no open transaction (the inference call lives there),
// complete in a second short transaction. Background mode adds per-thread
// single-flight with pending-flag coalescing, post-commit pokes, first-touch
// catch-up (DD-10), and drainSettled (issue 3). The in-memory state is
// advisory only: cross-process safety comes from the durable lease alone, so
// a fresh handle sees identical drain behavior — the queue is the rows.
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  clearTimeout as cancelTimer,
  setImmediate as scheduleMacrotask,
  setTimeout as scheduleTimer,
} from "node:timers";
import type { HandlerOutcome, ResolvedSdkConfig, WorkHandler } from "./derivation.js";
import { type ErrorResult, type OpResult, storageFailure } from "./errors.js";
import {
  type ClaimedWorkItem,
  claimNext,
  complete,
  countLiveItems,
  failAttempt,
  failTerminal,
  type WorkKind,
  type WorkSourceRef,
} from "./work-queue/index.js";

// The type of the thread DB opener function, injected by SDK wiring to avoid
// importing from the threads domain (AC-0.6: shared-tech may not import domains).
export type ThreadDbOpener = (path: string) => OpResult<DatabaseSync>;

export type SchedulerMode = "background" | "manual";

// Report shape per tech design §Interfaces. `superseded` never appears here:
// the cascade deletes superseded items and reports them on the mutation
// result; a drain never sees them.
export interface DrainReport {
  ran: Array<{
    workItemId: string;
    kind: WorkKind;
    sourceRef: WorkSourceRef;
    disposition: "done" | "failed_terminal" | "stale_discarded";
    attempts: number;
    reason?: string;
  }>;
  stoppedBecause: "empty" | "in_flight" | "waiting" | "max_items";
  waitingUntil?: string; // head's eligible_at when stoppedBecause = "waiting"
  remaining: number; // live items left behind the stop point
}

export interface DrainDeps {
  lookupHandler: (kind: string) => OpResult<WorkHandler>;
  // Whether any handler is registered at all. Background scheduling is gated
  // on this, fail-closed: with an empty map a background drain could only
  // turn queued rows into failed_terminal — destruction, not processing — so
  // pokes and catch-up stay inert until a handler table is populated
  // (Stories 2–3 in production; explicit registration in tests).
  hasAnyHandler: () => boolean;
  config: ResolvedSdkConfig;
  // The thread DB opener, injected by SDK wiring to avoid importing from the
  // threads domain (AC-0.6: shared-tech may not import domains).
  openThreadDatabase: ThreadDbOpener;
}

function ranEntry(
  item: ClaimedWorkItem,
  disposition: "done" | "failed_terminal" | "stale_discarded",
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

// The drain loop against an open handle. Claim → dispatch → complete, one
// item at a time, until the head stops it (empty / in_flight / waiting) or
// maxItems is reached. The handler runs with NO open transaction; the only
// exits from a handler failure are failAttempt and the terminal paths — the
// drain never catches an error and records success.
export async function drainOpenDb(
  db: DatabaseSync,
  deps: DrainDeps,
  opts?: { maxItems?: number },
): Promise<DrainReport> {
  const { clock, lease, retry, inferenceCallbacks } = deps.config;
  const ran: DrainReport["ran"] = [];
  let stoppedBecause: DrainReport["stoppedBecause"];
  let waitingUntil: string | undefined;

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
      break;
    }
    if (claim.outcome === "waiting") {
      stoppedBecause = "waiting";
      waitingUntil = claim.waitingUntil;
      break;
    }
    const item = claim.item;

    const lookedUp = deps.lookupHandler(item.kind);
    if (!lookedUp.ok) {
      // Unregistered kind: the normal terminal transaction, not a try/catch
      // skip — failed_terminal with the stable code, form (if resolvable
      // from the payload) lands failed, and the drain continues (AC-1.8).
      failTerminal(db, item, {
        reason: lookedUp.error.code,
        formState: "failed",
        attempts: item.attempts,
        now: clock().toISOString(),
      });
      ran.push(ranEntry(item, "failed_terminal", item.attempts, lookedUp.error.code));
      continue;
    }

    let outcome: HandlerOutcome;
    try {
      outcome = await lookedUp.value(
        { openDb: () => db, inferenceCallbacks, clock, config: deps.config },
        {
          workItemId: item.workItemId,
          kind: item.kind,
          sourceRef: item.sourceRef as unknown as Record<string, string>,
        },
      );
    } catch (cause) {
      // A throwing handler is a bug by the error contract, but the queue
      // must not wedge on it: route it through the normal retry path so it
      // counts attempts and exhausts visibly.
      const detail = cause instanceof Error ? cause.message : String(cause);
      outcome = { ok: false, retryable: true, reason: `handler threw: ${detail}` };
    }

    if (outcome.ok) {
      const disposition = complete(db, item, outcome.derivations ?? [], clock().toISOString(), outcome.onApplied);
      ran.push(ranEntry(item, disposition, item.attempts));
      continue;
    }
    if ("blocked" in outcome) {
      failTerminal(db, item, {
        reason: outcome.reason,
        formState: "blocked",
        attempts: item.attempts + 1,
        now: clock().toISOString(),
      });
      ran.push(ranEntry(item, "failed_terminal", item.attempts + 1, outcome.reason));
      continue;
    }
    const failed = failAttempt(db, item, {
      reason: outcome.reason,
      retryable: outcome.retryable,
      now: clock().toISOString(),
      retry,
    });
    if (failed.terminal) {
      ran.push(ranEntry(item, "failed_terminal", failed.attempts, outcome.reason));
    }
    // Under budget the item went back to queued (possibly backing off); the
    // next claimNext re-reads the head — a backing-off head ends the drain
    // with "waiting" and gates everything behind it.
  }

  const report: DrainReport = { ran, stoppedBecause, remaining: countLiveItems(db) };
  if (waitingUntil !== undefined) report.waitingUntil = waitingUntil;
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
    return { ok: true, value: await drainOpenDb(db, deps, opts) };
  } catch (cause) {
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
  // Fix 1 (DD-4 completion): at most one pending backoff wake per thread; a
  // poke or a newer wake clears it. unref'd so it never keeps the process
  // alive. Background only — manual never reaches the drain loop.
  wakeTimer: ReturnType<typeof scheduleTimer> | undefined;
}

// A wake floored to a sane minimum: an eligible_at already in the past must
// nudge once, not busy-spin (the durable claimNext gate is the real guard).
const WAKE_MIN_DELAY_MS = 5;

export interface Scheduler {
  readonly mode: SchedulerMode;
  // Post-commit nudge that work was queued for a thread (DD-5). Manual mode:
  // no-op by contract. Background mode: starts a drain, or coalesces into
  // the pending flag if one is already running for the thread (AC-1.2).
  poke(threadId: string): void;
  // Thread-file open announcement (DD-10): learns threadId → filePath and,
  // on the first touch of a thread this process lifetime, schedules a
  // catch-up drain if the queue has leftover live work (AC-1.6).
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

  // Arm the lone backoff wake (Fix 1): when a background pass stops on the
  // eligibility gate, schedule a single nudge at the head's eligible_at that
  // re-enters the existing poke path. The delay reads the SDK clock seam (no
  // fresh Date here — E02-NB-001) and is floored to a sane minimum; correctness
  // rides claimNext's durable gate, so a coarse timer never retries early.
  function armWake(st: ThreadDrainState, waitingUntil: string): void {
    clearWake(st);
    const nowMs = deps.config.clock().getTime();
    const delay = Math.max(WAKE_MIN_DELAY_MS, Date.parse(waitingUntil) - nowMs);
    const timer = scheduleTimer(() => {
      st.wakeTimer = undefined;
      schedule(st.threadId);
    }, delay);
    timer.unref();
    st.wakeTimer = timer;
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
        // or touch retries. A pass stopping on "waiting" leaves a backing-off
        // head — handled below by arming a single eligibility wake.
        const result = await runDrain(st.filePath, deps);
        lastReport = result.ok ? result.value : undefined;
      } while (st.pending);
    } finally {
      st.running = false;
      // Fix 1 (DD-4 completion): honor eligibility in background mode. A pass
      // that stopped on "waiting" left a backing-off head that no later poke is
      // guaranteed to revisit; arm one wake at its eligible_at through the poke
      // path and stay unsettled until it fires, so drainSettled awaits the
      // retry. Any other stop reason (empty / max_items / in_flight, or a
      // failed pass) settles the thread now.
      if (
        st.wakeTimer === undefined &&
        lastReport?.stoppedBecause === "waiting" &&
        lastReport.waitingUntil !== undefined
      ) {
        armWake(st, lastReport.waitingUntil);
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
      st.pending = true; // burst coalesce: at most one further pass (AC-1.2)
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
      // Catch-up (DD-10): leftover live work from a previous process runs on
      // first touch. One indexed query on the already-open handle keeps the
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
