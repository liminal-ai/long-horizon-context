/**
 * Carry helper agents' transcripts into the replacement session (cc-lhc 0.4.5).
 *
 * Claude Code resumes a helper (`SendMessage(<agentId>)`) only from the
 * CURRENT parent session's folder:
 * `<projectDir>/<sessionId>/subagents/agent-<id>.jsonl` plus its adjacent
 * `agent-<id>.meta.json` (agent type, worktree, fork flags). After Smart
 * Compact the replacement is a new session with an empty folder, so a helper
 * interrupted by the compaction could not be resumed ("No transcript found
 * for agent ID"), although the notice said it could. Copying those two files,
 * unchanged, into the replacement's folder is enough for Claude to resume it
 * with its earlier context (Alder, REPORT-AGENT-RESUME.md, 2026-09-24).
 *
 * Rules:
 *  - Copy, never link: Claude appends to the resumed transcript and rewrites
 *    its metadata; the original stays untouched for rollback.
 *  - Only once the old host can no longer write: callers run this from the
 *    next-prompt hook, after the handoff generation closed (old Claude
 *    terminated or paused).
 *  - Staged: each file is copied under a temporary name in the destination
 *    folder and renamed into place, metadata first, transcript last. The
 *    transcript's presence is the publication: a partial copy never looks
 *    resumable.
 *  - Never overwrite: a destination transcript already there (a helper
 *    resumed in this session, or an earlier copy) is kept as is.
 */
import { copyFileSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { ContinuityStore } from "./store.js";

const AGENT_FILE = /^agent-([A-Za-z0-9_-]+)\.jsonl$/;
const PARTIAL_MARK = ".cc-lhc-partial-";

export type HelperTransfer =
  | { ok: true; agentId: string; status: "copied" | "present" }
  | { ok: false; agentId: string; reason: string };

export function sessionDirOfTranscript(transcriptPath: string): string {
  return join(dirname(transcriptPath), basename(transcriptPath, ".jsonl"));
}

export function subagentsDirOf(sessionDir: string): string {
  return join(sessionDir, "subagents");
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function copyStaged(from: string, to: string): void {
  const temp = join(dirname(to), `.${basename(to)}${PARTIAL_MARK}${process.pid}-${Date.now()}`);
  try {
    copyFileSync(from, temp);
    renameSync(temp, to);
  } catch (cause) {
    try {
      unlinkSync(temp);
    } catch {}
    throw cause;
  }
}

export function transferHelper(input: { agentId: string; fromDir: string; toDir: string }): HelperTransfer {
  const { agentId, fromDir, toDir } = input;
  const transcript = `agent-${agentId}.jsonl`;
  const meta = `agent-${agentId}.meta.json`;
  const dest = join(toDir, transcript);
  if (exists(dest)) return { ok: true, agentId, status: "present" };
  const source = join(fromDir, transcript);
  if (!exists(source)) return { ok: false, agentId, reason: "its transcript is missing" };
  try {
    mkdirSync(toDir, { recursive: true });
    if (exists(join(fromDir, meta))) copyStaged(join(fromDir, meta), join(toDir, meta));
    copyStaged(source, dest);
    return { ok: true, agentId, status: "copied" };
  } catch (cause) {
    const code = (cause as { code?: string }).code;
    return {
      ok: false,
      agentId,
      reason: `its transcript could not be copied (${code ?? (cause instanceof Error ? cause.message : String(cause))})`,
    };
  }
}

export function sweepPartialCopies(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(".agent-") || !name.includes(PARTIAL_MARK)) continue;
    try {
      unlinkSync(join(dir, name));
    } catch {}
  }
}

export function carryHelpersForward(input: { fromSessionDir: string; toSessionDir: string }): HelperTransfer[] {
  const fromDir = subagentsDirOf(input.fromSessionDir);
  const toDir = subagentsDirOf(input.toSessionDir);
  let names: string[];
  try {
    names = readdirSync(fromDir);
  } catch {
    return [];
  }
  sweepPartialCopies(toDir);
  const results: HelperTransfer[] = [];
  for (const name of names.sort()) {
    const match = AGENT_FILE.exec(name);
    if (match === null) continue;
    results.push(transferHelper({ agentId: match[1]!, fromDir, toDir }));
  }
  return results;
}

export function carryHelpersFromPreviousSession(
  store: ContinuityStore,
  threadId: string,
  sessionDir: string,
): { from: string; results: HelperTransfer[] } | { skipped: string } {
  const generation = store.latestGeneration(threadId);
  if (generation === null) return { skipped: "no handoff yet" };
  if (generation.state !== "closed") return { skipped: "handoff not complete" };
  const old = generation.oldSessionId;
  if (old === "" || old === "unknown" || old === basename(sessionDir)) return { skipped: "no previous session" };
  if (generation.retainedHost !== null && generation.retainedHost.frozen !== true) {
    return { skipped: "previous session still running" };
  }
  const from = join(dirname(sessionDir), old);
  return { from, results: carryHelpersForward({ fromSessionDir: from, toSessionDir: sessionDir }) };
}
