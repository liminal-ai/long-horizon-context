/**
 * Compact-recovery vocabulary and pure planner (LIM-80 Slice 1).
 *
 * A governor receipt with `handoffOutcome.kind === "scheduled"` used to be a
 * permanent fail-closed latch on exact replay: the store kept only the
 * classification plus the final outcome, so a restart could not tell a crash
 * before claim from a crash after the LHC view was installed or after the
 * rebuilt rollout was written. This module adds the durable *attempt* record
 * (one per receipt: who owns it, which monotonic stage it reached, and the
 * artifact identities a later process needs to reconcile) and a pure planner
 * that maps those facts plus caller-observed live facts to the next
 * source-supported action.
 *
 * Nothing here executes: no SQLite, no processes, no LHC calls. The store
 * operations live in receipt-store.ts; execution of planner actions is Slice 2.
 *
 * Stage order mirrors the production path exactly (wrapper/run.ts
 * runAutoOperation → commands/context-mutation.ts runContextMutation →
 * wrapper/handoff.ts executeHandoff):
 *
 *   receipt_scheduled     receipt row inserted (handoffOutcome "scheduled"); no
 *                         attempt row yet — this is also what every pre-Slice-1
 *                         scheduled row looks like on reopen
 *   operation_claimed     runAutoOperation acquired the command guard
 *                         (mutationBegan); nothing durable changed yet
 *   view_installed        LHC prune/compact landed the served view. In this
 *                         host `sdk.threadView.compact` installs directly; the
 *                         preview before it is in-memory only, so there is no
 *                         durable "prepared but not installed" artifact to
 *                         discard — re-preparing means re-running the mutation.
 *   rollout_written       writeRebuiltRollout produced the rebuilt session
 *                         (rebuiltSessionId + rollout path)
 *   old_child_exited      handoff committed and terminateOldChild proved exit
 *   replacement_ready     replacement spawned, capture ready-after-replay,
 *                         child PTY-live and stable
 *   lineage_recorded      registerSuccessLineage ok (a warning-only step in
 *                         source; may be skipped forward past)
 *   descriptor_published  publishReadyDescriptor ok (also warning-only)
 *   terminal              a terminal handoffOutcome is attached
 */

import { createHash } from "node:crypto";

import type { StoredView } from "lhc";

import type { ProcessIdentity, ProcessLivenessResult } from "../runtime/process-identity.js";
import { identitiesEqual, parseStoredProcessIdentity } from "../runtime/process-identity.js";
import type { GovernorHandoffOutcome } from "./types.js";

/** Every GovernorHandoffOutcome kind. Kept as a value so stored kinds are validated, not trusted. */
export const GOVERNOR_HANDOFF_OUTCOME_KINDS = [
  "not_applicable",
  "deferred_open_turn",
  "scheduled",
  "mutation_deferred",
  "mutation_refused",
  "mutation_partial",
  "mutation_noop",
  "handoff_success",
  "handoff_cancelled",
  "handoff_rolled_back",
  "handoff_failed",
] as const satisfies readonly GovernorHandoffOutcome["kind"][];

export type TerminalHandoffOutcomeKind = Exclude<GovernorHandoffOutcome["kind"], "scheduled">;

export function isTerminalHandoffOutcomeKind(value: unknown): value is TerminalHandoffOutcomeKind {
  return (
    typeof value === "string" &&
    value !== "scheduled" &&
    (GOVERNOR_HANDOFF_OUTCOME_KINDS as readonly string[]).includes(value)
  );
}

export const RECOVERY_STAGES = [
  "receipt_scheduled",
  "operation_claimed",
  "view_installed",
  "rollout_written",
  "old_child_exited",
  "replacement_ready",
  "lineage_recorded",
  "descriptor_published",
  "terminal",
] as const;

export type RecoveryStage = (typeof RECOVERY_STAGES)[number];

export function recoveryStageIndex(stage: RecoveryStage): number {
  return RECOVERY_STAGES.indexOf(stage);
}

export function isRecoveryStage(value: unknown): value is RecoveryStage {
  return typeof value === "string" && (RECOVERY_STAGES as readonly string[]).includes(value);
}

