import type { DatabaseSync } from "node:sqlite";

export interface OperationContext {
  db: DatabaseSync; // open thread-file handle, inside the batch transaction
  clock: () => Date; // injected for deterministic recordedAt/queuedAt in tests
  threadId: string; // resolved identity of the thread being operated on
  // Post-commit callback registration (DD-5): the transaction owner flushes
  // the registered callbacks after its COMMIT succeeds and drops them on
  // rollback, so anything registered here — the scheduler poke above all —
  // is transactional by construction.
  onCommit: (fn: () => void) => void;
}

// The callback list behind ctx.onCommit, owned by whoever owns the
// transaction. Flush after COMMIT; never call flush on a rollback path —
// dropping the hooks is simply not flushing them.
export interface CommitHooks {
  register: (fn: () => void) => void;
  flush: () => void;
}

export function createCommitHooks(): CommitHooks {
  const callbacks: Array<() => void> = [];
  return {
    register: (fn) => {
      callbacks.push(fn);
    },
    flush: () => {
      for (const fn of callbacks.splice(0)) fn();
    },
  };
}

// The scheduler poke seam (DD-5). The slot lives in shared/ so the queue
// util can fire it without importing the scheduler module (which will import
// domain handler tables from Story 1 on — a util→scheduler import would
// cycle). The scheduler installs itself here; in manual mode, or before any
// scheduler exists, firing is a no-op — onCommit still fires either way.
type SchedulerPoke = (threadId: string) => void;
let schedulerPoke: SchedulerPoke | null = null;

export function setSchedulerPoke(poke: SchedulerPoke | null): void {
  schedulerPoke = poke;
}

export function fireSchedulerPoke(threadId: string): void {
  schedulerPoke?.(threadId);
}

// Transaction owner for operations outside the intake pipeline (mutations,
// repair re-queues, tests of enqueue atomicity): BEGIN IMMEDIATE, run the
// body with a context whose onCommit registrations flush only after COMMIT
// succeeds and drop whole on rollback.
export function runInTransaction<T>(
  db: DatabaseSync,
  clock: () => Date,
  threadId: string,
  fn: (ctx: OperationContext) => T,
): T {
  const hooks = createCommitHooks();
  db.exec("BEGIN IMMEDIATE;");
  let value: T;
  try {
    value = fn({ db, clock, threadId, onCommit: hooks.register });
    db.exec("COMMIT;");
  } catch (cause) {
    db.exec("ROLLBACK;");
    throw cause;
  }
  hooks.flush();
  return value;
}
