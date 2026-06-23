import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import type { ResolvedSdkConfig } from "./derivation.js";
import type { ResolvedViewConfig } from "./view.js";

// Per-SDK-instance delivery seam. Each SDK runs every one of its operations
// inside runWithInstanceSeam, so code reached deep inside — enqueue's poke and
// openThreadDatabase's touch — delivers to that SDK's scheduler in background
// mode or to a no-op in manual mode, isolated from any other SDK in the process.
// Carried through async-context, not a mutable module slot two SDKs would share.
export interface InstanceSeam {
  poke: (threadId: string) => void;
  touch: (filePath: string, db: DatabaseSync) => void;
  // The instance's resolved view config rides the same seam the poke does, so
  // a thread-view operation invoked through sdk.* reads this SDK's
  // profiles/budgets/threshold. Below-SDK direct domain calls find no seam and
  // fall back to built-in defaults at the consuming site, never here.
  view?: ResolvedViewConfig;
  config?: ResolvedSdkConfig;
}
const seamStore = new AsyncLocalStorage<InstanceSeam>();

export function runWithInstanceSeam<T>(seam: InstanceSeam, operation: () => T): T {
  return seamStore.run(seam, operation);
}

// The below-SDK default seam (the former module-global poke/touch slots),
// kept ONLY as the fallback for direct domain calls made with no SDK seam in
// scope: the enqueue-atomicity tests that drive enqueue through
// createDbWriteTransaction directly, and the single-background async-thread-view
// path where a top-level mutation still reaches the one installed scheduler. A
// background SDK installs itself here at construction; a manual SDK leaves it
// alone AND scopes its own operations to a no-op seam, so the fallback can
// never auto-drain a manual SDK's queued work.
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

// The view config for the operation now running: the SDK seam's resolved
// config when one is in scope, undefined for direct domain calls (the
// thread-view surface defaults those itself — see InstanceSeam.view).
export function resolveInstanceViewConfig(): ResolvedViewConfig | undefined {
  return seamStore.getStore()?.view;
}

export function resolveInstanceConfig(): ResolvedSdkConfig | undefined {
  return seamStore.getStore()?.config;
}

// Reads-only operation scope: runs fn under the current seam with the
// thread-touch announcement suppressed, so a pure read can never schedule a
// background scheduler's first-touch catch-up drain through openThreadDatabase
// calls. Everything else on the seam carries through unchanged; direct domain
// calls with no seam in scope delegate to below-SDK defaults, minus the touch.
// Write paths never use this.
export function runWithThreadTouchSuppressed<T>(operation: () => T): T {
  const seam = seamStore.getStore();
  const base: InstanceSeam = seam ?? {
    poke: (threadId) => {
      schedulerPoke?.(threadId);
    },
    touch: (filePath, db) => {
      threadTouch?.(filePath, db);
    },
  };
  return seamStore.run({ ...base, touch: () => {} }, operation);
}

// Thread-file open announcement: openThreadDatabase fires this on every open,
// before any caller transaction begins. Delivers to the SDK seam in scope if
// any, else the below-SDK default. The background scheduler learns
// threadId→filePath and runs first-touch catch-up off this seam.
export function fireThreadTouch(filePath: string, db: DatabaseSync): void {
  const seam = seamStore.getStore();
  if (seam !== undefined) {
    seam.touch(filePath, db);
    return;
  }
  threadTouch?.(filePath, db);
}
