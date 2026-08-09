/**
 * Interim Slice 1 compact/prune completion: rebuild artifact + lineage, no
 * in-app /resume injection (Claude Code 2.1.226 cannot resume a session file
 * created after TUI startup). Operator relaunches via external wrapper resume.
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

/** Operator-facing guidance after a successful rebuild (live Claude unchanged). */
export function formatRebuildRelaunchGuidance(input: {
  operation: "compact" | "prune";
  oldSessionId: string;
  newSessionId: string;
  threadId: string;
}): string[] {
  return [
    `LHC ${input.operation}: rebuilt session ${input.newSessionId} written; live Claude session ${input.oldSessionId} is unchanged.`,
    `Exit Claude, then relaunch with: cc-lhc --resume ${input.newSessionId}`,
    `Or bare picker: cc-lhc --resume  (lists the rebuilt session among project rollouts)`,
    `Durable LHC thread remains ${input.threadId || "(unknown)"} — do not start a fresh session for this work.`,
  ];
}

export const LINEAGE_REGISTRATION_FAILED =
  "lineage registration failed — rebuilt file may exist on disk but is NOT ready; " +
  "do not resume it until the session→thread binding is persisted";

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

/** Truthful partial state when post-lineage fence fails. */
export const REBUILD_PARTIAL_AFTER_LINEAGE =
  "rebuilt artifact and lineage may exist; live Claude session unchanged; " +
  "do not claim operator-ready relaunch — reconciliation required";