/**
 * Artifact identities a later process needs to reconcile. Identity only —
 * never buffered input, tokens, prompts, or rollout content.
 */
export interface RecoveryArtifacts {
  threadId?: string;
  oldSessionId?: string;
  /**
   * Fingerprint of the LHC stored view as it was BEFORE this attempt mutated
   * anything (`NO_STORED_VIEW_FINGERPRINT` when the thread had no view).
   * Recorded at claim/baseline so a restart can tell "compact landed but the
   * stage write did not" from "nothing landed" — even when viewId is reused.
   */
  preMutationViewFingerprint?: string;
  /** LHC view identity from the compact receipt (e.g. `v123`); absent for prune-only. */
  viewId?: string;
  /** Fingerprint of the stored view this attempt installed (recorded with view_installed). */
  installedViewFingerprint?: string;
  rebuiltSessionId?: string;
  rebuiltRolloutPath?: string;
  /** Durable receipt persisted at reserve time; the rebuilt rollout's trailing runtime-note must equal it. */
  durableReceipt?: string;
  /** sha256 of the WHOLE rebuilt rollout file (prefix + trailing receipt). */
  rolloutFullSha256?: string;
  /** Verified prefix digest (sha256 hex) of the rebuilt rollout's served projection lines. */
  rolloutPrefixSha256?: string;
  /** Verified prefix line count / byte length, whole-file line count / byte length. */
  rolloutPrefixLineCount?: number;
  rolloutPrefixByteLength?: number;
  rolloutLineCount?: number;
  rolloutByteLength?: number;
  /**
   * Exact old-child ProcessIdentity, proven through the native provider BEFORE
   * the input barrier / termination. A restart uses it to tell "old child truly
   * exited" from "pid reused" (Slice 3B2). Never synthesized from a PID.
   */
  oldChild?: ProcessIdentity;
  /**
   * Durable post-commit input journal (LIM-80 Slice 3B1). Path + id only —
   * append-only identity facts. The mutable delivery state (pending/delivering/
   * delivered) lives IN the journal, never here, so these SQLite facts stay
   * append-only. Input bytes never appear in SQLite.
   */
  inputJournalPath?: string;
  inputJournalId?: string;
  /** Replacement child identity once spawned (liveness-verifiable). */
  replacementChild?: ProcessIdentity;
}

/** Sentinel fingerprint for "the thread had no stored view". */
export const NO_STORED_VIEW_FINGERPRINT = "none";

/**
 * Deterministic identity of an installed LHC view. viewId alone
 * (`v<maxEventOrder>`) can repeat across compacts, so the fingerprint also
 * covers createdAt, arrangement, bands, and source state as `describe()`
 * returns them. Pure; no I/O.
 */
