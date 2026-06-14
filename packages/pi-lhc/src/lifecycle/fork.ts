import type { OpResult, ThreadRef } from "lhc";
import type { ExtensionContext } from "../pi/types.js";
import { NotImplementedError, notImplemented } from "../shared/not-implemented.js";

// AC-3.1, AC-3.2, AC-3.3. A fork produces a NEW thread seeded by replay and
// never writes the source (tech design Flow 3). Story 4.

export interface ForkInfo {
  sourceFile: string;
  forkEntryId: string;
}

/** Detect a fork and its point from the `session_before_fork` hook (PI session
 *  tree as the Epic-1 fallback). Throws until Story 4 — a stub that returned
 *  `null` ("no fork") could silently mask a real fork, so detection fails loud,
 *  not closed-as-absent. */
export function detectFork(ctx: ExtensionContext): ForkInfo | null {
  throw new NotImplementedError("lifecycle.detectFork");
}

/** Seed a forked thread by replaying the source's recorded events up to the
 *  fork point, through the normal intake path; the source receives NO writes
 *  (AC-3.1), forms requeue rather than copy (AC-3.3). Fail-closed until Story 4. */
export function seedFork(
  source: ThreadRef,
  target: ThreadRef,
  forkPoint: string,
): Promise<OpResult<void>> {
  return Promise.resolve(notImplemented<void>("lifecycle.seedFork"));
}
