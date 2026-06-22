import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import type { ResolvedSdkConfig } from "./derivation.js";
import type { ResolvedViewConfig } from "./view.js";

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
  // Epic 03 (tech design Flow 4): the instance's resolved view config rides
  // the same seam the poke does, so a thread-view operation invoked through
  // sdk.* reads THIS SDK's profiles/budgets/threshold. Below-SDK direct
  // domain calls find no seam and fall back to the built-in defaults at the
  // consuming site (thread-view), never here — shared-tech/ may not import
  // the domains, and the defaults' one resolution path lives there.
  view?: ResolvedViewConfig;
  toolResult?: ResolvedSdkConfig["toolResult"];
  config?: ResolvedSdkConfig;
}
const seamStore = new AsyncLocalStorage<InstanceSeam>();

export function runWithInstanceSeam<T>(seam: InstanceSeam, operation: () => T): T {
  return seamStore.run(seam, operation);
}

// The below-SDK default seam (the former module-global poke/touch slots),
// kept ONLY as the fallback for direct domain calls made with no SDK seam in
// scope: the enqueue-atomicity tests that drive enqueue through
// createDbWriteTransaction directly, and the single-background "production path" where a top-level
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

// The view config for the operation now running: the SDK seam's resolved
// config when one is in scope, undefined for direct domain calls (the
// thread-view surface defaults those itself — see InstanceSeam.view).
export function resolveInstanceViewConfig(): ResolvedViewConfig | undefined {
  return seamStore.getStore()?.view;
}

export function resolveInstanceToolResultConfig(): ResolvedSdkConfig["toolResult"] | undefined {
  return seamStore.getStore()?.toolResult;
}

export function resolveInstanceConfig(): ResolvedSdkConfig | undefined {
  return seamStore.getStore()?.config;
}

// Reads-only operation scope (Epic 03 AC-1.1/AC-2.8): runs fn under the
// current seam with the thread-touch announcement suppressed, so a pure read
// — thread-view model context/status above all — can never schedule a background
// scheduler's first-touch catch-up drain through its openThreadDatabase
// calls (or those of the report surfaces it consumes). Everything else on
// the seam (poke target, view config) carries through unchanged; for a
// direct domain call with no seam in scope the installed scope delegates to
// the below-SDK defaults, minus the touch. Write paths never use this.
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
