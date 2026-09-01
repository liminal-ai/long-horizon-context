/**
 * Family adapters for the normal Smart Compact path (tech-design D5, LIM-145
 * AC-2.2): how each asynchronous-work family is carried across a Claude child
 * replacement, and the identity that must verify before the parent claims it.
 *
 * Grounded in the accepted Story 0 evidence for Claude Code 2.1.252
 * (`test/story0/family-matrix.md`) and the host continuation seams it proved:
 *
 *  - background_shell → `adopt`. The OS process survives the swap and keeps
 *    writing the task's output file; the parent's continuation is reading
 *    that verified file. The Claude-launched record (`{stdout,
 *    backgroundTaskId}` plus the "Output is being written to" sentence)
 *    exposes no pid, so the only identity the parent can verify is the
 *    output file: POSIX dev+inode, proved stable across appends and
 *    discriminating a replaced file. Story 0's Windows adoption verified a
 *    manifest pid + native creation identity that the Story 0 harness's own
 *    launcher wrote; the normal-path record carries no such manifest and no
 *    Windows output identity is proved, so Windows shells stay unqualified
 *    with that exact mismatch named.
 *  - agent → `reconstruct` through `SendMessage(agentId)`, which resumes the
 *    saved transcript `<sessionDir>/subagents/agent-<agentId>.jsonl`.
 *  - workflow → `reconstruct` through `Workflow({resumeFromRunId, scriptPath})`;
 *    the run's `journal.jsonl` under `transcriptDir` is the durable record.
 *  - monitor → `reconstruct` by relaunch (owner decision). The watch dies with
 *    the child and its surviving process has no reader; the one continuation
 *    Claude Code offers is running the Monitor again. The adapter qualifies a
 *    live Monitor only when its exact launch specification resolves from the
 *    old session's rollout by the launching tool-use id; the durable identity
 *    is that reference (rollout path + tool-use id), never the command text,
 *    and the command is resolved again at invocation time. The relaunch is
 *    reported as `restarted`, fenced once per handoff generation. A Monitor
 *    whose launch cannot be resolved is closed with one truthful `failed`
 *    terminal outcome so Smart Compact continues without it.
 *  - scheduled_wakeup → `rearm` from the launch's durable scheduled time and
 *    launching tool-use id, surfaced at the next real turn.
 *
 * A qualified result always names its continuation mechanism, not only an
 * identity artifact. Operations are declared only where current evidence
 * supports them: a bounded read of a verified POSIX output file for an
 * adopted shell. No family declares `stop` (no verified process identity
 * exists on this path) and none declares `status`. A verification that fails
 * leaves the item unqualified. Nothing here retries, waits, replays, stores
 * a command, or reads a clock.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { AsyncWorkFamily } from "../observation/async-work.js";
import {
  type ContinuationMechanism,
  type ContinuityItem,
  type ContinuityOperation,
  type ContinuityStore,
  continuationMechanismOf,
  type QualifiedCarryMode,
  type VerifiedIdentity,
} from "./store.js";

export type { ContinuationMechanism } from "./store.js";

export type PathFact =
  | { kind: "file"; dev: string; ino: string }
  | { kind: "dir" }
  | { kind: "missing" }
  | { kind: "unreadable" };

export interface AdapterContext {
  platform: NodeJS.Platform;
  /** The old session's rollout path; agent transcripts live in the directory named after it. */
  sourceRolloutPath: string | undefined;
  /** Filesystem seam (tests); production stats the real path. */
  statPath?: (path: string) => PathFact;
  /** Rollout read seam (tests); production reads the real file. */
  readRollout?: (path: string) => string | null;
}

export type MonitorLaunchUnresolvable =
  /** The relaunch runs the command through the platform's POSIX shell; not proved on win32. */
  | "relaunch_unsupported_on_platform"
  | "no_rollout_binding"
  | "rollout_unreadable"
  | "launch_not_found"
  | "launch_ambiguous"
  | "launch_incomplete";

/** The exact Monitor launch specification as the old session issued it. Held in memory only. */
export interface MonitorLaunchSpec {
  command: string;
  input: Record<string, unknown>;
}

