/**
 * Launch-time move-aside of abandoned rebuilt transcripts.
 *
 * Smart Compact writes a rebuilt Claude session file into
 * ~/.claude/projects/<cwd-key>/ and registers it in host lineage with a
 * verified rebuilt-prefix fence. A swap killed before acceptance leaves that
 * file behind: never current, never an alias, owned by nobody. Claude's own
 * picker still lists it. This sweep moves such files (never deletes) into
 * $CC_LHC_HOME/abandoned-rebuilds/<cwd-key>/ and drops their sessions-index
 * entry.
 *
 * Conservative: every question the sweep cannot answer keeps the file. The
 * verdict is one small function (`abandonedRebuildVerdict`) over injectable
 * facts.
 *
 * A rebuilt session reserved as NOT YET ACCEPTED (recorded before its file is
 * written) is among the rebuilt sessions swept. It is neither the thread's
 * current session nor its pending acceptance (`cc_pending_current_session`
 * holds only swaps already accepted), so it is moved aside exactly when its
 * handoff is dead — no live or indeterminate thread owner, no live descriptor —
 * and it is older than the viability window. While its handoff's owner is live
 * it is kept. A reservation whose file was never written has nothing to move.
 */

import { copyFileSync, existsSync, lstatSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_CAPTURE_READY_TIMEOUT_MS,
  DEFAULT_CHILD_LIVENESS_TIMEOUT_MS,
  DEFAULT_CHILD_STABLE_WINDOW_MS,
  DEFAULT_REPLACEMENT_ATTEMPTS,
} from "../wrapper/handoff.js";
import { encodeProjectPath } from "./discover.js";
import { removeSessionsIndexEntry } from "./sessions-index.js";

/**
 * A rebuilt file younger than this may belong to an in-flight handoff: every
 * spawn/viability attempt of one swap plus the capture-ready wait.
 */
export const ABANDONED_REBUILD_MIN_AGE_MS =
  DEFAULT_REPLACEMENT_ATTEMPTS * (DEFAULT_CHILD_LIVENESS_TIMEOUT_MS + DEFAULT_CHILD_STABLE_WINDOW_MS) +
  DEFAULT_CAPTURE_READY_TIMEOUT_MS;

export interface RebuiltTranscript {
  sessionId: string;
  threadId: string;
  path: string;
  mtimeMs: number;
}

/** Three-way answers: anything but a definite answer keeps the file. */
export type AliasKnowledge = "known" | "unknown" | "indeterminate";
export type OwnerLiveness = "none" | "live" | "dead" | "indeterminate";

export interface AbandonedRebuildFacts {
  nowMs: number;
  minAgeMs?: number;
  /** Is this session an alias of any thread in the registry? */
  aliasKnowledge(sessionId: string): Promise<AliasKnowledge>;
  /**
   * The thread's current Claude session per registry. null = the thread has
   * no current Claude alias (unimported legacy thread, other host) — which
   * leaves acceptance unprovable, so the file is kept.
   */
  currentSessionOf(threadId: string): Promise<{ ok: true; sessionId: string | null } | { ok: false }>;
  /** Acceptance recorded host-side but not yet in the registry. */
  pendingCurrentSessionOf(threadId: string): { ok: true; sessionId: string | null } | { ok: false };
  ownerOf(threadId: string): OwnerLiveness;
  /** Sessions named by a live or indeterminate runtime descriptor. */
  descriptorSessionIds: ReadonlySet<string>;
}

export type AbandonedRebuildVerdict = { abandoned: true } | { abandoned: false; reason: string };

