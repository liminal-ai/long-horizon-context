import type { AsyncWorkFamily } from "../observation/async-work.js";
import {
  type ContinuationMechanism,
  type ContinuityItem,
  type ContinuityOperation,
  type ContinuityStore,
  type ContinuityTransition,
  continuationMechanismOf,
  type QualifiedCarryMode,
  type RelaunchRecord,
  type TerminalEvidence,
  transitionOf,
  type VerifiedIdentity,
} from "./store.js";

export interface CarriedItem {
  launchId: string;
  family: AsyncWorkFamily;
  label: string;
  state: "active";
  carryMode: QualifiedCarryMode;
  operations: readonly ContinuityOperation[];
  taskId: string | null;
  toolUseId: string | null;
  scheduledForMs: number | null;
  verifiedIdentity: VerifiedIdentity;
  continuation: ContinuationMechanism;
  transition: ContinuityTransition;
  relaunch: RelaunchRecord | null;
}

export interface TerminalSinceSnapshot {
  launchId: string;
  family: AsyncWorkFamily;
  label: string;
  terminal: TerminalEvidence;
}

export interface ContinuitySnapshot {
  threadId: string;
  generation: number;
  oldSessionId: string;
  createdAtMs: number;
  items: readonly CarriedItem[];
}

export type SnapshotRefusal = "unverified_items" | "unqualified_items";

export type SnapshotResult =
  | { ok: true; snapshot: ContinuitySnapshot }
  | { ok: false; reason: SnapshotRefusal; launchIds: readonly string[] };

export type ClosureRefusal =
  | "new_work"
  | "unverified_items"
  | "unqualified_items"
  | "superseded"
  | "unknown_generation";

export interface ClosureResult {
  threadId: string;
  generation: number;
  closed: boolean;
  refusal: ClosureRefusal | null;
  carried: readonly CarriedItem[];
  terminalSinceSnapshot: readonly TerminalSinceSnapshot[];
  newWork: readonly CarriedItem[];
  unverified: readonly string[];
  unqualified: readonly string[];
}

function carried(item: ContinuityItem): CarriedItem {
  if (item.carryMode === "unqualified" || item.verifiedIdentity === null) {
    throw new Error(`cc-lhc continuity: cannot carry unqualified item ${item.launchId}`);
  }
  return {
    launchId: item.launchId,
    family: item.family,
    label: item.label,
    state: "active",
    carryMode: item.carryMode,
    operations: item.operations,
    taskId: item.taskId,
    toolUseId: item.toolUseId,
    scheduledForMs: item.scheduledForMs,
    verifiedIdentity: item.verifiedIdentity,
    continuation: continuationMechanismOf(item.verifiedIdentity),
    transition: transitionOf(continuationMechanismOf(item.verifiedIdentity)),
    relaunch: item.relaunch,
  };
}

export function snapshotContinuity(
  store: ContinuityStore,
  input: { threadId: string; oldSessionId: string; nowMs: number },
): SnapshotResult {
  const items = store.listItems(input.threadId);
  const unverified = items.filter((item) => item.state === "unknown").map((item) => item.launchId);
  if (unverified.length > 0) return { ok: false, reason: "unverified_items", launchIds: unverified };
  const active = items.filter((item) => item.state === "active");
  const unqualified = active.filter((item) => item.carryMode === "unqualified").map((item) => item.launchId);
  if (unqualified.length > 0) return { ok: false, reason: "unqualified_items", launchIds: unqualified };
  const generation = store.allocateGeneration({
    threadId: input.threadId,
    oldSessionId: input.oldSessionId,
    launchIds: active.map((item) => item.launchId),
    nowMs: input.nowMs,
  });
  return {
    ok: true,
    snapshot: {
      threadId: input.threadId,
      generation: generation.generation,
      oldSessionId: input.oldSessionId,
      createdAtMs: generation.createdAtMs,
      items: active.map(carried),
    },
  };
}

export function closeContinuitySnapshot(
  store: ContinuityStore,
  input: { threadId: string; generation: number; nowMs: number },
): ClosureResult {
  const base = {
    threadId: input.threadId,
    generation: input.generation,
    carried: [],
    terminalSinceSnapshot: [],
    newWork: [],
    unverified: [],
    unqualified: [],
  };
  const generation = store.getGeneration(input.threadId, input.generation);
  if (generation === null) return { ...base, closed: false, refusal: "unknown_generation" };
  if (generation.state === "superseded") return { ...base, closed: false, refusal: "superseded" };

  const members = new Set(generation.launchIds);
  const items = store.listItems(input.threadId);
  const carriedItems: CarriedItem[] = [];
  const terminalSince: TerminalSinceSnapshot[] = [];
  const unverified: string[] = [];
  const unqualified: string[] = [];
  const newWork: CarriedItem[] = [];
  for (const item of items) {
    if (members.has(item.launchId)) {
      if (item.state === "active" && item.carryMode === "unqualified") unqualified.push(item.launchId);
      else if (item.state === "active") carriedItems.push(carried(item));
      else if (item.state === "terminal" && item.terminal !== null) {
        terminalSince.push({
          launchId: item.launchId,
          family: item.family,
          label: item.label,
          terminal: item.terminal,
        });
      } else unverified.push(item.launchId);
      continue;
    }
    if (item.state !== "terminal" && item.createdAtMs >= generation.createdAtMs) {
      if (item.carryMode === "unqualified") unqualified.push(item.launchId);
      else newWork.push(carried(item));
    }
  }

  const refusal: ClosureRefusal | null =
    unverified.length > 0
      ? "unverified_items"
      : unqualified.length > 0
        ? "unqualified_items"
        : newWork.length > 0
          ? "new_work"
          : null;
  if (refusal === null && generation.state === "open") {
    store.setGenerationState({
      threadId: input.threadId,
      generation: input.generation,
      state: "closed",
      nowMs: input.nowMs,
    });
  }
  return {
    ...base,
    closed: refusal === null,
    refusal,
    carried: carriedItems,
    terminalSinceSnapshot: terminalSince,
    newWork,
    unverified,
    unqualified,
  };
}