export type MonitorLaunchResolution =
  | { ok: true; spec: MonitorLaunchSpec }
  | { ok: false; reason: MonitorLaunchUnresolvable };

function readRolloutReal(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Resolve the Monitor launch `tool_use` with this id from the rollout: exactly
 * one assistant `tool_use` named `Monitor` with a non-empty `command`. Called
 * at qualification (to prove the reference resolves) and again at invocation,
 * so the command text never has to be stored anywhere.
 */
export function resolveMonitorLaunch(
  rolloutPath: string | undefined,
  toolUseId: string | null,
  readRollout: (path: string) => string | null = readRolloutReal,
): MonitorLaunchResolution {
  if (rolloutPath === undefined || toolUseId === null) return { ok: false, reason: "no_rollout_binding" };
  const text = readRollout(rolloutPath);
  if (text === null) return { ok: false, reason: "rollout_unreadable" };
  const matches: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "" || !line.includes(toolUseId)) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof record !== "object" || record === null || (record as { type?: unknown }).type !== "assistant") continue;
    const content = (record as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as { type?: unknown; id?: unknown; name?: unknown; input?: unknown };
      if (b.type !== "tool_use" || b.id !== toolUseId) continue;
      if (b.name !== "Monitor" || typeof b.input !== "object" || b.input === null || Array.isArray(b.input)) {
        return { ok: false, reason: "launch_incomplete" };
      }
      matches.push(b.input as Record<string, unknown>);
    }
  }
  if (matches.length === 0) return { ok: false, reason: "launch_not_found" };
  if (matches.length > 1) return { ok: false, reason: "launch_ambiguous" };
  const input = matches[0]!;
  const command = input.command;
  if (typeof command !== "string" || command.trim() === "") return { ok: false, reason: "launch_incomplete" };
  return { ok: true, spec: { command, input } };
}

export type QualificationRefusal =
  | "no_continuation_facts"
  | "no_session_binding"
  /** Windows: the normal-path shell record exposes no manifest pid/creation identity and no Windows output identity is proved. */
  | "windows_shell_identity_not_exposed"
  /** Monitor: its exact launch specification does not resolve from the rollout binding. */
  | "monitor_launch_unresolvable"
  | "output_file_missing"
  | "output_file_unreadable"
  | "transcript_missing"
  | "workflow_run_incomplete"
  | "script_missing"
  | "journal_missing"
  | "scheduled_time_invalid"
  | "identity_changed";

export type Qualification =
  | {
      ok: true;
      carryMode: QualifiedCarryMode;
      operations: readonly ContinuityOperation[];
      verifiedIdentity: VerifiedIdentity;
      continuation: ContinuationMechanism;
    }
  | { ok: false; reason: QualificationRefusal };

export interface FamilyAdapter {
  readonly family: AsyncWorkFamily;
  /** Verify the item's current normal-path identity; never mutates anything. */
  qualify(item: ContinuityItem, context: AdapterContext): Qualification;
}

export function statPathReal(path: string): PathFact {
  try {
    const st = statSync(path, { bigint: true });
    if (st.isDirectory()) return { kind: "dir" };
    if (!st.isFile()) return { kind: "unreadable" };
    return { kind: "file", dev: st.dev.toString(), ino: st.ino.toString() };
  } catch (cause) {
    const code = (cause as { code?: string }).code;
    return code === "ENOENT" || code === "ENOTDIR" ? { kind: "missing" } : { kind: "unreadable" };
  }
}

function statOf(context: AdapterContext, path: string): PathFact {
  return (context.statPath ?? statPathReal)(path);
}

/** POSIX output identity per Story 0: dev+inode, proved on Linux and macOS only. */
type Refusal = Extract<Qualification, { ok: false }>;

type PosixOutputIdentity = Extract<VerifiedIdentity, { kind: "posix_output" }>;