export async function abandonedRebuildVerdict(
  file: RebuiltTranscript,
  facts: AbandonedRebuildFacts,
): Promise<AbandonedRebuildVerdict> {
  const keep = (reason: string): AbandonedRebuildVerdict => ({ abandoned: false, reason });
  const minAge = facts.minAgeMs ?? ABANDONED_REBUILD_MIN_AGE_MS;
  if (facts.nowMs - file.mtimeMs < minAge) return keep("young");

  const owner = facts.ownerOf(file.threadId);
  if (owner === "live") return keep("thread owner live");
  if (owner === "indeterminate") return keep("thread owner indeterminate");
  if (facts.descriptorSessionIds.has(file.sessionId)) return keep("named by a live runtime descriptor");

  const alias = await facts.aliasKnowledge(file.sessionId);
  if (alias === "known") return keep("registry alias");
  if (alias === "indeterminate") return keep("registry alias lookup failed");

  const current = await facts.currentSessionOf(file.threadId);
  if (!current.ok) return keep("registry current lookup failed");
  if (current.sessionId === null) return keep("thread has no current Claude session in the registry");
  if (current.sessionId === file.sessionId) return keep("current session");

  const pending = facts.pendingCurrentSessionOf(file.threadId);
  if (!pending.ok) return keep("pending acceptance lookup failed");
  if (pending.sessionId === file.sessionId) return keep("pending acceptance");

  return { abandoned: true };
}

export interface AbandonedRebuildSweepInput {
  home: string;
  projectsRoot: string;
  cwd: string;
  /** Rebuilt sessions from host lineage (verified prefix fence). */
  rebuiltSessions: ReadonlyArray<{ sessionId: string; threadId: string }>;
  facts: AbandonedRebuildFacts;
}

export interface AbandonedRebuildSweep {
  moved: Array<{ sessionId: string; from: string; to: string; indexEntriesRemoved: number | "failed" }>;
  kept: Array<{ sessionId: string; reason: string }>;
  failed: Array<{ sessionId: string; reason: string }>;
}

export function abandonedRebuildsDir(home: string, cwd: string): string {
  return join(home, "abandoned-rebuilds", encodeProjectPath(cwd));
}

function moveFile(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EXDEV") throw cause;
    copyFileSync(from, to);
    unlinkSync(from);
  }
}

export async function sweepAbandonedRebuilds(input: AbandonedRebuildSweepInput): Promise<AbandonedRebuildSweep> {
  const result: AbandonedRebuildSweep = { moved: [], kept: [], failed: [] };
  const projectDir = join(input.projectsRoot, encodeProjectPath(input.cwd));
  for (const row of input.rebuiltSessions) {
    const path = join(projectDir, `${row.sessionId}.jsonl`);
    let mtimeMs: number;
    try {
      const st = lstatSync(path);
      if (!st.isFile()) continue;
      mtimeMs = st.mtimeMs;
    } catch {
      continue; // not in this project dir
    }
    let verdict: AbandonedRebuildVerdict;
    try {
      verdict = await abandonedRebuildVerdict(
        { sessionId: row.sessionId, threadId: row.threadId, path, mtimeMs },
        input.facts,
      );
    } catch (cause) {
      verdict = { abandoned: false, reason: `check failed: ${cause instanceof Error ? cause.message : String(cause)}` };
    }
    if (!verdict.abandoned) {
      result.kept.push({ sessionId: row.sessionId, reason: verdict.reason });
      continue;
    }
    const destDir = abandonedRebuildsDir(input.home, input.cwd);
    let to = join(destDir, `${row.sessionId}.jsonl`);
    try {
      mkdirSync(destDir, { recursive: true, mode: 0o700 });
      if (existsSync(to)) to = join(destDir, `${row.sessionId}.${String(input.facts.nowMs)}.jsonl`);
      moveFile(path, to);
    } catch (cause) {
      result.failed.push({
        sessionId: row.sessionId,
        reason: `move failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
      continue;
    }
    let indexEntriesRemoved: number | "failed";
    try {
      indexEntriesRemoved = await removeSessionsIndexEntry(projectDir, row.sessionId);
    } catch {
      indexEntriesRemoved = "failed";
    }
    result.moved.push({ sessionId: row.sessionId, from: path, to, indexEntriesRemoved });
  }
  return result;
}
