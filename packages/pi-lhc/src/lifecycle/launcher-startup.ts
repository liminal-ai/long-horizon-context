import type { ThreadRef } from "lhc";
import type { LaunchFlags } from "./thread-resolution.js";

/** Thread identity and launch flags resolved by the pi-lhc launcher before PI session creation. */
export interface LauncherOwnedStartup {
  threadRef: ThreadRef;
  launchFlags: LaunchFlags;
}

let pendingStartup: LauncherOwnedStartup | null = null;

export function setLauncherOwnedStartup(startup: LauncherOwnedStartup): void {
  pendingStartup = startup;
}

/** Consume one-shot launcher handoff on the first connector `session_start`. */
export function takeLauncherOwnedStartup(): LauncherOwnedStartup | null {
  const startup = pendingStartup;
  pendingStartup = null;
  return startup;
}

/** Test seam: clear any unconsumed launcher handoff. */
export function clearLauncherOwnedStartup(): void {
  pendingStartup = null;
}