function verifyOutputFile(context: AdapterContext, path: string | undefined): Refusal | PosixOutputIdentity {
  if (path === undefined) return { ok: false, reason: "no_continuation_facts" };
  if (context.platform !== "linux" && context.platform !== "darwin") {
    return { ok: false, reason: "windows_shell_identity_not_exposed" };
  }
  const fact = statOf(context, path);
  if (fact.kind === "missing") return { ok: false, reason: "output_file_missing" };
  if (fact.kind !== "file" || fact.ino === "0") return { ok: false, reason: "output_file_unreadable" };
  return { kind: "posix_output", path, dev: fact.dev, ino: fact.ino };
}

function isRefusal(value: Refusal | PosixOutputIdentity): value is Refusal {
  return "ok" in value;
}

const backgroundShell: FamilyAdapter = {
  family: "background_shell",
  qualify(item, context) {
    const identity = verifyOutputFile(context, item.continuation?.outputFile);
    if (isRefusal(identity)) return identity;
    return {
      ok: true,
      carryMode: "adopt",
      operations: ["output"],
      verifiedIdentity: identity,
      continuation: continuationMechanismOf(identity),
    };
  },
};

const monitor: FamilyAdapter = {
  family: "monitor",
  qualify(item, context) {
    const resolved = resolveMonitorLaunch(context.sourceRolloutPath, item.toolUseId, context.readRollout);
    if (!resolved.ok) return { ok: false, reason: "monitor_launch_unresolvable" };
    // Only the reference is kept; `resolved.spec` is dropped here on purpose.
    const identity: VerifiedIdentity = {
      kind: "monitor_launch",
      toolUseId: item.toolUseId as string,
      rolloutPath: context.sourceRolloutPath as string,
    };
    return {
      ok: true,
      carryMode: "reconstruct",
      operations: [],
      verifiedIdentity: identity,
      continuation: continuationMechanismOf(identity),
    };
  },
};

/** `<projects>/<key>/<sessionId>.jsonl` → `<projects>/<key>/<sessionId>` (where the host keeps subagents). */
export function sessionDirOfRollout(rolloutPath: string): string | undefined {
  return rolloutPath.endsWith(".jsonl") ? rolloutPath.slice(0, -".jsonl".length) : undefined;
}

const agent: FamilyAdapter = {
  family: "agent",
  qualify(item, context) {
    if (item.taskId === null) return { ok: false, reason: "no_continuation_facts" };
    const sessionDir =
      context.sourceRolloutPath === undefined ? undefined : sessionDirOfRollout(context.sourceRolloutPath);
    if (sessionDir === undefined) return { ok: false, reason: "no_session_binding" };
    const path = join(sessionDir, "subagents", `agent-${item.taskId}.jsonl`);
    if (statOf(context, path).kind !== "file") return { ok: false, reason: "transcript_missing" };
    const identity: VerifiedIdentity = { kind: "agent_transcript", agentId: item.taskId, path };
    return {
      ok: true,
      carryMode: "reconstruct",
      operations: [],
      verifiedIdentity: identity,
      continuation: continuationMechanismOf(identity),
    };
  },
};

const workflow: FamilyAdapter = {
  family: "workflow",
  qualify(item, context) {
    const facts = item.continuation;
    if (facts?.runId === undefined || facts.scriptPath === undefined || facts.transcriptDir === undefined) {
      return { ok: false, reason: "workflow_run_incomplete" };
    }
    if (statOf(context, facts.scriptPath).kind !== "file") return { ok: false, reason: "script_missing" };
    const journalPath = join(facts.transcriptDir, "journal.jsonl");
    if (statOf(context, journalPath).kind !== "file") return { ok: false, reason: "journal_missing" };
    const identity: VerifiedIdentity = {
      kind: "workflow_run",
      runId: facts.runId,
      scriptPath: facts.scriptPath,
      journalPath,
    };
    return {
      ok: true,
      carryMode: "reconstruct",
      operations: [],
      verifiedIdentity: identity,
      continuation: continuationMechanismOf(identity),
    };
  },
};