export function storedViewFingerprint(view: StoredView | null): string {
  if (view === null) return NO_STORED_VIEW_FINGERPRINT;
  const material = {
    viewId: view.viewId,
    createdAt: view.createdAt,
    compactPoint: view.compactPoint,
    coveredFrom: view.coveredFrom,
    profileName: view.profileName,
    config: view.config,
    arrangement: view.arrangement,
    gaps: view.gaps,
    sourceState: view.sourceState,
    bands: view.bands,
  };
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

/**
 * Durable attempt record: one row per receipt. `attemptId` and `claimEpoch`
 * change on every claim/reclaim (ownership epoch); `stage` and `artifacts`
 * carry across reclaims because durable progress belongs to the receipt, not
 * to the process that made it.
 */
export interface RecoveryAttempt {
  receiptId: string;
  attemptId: string;
  /** Monotonic per receipt; +1 on every claim or reclaim. */
  claimEpoch: number;
  owner: ProcessIdentity;
  stage: RecoveryStage;
  artifacts: RecoveryArtifacts;
  /** Set only when stage === "terminal"; never "scheduled". */
  terminalOutcomeKind: TerminalHandoffOutcomeKind | null;
  claimedAt: string;
  stageUpdatedAt: string;
  createdAt: string;
  updatedAt: string;
}

/** Bump this if the persisted attempt payload shape changes incompatibly. */
export const RECOVERY_ATTEMPT_PAYLOAD_VERSION = 1;

const ARTIFACT_STRING_KEYS = [
  "threadId",
  "oldSessionId",
  "preMutationViewFingerprint",
  "viewId",
  "installedViewFingerprint",
  "rebuiltSessionId",
  "rebuiltRolloutPath",
  "durableReceipt",
  "rolloutFullSha256",
  "rolloutPrefixSha256",
  "inputJournalPath",
  "inputJournalId",
] as const;
const ARTIFACT_IDENTITY_KEYS = ["oldChild", "replacementChild"] as const;
const ARTIFACT_NUMBER_KEYS = [
  "rolloutPrefixLineCount",
  "rolloutPrefixByteLength",
  "rolloutLineCount",
  "rolloutByteLength",
] as const;

/**
 * Merge new artifact facts into stored ones. Facts are append-only identity:
 * a stored value may be confirmed (equal) or newly set, never silently
 * replaced — a differing value for the same key is a structural contradiction
 * and is reported so the store can reject the write.
 */
export function mergeRecoveryArtifacts(
  stored: RecoveryArtifacts,
  incoming: RecoveryArtifacts,
): { ok: true; artifacts: RecoveryArtifacts } | { ok: false; conflictKey: keyof RecoveryArtifacts } {
  const merged: RecoveryArtifacts = { ...stored };
  for (const key of ARTIFACT_STRING_KEYS) {
    const next = incoming[key];
    if (next === undefined) continue;
    const prev = stored[key];
    if (prev !== undefined && prev !== next) return { ok: false, conflictKey: key };
    merged[key] = next;
  }
  for (const key of ARTIFACT_NUMBER_KEYS) {
    const next = incoming[key];
    if (next === undefined) continue;
    const prev = stored[key];
    if (prev !== undefined && prev !== next) return { ok: false, conflictKey: key };
    merged[key] = next;
  }
  for (const key of ARTIFACT_IDENTITY_KEYS) {
    const next = incoming[key];
    if (next === undefined) continue;
    const prev = stored[key];
    if (prev !== undefined && !identitiesEqual(prev, next)) {
      return { ok: false, conflictKey: key };
    }
    merged[key] = next;
  }
  return { ok: true, artifacts: merged };
}

export function parseRecoveryArtifacts(raw: unknown): RecoveryArtifacts | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const out: RecoveryArtifacts = {};
  for (const key of ARTIFACT_STRING_KEYS) {
    const v = o[key];
    if (v === undefined) continue;
    if (typeof v !== "string" || v === "") return null;
    out[key] = v;
  }
  for (const key of ARTIFACT_NUMBER_KEYS) {
    const v = o[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) return null;
    out[key] = v;
  }
  for (const key of ARTIFACT_IDENTITY_KEYS) {
    if (o[key] === undefined) continue;
    const id = parseStoredProcessIdentity(o[key]);
    if (id === null) return null;
    out[key] = id;
  }
  return out;
}

export function parseRecoveryAttempt(raw: unknown): RecoveryAttempt | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.receiptId !== "string" || o.receiptId === "") return null;
  if (typeof o.attemptId !== "string" || o.attemptId === "") return null;
  if (typeof o.claimEpoch !== "number" || !Number.isInteger(o.claimEpoch) || o.claimEpoch < 1) return null;
  const owner = parseStoredProcessIdentity(o.owner);
  if (owner === null) return null;
  if (!isRecoveryStage(o.stage)) return null;
  const artifacts = parseRecoveryArtifacts(o.artifacts ?? {});
  if (artifacts === null) return null;
  const terminalOutcomeKind =
    o.terminalOutcomeKind === null || o.terminalOutcomeKind === undefined
      ? null
      : isTerminalHandoffOutcomeKind(o.terminalOutcomeKind)
        ? o.terminalOutcomeKind
        : undefined;
  if (terminalOutcomeKind === undefined) return null;
  if ((o.stage === "terminal") !== (terminalOutcomeKind !== null)) return null;
  for (const ts of ["claimedAt", "stageUpdatedAt", "createdAt", "updatedAt"] as const) {
    if (typeof o[ts] !== "string" || o[ts] === "") return null;
  }
  return {
    receiptId: o.receiptId,
    attemptId: o.attemptId,
    claimEpoch: o.claimEpoch,
    owner,
    stage: o.stage,
    artifacts,
    terminalOutcomeKind,
    claimedAt: o.claimedAt as string,
    stageUpdatedAt: o.stageUpdatedAt as string,
    createdAt: o.createdAt as string,
    updatedAt: o.updatedAt as string,
  };
}

