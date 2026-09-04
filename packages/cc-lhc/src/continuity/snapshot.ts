/**
 * Snapshot and closure over the parent-owned store (tech-design D6, LIM-145
 * AC-2.5 and AC-2.8).
 *
 * A snapshot is the accepted set of active work one handoff generation
 * carries. Closure re-reads the store after the replacement was built and
 * says, deterministically, whether that snapshot still describes the world:
 *  - work that finished before the snapshot is not carried (TC-2.8a);
 *  - work that finished during construction is reported once as terminal,
 *    never as a permanently active entry (TC-2.8b);
 *  - work that started after the snapshot means the snapshot is not a
 *    complete transfer, so closure refuses (TC-2.8c) and the caller must
 *    snapshot again or keep the old session authoritative;
 *  - an item whose state is not verified, or whose family has no qualified
 *    adapter, is never claimed (TC-2.5d): the snapshot refuses before any
 *    generation exists, and the old session stays authoritative.
 *
 * Both primitives read only the store and the caller's clock value. Nothing
 * here waits, retries, or consults elapsed time.
 */

import type { AsyncWorkFamily } from "../observation/async-work.js";
import {
  type ContinuationMechanism,
  type ContinuityItem,
  type ContinuityOperation,
  type ContinuityStore,
  type ContinuityTransition,
  continuationMechanismOf,
  type QualifiedCarryMode,
  type TerminalEvidence,
  transitionOf,
  type VerifiedIdentity,
} from "./store.js";

/**
 * One item as the replacement will receive it: identity, family, carry mode,
 * state, operations, the identity the adapter verified, and the continuation
 * mechanism that identity supports with the parameters needed to invoke it.
 */
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
  /** Truthful transition the mechanism produces; a relaunched Monitor is `restarted`, never adopted. */
  transition: ContinuityTransition;
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
  /** True when the snapshot is a complete transfer and the generation is now closed. */
  closed: boolean;
  refusal: ClosureRefusal | null;
  /** Snapshot members still active: what the replacement carries. */
  carried: readonly CarriedItem[];
  /** Snapshot members that finished during construction: represented once, as terminal. */
  terminalSinceSnapshot: readonly TerminalSinceSnapshot[];
  /** Active work launched after the snapshot. Non-empty means the transfer is incomplete. */
  newWork: readonly CarriedItem[];
  /** Snapshot members whose state is no longer verified. Non-empty means no claim. */
  unverified: readonly string[];
  /** Active items with no qualified carry mode. Non-empty means no claim. */
  unqualified: readonly string[];
}

/** Only a qualified mode may be carried; callers refuse before reaching here otherwise. */
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
  };
}

/**
 * Accept the current active set as one handoff generation. Terminal items are
 * left behind; an unverified or unqualified active item refuses the whole
 * snapshot — no generation is allocated, no item is stamped — rather than
 * being claimed. Each item is represented exactly once, in launch order.
 */
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

/**
 * Re-read the store against one snapshot and decide whether it is a complete
 * transfer. Closing marks the generation `closed`; a refusal leaves it `open`
 * for the caller to snapshot again or keep the old session.
 */
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
    // Not a member: work the snapshot did not see. Only still-open work makes
    // the transfer incomplete; work that already finished was never carried.
    // It is reported by identity — an unqualified newcomer is never carried.
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