const scheduledWakeup: FamilyAdapter = {
  family: "scheduled_wakeup",
  qualify(item) {
    if (
      item.toolUseId === null ||
      item.scheduledForMs === null ||
      !Number.isFinite(item.scheduledForMs) ||
      item.scheduledForMs <= 0
    ) {
      return { ok: false, reason: "scheduled_time_invalid" };
    }
    const identity: VerifiedIdentity = {
      kind: "scheduled_time",
      toolUseId: item.toolUseId,
      scheduledForMs: item.scheduledForMs,
    };
    return {
      ok: true,
      carryMode: "rearm",
      operations: [],
      verifiedIdentity: identity,
      continuation: continuationMechanismOf(identity),
    };
  },
};

export const FAMILY_ADAPTERS: Readonly<Record<AsyncWorkFamily, FamilyAdapter>> = {
  background_shell: backgroundShell,
  agent,
  workflow,
  monitor,
  scheduled_wakeup: scheduledWakeup,
};

function sameIdentity(a: VerifiedIdentity, b: VerifiedIdentity): boolean {
  return JSON.stringify(a, Object.keys(a).sort()) === JSON.stringify(b, Object.keys(b).sort());
}

export interface QualificationOutcome {
  /** Items closed here with one truthful terminal outcome, so the seam continues without them. */
  terminalized: Array<{
    launchId: string;
    family: AsyncWorkFamily;
    outcome: "failed";
    reason: MonitorLaunchUnresolvable;
  }>;
  qualified: Array<{
    launchId: string;
    family: AsyncWorkFamily;
    carryMode: QualifiedCarryMode;
    continuation: ContinuationMechanism;
  }>;
  refused: Array<{ launchId: string; family: AsyncWorkFamily; reason: QualificationRefusal }>;
}

/**
 * Run every family adapter over the thread's active items, once, before a
 * snapshot. A verified item is qualified (or re-verified) in the store; an item
 * that fails stays unqualified, and one that was qualified earlier but no
 * longer verifies — or whose identity changed — is marked unverified so the
 * snapshot refuses it. Terminal items are never touched.
 */
export function qualifyActiveItems(
  store: ContinuityStore,
  threadId: string,
  context: AdapterContext,
  nowMs: number,
): QualificationOutcome {
  const outcome: QualificationOutcome = { terminalized: [], qualified: [], refused: [] };
  for (const item of store.listItems(threadId)) {
    if (item.state === "terminal") continue;
    if (item.family === "monitor") {
      const resolved: MonitorLaunchResolution =
        context.platform === "win32"
          ? { ok: false, reason: "relaunch_unsupported_on_platform" }
          : resolveMonitorLaunch(context.sourceRolloutPath, item.toolUseId, context.readRollout);
      if (!resolved.ok) {
        // No command is invented and the seam is not blocked: the Monitor's
        // original run ended with the child, and nothing can restart it.
        store.recordTerminal({
          threadId,
          launchId: item.launchId,
          outcome: "failed",
          evidence: `monitor relaunch unavailable: ${resolved.reason}`,
          nowMs,
        });
        outcome.terminalized.push({
          launchId: item.launchId,
          family: "monitor",
          outcome: "failed",
          reason: resolved.reason,
        });
        continue;
      }
    }
    let result = FAMILY_ADAPTERS[item.family].qualify(item, context);
    if (result.ok && item.verifiedIdentity !== null && !sameIdentity(item.verifiedIdentity, result.verifiedIdentity)) {
      result = { ok: false, reason: "identity_changed" };
    }
    if (result.ok) {
      store.setCarryMode({
        threadId,
        launchId: item.launchId,
        carryMode: result.carryMode,
        operations: result.operations,
        verifiedIdentity: result.verifiedIdentity,
        nowMs,
      });
      if (item.state === "unknown") store.setVerified({ threadId, launchId: item.launchId, verified: true, nowMs });
      outcome.qualified.push({
        launchId: item.launchId,
        family: item.family,
        carryMode: result.carryMode,
        continuation: result.continuation,
      });
      continue;
    }
    if (item.carryMode !== "unqualified") {
      store.setVerified({ threadId, launchId: item.launchId, verified: false, nowMs });
    }
    outcome.refused.push({ launchId: item.launchId, family: item.family, reason: result.reason });
  }
  return outcome;
}