// ── Planner ──────────────────────────────────────────────────────────

/**
 * Three-way observation of a durable fact the caller checked right now.
 * `unknown` means the caller did not (or could not) check; the planner never
 * treats unknown as contradiction.
 */
export type ObservedFact = "present" | "absent" | "unknown";

/**
 * Current LHC stored-view identity as read NOW via `threadView.describe`.
 * `unreadable` is a transient read failure — never a contradiction.
 */
export type CurrentStoredViewObservation =
  | { kind: "present"; viewId: string; fingerprint: string }
  | { kind: "none" }
  | { kind: "unreadable"; reason: string };

/**
 * Caller-observed live facts. All optional: an unobserved fact is `unknown`.
 * The planner performs no I/O; whoever calls it probes and reports.
 */
export interface RecoveryObservation {
  /** Identity of the process asking. */
  self: ProcessIdentity;
  /** Liveness of `attempt.owner` as probed now (required to decide wait vs reclaim). */
  ownerLiveness?: ProcessLivenessResult;
  /**
   * Exact current stored view (preferred). Compared against
   * `artifacts.preMutationViewFingerprint` at operation_claimed and against
   * `artifacts.installedViewFingerprint` at view_installed.
   */
  currentView?: CurrentStoredViewObservation;
  /** Coarse fallback when only presence was checked; ignored when `currentView` is set. */
  viewInstalled?: ObservedFact;
  /** Rebuilt rollout file for `artifacts.rebuiltSessionId` present and readable. */
  rolloutPresent?: ObservedFact;
  /** Old child (session `artifacts.oldSessionId`) process liveness, if identifiable. */
  oldChildLiveness?: ProcessLivenessResult;
  /** Replacement child liveness for `artifacts.replacementChild`. */
  replacementLiveness?: ProcessLivenessResult;
  /** Success lineage row for rebuiltSessionId present. */
  lineageRecorded?: ObservedFact;
  /** Ready descriptor for the replacement generation present. */
  descriptorPublished?: ObservedFact;
}

export interface RecoveryPlanInput {
  receiptId: string;
  /** The receipt's current durable outcome (null when the row carries none). */
  handoffOutcome: GovernorHandoffOutcome | null;
  /** Durable attempt row, or null when none exists (fresh or pre-Slice-1 row). */
  attempt: RecoveryAttempt | null;
  observed: RecoveryObservation;
}

/**
 * Next action. Every kind is a name for something the runtime already does
 * (or will do in Slice 2); nothing here is executed by this module.
 */
