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

export async function registerRebuiltSessionLineage(input: {
  newSessionId: string;
  threadId: string;
  prefixBoundary: PrefixBoundaryVerified;
  replayedPrefixLines?: number;
  lineageDbPath?: string;
  lineageDeps?: LineageDbDeps;
  logError?: (message: string) => void;
  accepted?: boolean;
}): Promise<LineageOutcome> {
  if (input.threadId === "") {
    return { ok: false, reason: "lineage_write:missing_thread_id" };
  }
  const dbPath = input.lineageDbPath ?? defaultLineageDbPath();
  const logError = input.logError ?? (() => {});
  return safeRecordSessionThread(dbPath, input.newSessionId, input.threadId, logError, input.lineageDeps ?? {}, {
    prefix: input.prefixBoundary,
    accepted: input.accepted ?? true,
  });
}

export async function reserveRebuiltSessionLineage(input: {
  newSessionId: string;
  threadId: string;
  prefixBoundary: PrefixBoundaryVerified;
  lineageDbPath?: string;
  lineageDeps?: LineageDbDeps;
  logError?: (message: string) => void;
}): Promise<LineageOutcome> {
  return registerRebuiltSessionLineage({ ...input, accepted: false });
}
