import type { OpResult, ThreadRef } from "lhc";
import type { ExtensionAPI } from "../pi/types.js";
import { notImplemented } from "../shared/not-implemented.js";

// AC-1.2, AC-1.5, AC-1.6. Launch flags name the thread; the registry resolves
// it (tech design Flow 1). PI's own session file still exists in this
// observe-only epic — it is just not where thread identity lives.

/** None set → new thread. */
export interface LaunchFlags {
  resume?: boolean; // --resume / -r : cwd-scoped picker
  continue?: boolean; // --continue / -c : most recent
  session?: string; // --session <id> : full or partial id
}

/** Story 1: new / `--session` (full + partial id) / `--continue` (most recent),
 *  reload reconstructs from the resolved id, an unresolvable `--session` id
 *  fails loud (never a silent new thread). Fail-closed until then. */
export function resolveThread(
  launch: LaunchFlags,
  pi: ExtensionAPI,
): Promise<OpResult<ThreadRef>> {
  return Promise.resolve(notImplemented<ThreadRef>("lifecycle.resolveThread"));
}