export type RecoveryAction =
  /** No attempt row: take ownership at operation_claimed and start the mutation. */
  | { kind: "claim_scheduled_work"; reason: string }
  /**
   * Foreign owner is live, its liveness is indeterminate, or it was never
   * probed: do nothing, retry later. `ownerLiveness` says which — a caller
   * that sees `unprobed` should probe before deciding anything.
   */
  | { kind: "wait_for_owner"; reason: string; ownerLiveness: "ok" | "indeterminate" | "unprobed" }
  /** Foreign owner is kernel-proven dead: reclaim (CAS on attemptId), then follow `resume`. */
  | { kind: "reclaim_dead_owner"; reason: string; resume: RecoveryAction }
  /**
   * A required current observation was not supplied or could not be read
   * (transient): do nothing now, re-observe and re-plan. Never terminal.
   */
  | { kind: "retry_observation"; reason: string; observation: "current_view" }
  /** Owned, claimed, nothing durable landed: re-run preview+mutation from scratch. */
  | { kind: "reprepare_from_scratch"; reason: string }
  /** Owned, LHC view already installed: do NOT compact again; materialize a rollout from it. */
  | { kind: "reconcile_installed_view"; reason: string }
  /** Owned, rollout already written: verify it and reuse it for the handoff. */
  | { kind: "verify_reuse_rollout"; reason: string }
  /** Owned, old child gone / replacement not yet proven: spawn or verify the replacement. */
  | { kind: "continue_replacement"; reason: string }
  /**
   * Owned, replacement liveness not currently known (unprobed or
   * indeterminate) at a stage that requires it: probe/verify before doing
   * anything; never spawn a second child on this result.
   */
  | { kind: "verify_replacement"; reason: string; replacementLiveness: "unprobed" | "indeterminate" }
  /** Owned, replacement proven live now: finish lineage/descriptor bookkeeping. */
  | { kind: "reconcile_lineage_descriptor"; reason: string }
  /**
   * Owned, replacement proven live now AND lineage AND descriptor observed
   * present, but the receipt still lacks a terminal outcome: attach it.
   */
  | { kind: "attach_terminal_outcome"; reason: string; outcomeKind: "handoff_success" }
  /**
   * Receipt already carries a terminal outcome but the attempt row is still
   * non-terminal: stale bookkeeping. Align the attempt to the receipt's
   * outcome atomically; never re-run mutation. Receipt outcome is authoritative.
   */
  | { kind: "reconcile_attempt_terminal"; reason: string; outcomeKind: TerminalHandoffOutcomeKind }
  /** Receipt already carries a terminal outcome (and attempt agrees, if any). */
  | { kind: "terminal_complete"; reason: string; outcomeKind: TerminalHandoffOutcomeKind }
  /** Structurally contradictory/corrupt facts: do not touch anything. */
  | { kind: "terminal_refuse"; reason: string };

function terminalOutcomeKindOf(outcome: GovernorHandoffOutcome | null): TerminalHandoffOutcomeKind | null {
  return outcome !== null && outcome.kind !== "scheduled" ? outcome.kind : null;
}

/**
 * Later handoff stages require CURRENT proof, never inference from the stored
 * stage alone. Shared by replacement_ready / lineage_recorded /
 * descriptor_published.
 */
function planLateStage(observed: RecoveryObservation, stageLabel: string): RecoveryAction | { kind: "live" } {
  const live = observed.replacementLiveness;
  if (live === undefined) {
    return {
      kind: "verify_replacement",
      reason: `stage ${stageLabel}: replacement liveness not probed; verify before continuing`,
      replacementLiveness: "unprobed",
    };
  }
  if (!live.ok) {
    if (live.code === "not_found") {
      return {
        kind: "continue_replacement",
        reason: `stage ${stageLabel}: replacement child is kernel-proven absent; respawn from rebuilt rollout`,
      };
    }
    return {
      kind: "verify_replacement",
      reason: `stage ${stageLabel}: replacement liveness indeterminate (${live.message}); do not spawn a second child`,
      replacementLiveness: "indeterminate",
    };
  }
  return { kind: "live" };
}

/**
 * Plan by owned stage. Precondition: caller established that `self` owns (or
 * is about to reclaim) the attempt. Only observed contradictions refuse;
 * `unknown` and missing optional artifacts degrade to re-doing that step.
 */
