import { AsyncLocalStorage } from "node:async_hooks";
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
  // The scheduler poke for the SDK instance whose operation is running (DD-5,
  // epic-fix-001): enqueue registers its onCommit poke against THIS, carried
  // on the context, never a shared module slot. Resolved from the per-SDK
  // seam in scope (background → its own scheduler; manual → a no-op), falling
  // back to the below-SDK default seam only for direct domain calls with no
  // SDK around. A manual SDK therefore never auto-drains even with a
  // background SDK alive in the same process.
  poke: (threadId: string) => void;
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

// Per-SDK-instance delivery seam (DD-5/DD-10, epic-fix-001). Each SDK runs
// every one of its operations inside runWithInstanceSeam, so the code reached
// deep inside — enqueue's poke and openThreadDatabase's touch — delivers to
// THAT SDK's scheduler (background) or to a no-op (manual), isolated from any
// other SDK in the process. Carried through async-context, not a mutable
// module slot two SDKs would share: that sharing was the bug — a manual SDK
// auto-drained because a background SDK had overwritten the global slot.
export interface InstanceSeam {
  poke: (threadId: string) => void;
  touch: (filePath: string, db: DatabaseSync) => void;
}
const seamStore = new AsyncLocalStorage<InstanceSeam>();

export function runWithInstanceSeam<T>(seam: InstanceSeam, fn: () => T): T {
  return seamStore.run(seam, fn);
}

// The below-SDK default seam (the former module-global poke/touch slots),
// kept ONLY as the fallback for direct domain calls made with no SDK seam in
// scope: the enqueue-atomicity tests that drive enqueue/runInTransaction
// directly, and the single-background "production path" where a top-level
// mutation still reaches the one installed scheduler. A background SDK
// installs itself here at construction; a manual SDK leaves it alone AND
// scopes its own operations to a no-op seam, so the fallback can never
// auto-drain a manual SDK's queued work.
type SchedulerPoke = (threadId: string) => void;
let schedulerPoke: SchedulerPoke | null = null;

export function setSchedulerPoke(poke: SchedulerPoke | null): void {
  schedulerPoke = poke;
}

type ThreadTouch = (filePath: string, db: DatabaseSync) => void;
let threadTouch: ThreadTouch | null = null;

export function setThreadTouch(touch: ThreadTouch | null): void {
  threadTouch = touch;
}

// The poke target for a context built now: the running SDK's seam if one is
// in scope, else the below-SDK default (null-safe). Captured onto ctx.poke so
// the enqueue carries its target rather than reading a shared slot at fire
// time — except, deliberately, through the default fallback for direct calls.
export function resolveInstancePoke(): (threadId: string) => void {
  const seam = seamStore.getStore();
  if (seam !== undefined) return seam.poke;
  return (threadId) => {
    schedulerPoke?.(threadId);
  };
}

// Thread-file open announcement (DD-10): openThreadDatabase fires this on
// every open, before any caller transaction begins. Delivers to the SDK seam
// in scope if any (background → first-touch catch-up; manual → no-op), else
// the below-SDK default. The background scheduler learns threadId→filePath
// and runs the first-touch catch-up off this seam.
export function fireThreadTouch(filePath: string, db: DatabaseSync): void {
  const seam = seamStore.getStore();
  if (seam !== undefined) {
    seam.touch(filePath, db);
    return;
  }
  threadTouch?.(filePath, db);
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
  const poke = resolveInstancePoke();
  db.exec("BEGIN IMMEDIATE;");
  let value: T;
  try {
    value = fn({ db, clock, threadId, onCommit: hooks.register, poke });
    db.exec("COMMIT;");
  } catch (cause) {
    db.exec("ROLLBACK;");
    throw cause;
  }
  hooks.flush();
  return value;
}
