import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type ReadFileIdentityResult, readExactFileIdentity } from "cc-lhc-native";
import type { AsyncWorkFamily } from "../observation/async-work.js";
import { type RelaunchShellResolution, resolveRelaunchShell } from "./relaunch-shell.js";
import {
  type ContinuationMechanism,
  type ContinuityItem,
  type ContinuityOperation,
  type ContinuityStore,
  continuationMechanismOf,
  type QualifiedCarryMode,
  type VerifiedIdentity,
} from "./store.js";
import { discoverAdoptedTaskProcess } from "./task-process.js";

export type { ContinuationMechanism } from "./store.js";

export type PathFact =
  | { kind: "file"; dev: string; ino: string }
  | { kind: "dir" }
  | { kind: "missing" }
  | { kind: "unreadable" };

export interface AdapterContext {
  platform: NodeJS.Platform;
  sourceRolloutPath: string | undefined;
  statPath?: (path: string) => PathFact;
  readRollout?: (path: string) => string | null;
  relaunchShell?: RelaunchShellResolution;
  readFileIdentity?: (path: string) => ReadFileIdentityResult;
  oldChildPid?: number;
  discoverTaskProcess?: typeof discoverAdoptedTaskProcess;
}

export type MonitorLaunchUnresolvable =
  | "relaunch_shell_unavailable"
  | "no_rollout_binding"
  | "rollout_unreadable"
  | "launch_not_found"
  | "launch_ambiguous"
  | "launch_incomplete";

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
  | "win32_file_identity_unavailable"
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

type Refusal = Extract<Qualification, { ok: false }>;

export type OutputIdentity = Extract<VerifiedIdentity, { kind: "posix_output" | "win32_output" }>;

export function verifyOutputFile(context: AdapterContext, path: string | undefined): Refusal | OutputIdentity {
  if (path === undefined) return { ok: false, reason: "no_continuation_facts" };
  if (context.platform === "win32") {
    const read = (context.readFileIdentity ?? readExactFileIdentity)(path);
    if (read.ok) {
      return { kind: "win32_output", path, volumeId: read.identity.volumeId, fileId: read.identity.fileId };
    }
    switch (read.code) {
      case "not_found":
        return { ok: false, reason: "output_file_missing" };
      case "addon_unavailable":
      case "unsupported_platform":
        return { ok: false, reason: "win32_file_identity_unavailable" };
      default:
        return { ok: false, reason: "output_file_unreadable" };
    }
  }
  const fact = statOf(context, path);
  if (fact.kind === "missing") return { ok: false, reason: "output_file_missing" };
  if (fact.kind !== "file" || fact.ino === "0") return { ok: false, reason: "output_file_unreadable" };
  return { kind: "posix_output", path, dev: fact.dev, ino: fact.ino };
}

export function isRefusal(value: Refusal | OutputIdentity): value is Refusal {
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

export function sameIdentity(a: VerifiedIdentity, b: VerifiedIdentity): boolean {
  return JSON.stringify(a, Object.keys(a).sort()) === JSON.stringify(b, Object.keys(b).sort());
}

export interface QualificationOutcome {
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

export function qualifyActiveItems(
  store: ContinuityStore,
  threadId: string,
  context: AdapterContext,
  nowMs: number,
): QualificationOutcome {
  const outcome: QualificationOutcome = { terminalized: [], qualified: [], refused: [] };
  for (const item of store.listItems(threadId)) {
    if (item.state === "terminal") continue;
    if (item.family === "monitor" && item.relaunch !== null && item.verifiedIdentity !== null) {
      store.setCarryMode({
        threadId,
        launchId: item.launchId,
        carryMode: "reconstruct",
        operations: item.operations,
        verifiedIdentity: item.verifiedIdentity,
        nowMs,
      });
      if (item.state === "unknown") store.setVerified({ threadId, launchId: item.launchId, verified: true, nowMs });
      outcome.qualified.push({
        launchId: item.launchId,
        family: item.family,
        carryMode: "reconstruct",
        continuation: continuationMechanismOf(item.verifiedIdentity),
      });
      continue;
    }
    if (item.family === "monitor") {
      const shell = context.relaunchShell ?? resolveRelaunchShell(context.platform);
      const resolved: MonitorLaunchResolution = shell.ok
        ? resolveMonitorLaunch(context.sourceRolloutPath, item.toolUseId, context.readRollout)
        : { ok: false, reason: "relaunch_shell_unavailable" };
      if (!resolved.ok) {
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
      if (
        item.family === "background_shell" &&
        result.carryMode === "adopt" &&
        (result.verifiedIdentity.kind === "posix_output" || result.verifiedIdentity.kind === "win32_output") &&
        item.continuation?.taskProcess === undefined &&
        context.oldChildPid !== undefined
      ) {
        const discovered = (context.discoverTaskProcess ?? discoverAdoptedTaskProcess)(context.oldChildPid, {
          path: result.verifiedIdentity.path,
        });
        if (discovered !== null) {
          store.setTaskProcess({ threadId, launchId: item.launchId, taskProcess: discovered, nowMs });
        }
      }
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