function planOwnedStage(attempt: RecoveryAttempt, observed: RecoveryObservation): RecoveryAction {
  const a = attempt.artifacts;
  switch (attempt.stage) {
    case "receipt_scheduled":
      // An attempt row never sits at receipt_scheduled (claim moves it to
      // operation_claimed). Treat as claimed-but-idle rather than corrupt.
      return { kind: "reprepare_from_scratch", reason: "attempt at receipt_scheduled: nothing durable landed" };
    case "operation_claimed": {
      // Cross-database gap: the SDK compact commits in the LHC thread file,
      // the stage advance in cc-lhc.sqlite. If a baseline fingerprint was
      // recorded, the CURRENT stored view decides whether compact landed.
      const baseline = a.preMutationViewFingerprint;
      if (baseline === undefined) {
        return {
          kind: "reprepare_from_scratch",
          reason:
            "claimed with no pre-mutation view baseline recorded; preview is in-memory only, so re-run prune/compact",
        };
      }
      const cur = observed.currentView;
      if (cur === undefined) {
        return {
          kind: "retry_observation",
          reason:
            "claimed with a pre-mutation view baseline; current stored view not observed — read it before deciding",
          observation: "current_view",
        };
      }
      if (cur.kind === "unreadable") {
        return {
          kind: "retry_observation",
          reason: `current stored view unreadable (${cur.reason}); retry, not terminal`,
          observation: "current_view",
        };
      }
      const currentFingerprint = cur.kind === "none" ? NO_STORED_VIEW_FINGERPRINT : cur.fingerprint;
      if (currentFingerprint === baseline) {
        return {
          kind: "reprepare_from_scratch",
          reason: "current stored view equals the pre-mutation baseline; nothing landed — re-run prune/compact",
        };
      }
      return {
        kind: "reconcile_installed_view",
        reason: `current stored view differs from the pre-mutation baseline${
          cur.kind === "present" ? ` (${cur.viewId})` : ""
        }: compact landed before the stage advance — never compact again`,
      };
    }
    case "view_installed": {
      const cur = observed.currentView;
      if (cur !== undefined) {
        if (cur.kind === "unreadable") {
          return {
            kind: "retry_observation",
            reason: `installed view unreadable (${cur.reason}); retry, not terminal`,
            observation: "current_view",
          };
        }
        const expected = a.installedViewFingerprint;
        if (cur.kind === "none") {
          return {
            kind: "terminal_refuse",
            reason: `stage view_installed but LHC has no stored view${a.viewId ? ` (expected ${a.viewId})` : ""}`,
          };
        }
        if (expected !== undefined && cur.fingerprint !== expected) {
          return {
            kind: "terminal_refuse",
            reason: `stage view_installed but current stored view ${cur.viewId} contradicts the recorded installed identity`,
          };
        }
      } else if (observed.viewInstalled === "absent") {
        return {
          kind: "terminal_refuse",
          reason: `stage view_installed but LHC reports no installed view${a.viewId ? ` (${a.viewId})` : ""}`,
        };
      }
      return {
        kind: "reconcile_installed_view",
        reason: "LHC view installed; no second compact — write the rebuilt rollout from it",
      };
    }
    case "rollout_written":
      if (a.rebuiltSessionId === undefined) {
        return { kind: "terminal_refuse", reason: "stage rollout_written without rebuiltSessionId" };
      }
      if (observed.rolloutPresent === "absent") {
        // Optional artifact missing is not terminal: the installed view is authoritative.
        return {
          kind: "reconcile_installed_view",
          reason: `rebuilt rollout ${a.rebuiltSessionId} missing; re-materialize from installed view`,
        };
      }
      return {
        kind: "verify_reuse_rollout",
        reason: `rebuilt rollout ${a.rebuiltSessionId} recorded; verify and reuse`,
      };
    case "old_child_exited":
      if (a.rebuiltSessionId === undefined) {
        return { kind: "terminal_refuse", reason: "stage old_child_exited without rebuiltSessionId" };
      }
      if (observed.oldChildLiveness?.ok === true) {
        return { kind: "terminal_refuse", reason: "stage old_child_exited but old child identity is live" };
      }
      if (observed.rolloutPresent === "absent") {
        return {
          kind: "reconcile_installed_view",
          reason: `rebuilt rollout ${a.rebuiltSessionId} missing after old child exit; re-materialize from installed view`,
        };
      }
      return { kind: "continue_replacement", reason: "old child exit proven; spawn/verify replacement" };
    case "replacement_ready":
    case "lineage_recorded":
    case "descriptor_published": {
      if (a.rebuiltSessionId === undefined) {
        return { kind: "terminal_refuse", reason: `stage ${attempt.stage} without rebuiltSessionId` };
      }
      const late = planLateStage(observed, attempt.stage);
      if (late.kind !== "live") return late;
      // Replacement is proven live NOW. Bookkeeping must also be observed
      // present now; the durable stage alone never justifies a success outcome.
      const lineageOk = observed.lineageRecorded === "present";
      const descriptorOk = observed.descriptorPublished === "present";
      if (!lineageOk || !descriptorOk) {
        const missing = [
          ...(lineageOk ? [] : [`lineage ${observed.lineageRecorded ?? "unknown"}`]),
          ...(descriptorOk ? [] : [`descriptor ${observed.descriptorPublished ?? "unknown"}`]),
        ].join(", ");
        return {
          kind: "reconcile_lineage_descriptor",
          reason: `stage ${attempt.stage}: replacement live; bookkeeping not confirmed (${missing})`,
        };
      }
      return {
        kind: "attach_terminal_outcome",
        reason: `stage ${attempt.stage}: replacement live, lineage and descriptor present; receipt still lacks a terminal outcome`,
        outcomeKind: "handoff_success",
      };
    }
    case "terminal":
      return {
        kind: "terminal_complete",
        reason: "attempt terminal",
        outcomeKind: attempt.terminalOutcomeKind ?? "handoff_failed",
      };
  }
}

