/**
 * Host-local registration of a rebuilt Claude session: bind it to the same LHC
 * thread and persist the content-verifiable prefix fence. Every rebuilt session
 * — an interactive swap's replacement, a one-shot pre-launch rebuild — is
 * registered here before it is resumed.
 */

import type { ThreadRef } from "lhc";

import {
  defaultLineageDbPath,
  type LineageDbDeps,
  type LineageOutcome,
  safeRecordSessionThread,
} from "../intake/lineage-db.js";
import type { PrefixBoundaryVerified } from "../intake/prefix-boundary.js";

export function threadIdFromRef(threadRef: ThreadRef | undefined): string {
  if (threadRef === undefined) return "";
  return "threadId" in threadRef ? threadRef.threadId : "";
}

/**
 * Bind rebuilt Claude session id to the same durable LHC thread and persist
 * the content-verifiable rebuilt-prefix boundary so a later external
 * `cc-lhc --resume` can prove on-disk bytes before skipping served projection.
 * Fail closed: caller must not claim the artifact is ready on failure.
 */
export async function registerRebuiltSessionLineage(input: {
  newSessionId: string;
  threadId: string;
  /** Content-verifiable prefix fence (excludes trailing runtime receipt). */
  prefixBoundary: PrefixBoundaryVerified;
  /** @deprecated Prefer prefixBoundary; retained for transitional call sites. */
  replayedPrefixLines?: number;
  lineageDbPath?: string;
  lineageDeps?: LineageDbDeps;
  logError?: (message: string) => void;
}): Promise<LineageOutcome> {
  if (input.threadId === "") {
    return { ok: false, reason: "lineage_write:missing_thread_id" };
  }
  const dbPath = input.lineageDbPath ?? defaultLineageDbPath();
  const logError = input.logError ?? (() => {});
  return safeRecordSessionThread(
    dbPath,
    input.newSessionId,
    input.threadId,
    logError,
    input.lineageDeps ?? {},
    { prefix: input.prefixBoundary },
  );
}
