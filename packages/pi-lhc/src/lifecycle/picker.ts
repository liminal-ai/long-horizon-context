import type { OpResult, ThreadRef } from "lhc";
import { notImplemented } from "../shared/not-implemented.js";

// AC-1.7.

/** `--resume` picker: cwd-scoped `listThreads` (title + created) and selection;
 *  `null` on an empty list (no failure). Fail-closed until Story 1 — and it
 *  must not pass by degrading to an unscoped or untitled list. */
export function pickThread(cwd: string): Promise<OpResult<ThreadRef | null>> {
  return Promise.resolve(notImplemented<ThreadRef | null>("lifecycle.pickThread"));
}