/**
 * Pure recovery planner. Maps durable receipt + attempt facts and the caller's
 * current observations to one next action. Never mutates, never probes.
 */
export function planRecovery(input: RecoveryPlanInput): RecoveryAction {
  const { handoffOutcome, attempt, observed } = input;

  // Receipt-level terminal outcome is authoritative: nothing to recover. A
  // still-open attempt row under it is stale bookkeeping to align, not a
  // reason to refuse or to re-run anything.
  const receiptTerminal = terminalOutcomeKindOf(handoffOutcome);
  if (receiptTerminal !== null) {
    if (attempt !== null && attempt.stage !== "terminal") {
      return {
        kind: "reconcile_attempt_terminal",
        reason: `receipt outcome ${receiptTerminal} is terminal but attempt is at ${attempt.stage}; align attempt`,
        outcomeKind: receiptTerminal,
      };
    }
    return { kind: "terminal_complete", reason: "receipt carries a terminal outcome", outcomeKind: receiptTerminal };
  }

  // Scheduled (or outcome-less) receipt.
  if (attempt === null) {
    return {
      kind: "claim_scheduled_work",
      reason: "scheduled receipt has no durable attempt: unclaimed recoverable work (pre-claim crash or legacy row)",
    };
  }
  if (attempt.receiptId !== input.receiptId) {
    return { kind: "terminal_refuse", reason: "attempt receiptId does not match receipt" };
  }
  if (attempt.stage === "terminal") {
    return {
      kind: "terminal_refuse",
      reason: `attempt is terminal (${attempt.terminalOutcomeKind ?? "unknown"}) but receipt outcome is still scheduled`,
    };
  }

  const owned = identitiesEqual(attempt.owner, observed.self);
  if (owned) return planOwnedStage(attempt, observed);

  const liveness = observed.ownerLiveness;
  if (liveness === undefined) {
    return {
      kind: "wait_for_owner",
      reason: `owner pid ${attempt.owner.pid} liveness not probed; probe before deciding`,
      ownerLiveness: "unprobed",
    };
  }
  if (liveness.ok) {
    return { kind: "wait_for_owner", reason: `owner pid ${attempt.owner.pid} is live; wait`, ownerLiveness: "ok" };
  }
  if (liveness.code === "indeterminate") {
    return {
      kind: "wait_for_owner",
      reason: `owner pid ${attempt.owner.pid} liveness indeterminate (${liveness.message}); never steal`,
      ownerLiveness: "indeterminate",
    };
  }
  // Kernel-proven dead owner: reclaimable. claimEpoch is audit evidence only —
  // repeated dead owners are retry state, not a protocol limit.
  const resume = planOwnedStage(attempt, observed);
  return {
    kind: "reclaim_dead_owner",
    reason: `owner pid ${attempt.owner.pid} is kernel-proven absent; reclaim at stage ${attempt.stage}`,
    resume,
  };
}
