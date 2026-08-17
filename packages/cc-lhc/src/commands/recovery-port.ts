/**
 * LIM-80 Slice 3A: concrete store-backed RecoveryPort.
 *
 * The recovery boundary that context-mutation writes through on the automatic
 * path. It owns one receiptId + the current attemptId and turns each durable
 * milestone into an `advanceAttempt` CAS on that exact attempt:
 *
 *   recordBaseline       → operation_claimed  (pre-mutation view fingerprint + identity)
 *   recordViewInstalled  → view_installed     (installed view identity)
 *   reserveRebuiltSession→ view_installed     (rebuilt session id + exact path + receipt)
 *   recordRolloutWritten → rollout_written    (verified whole-file identities)
 *
 * Every write must be idempotent-or-forward: only `advanced`/`unchanged` are
 * accepted, and any other store result (not_owner / stage_regression /
 * artifact_conflict / terminal / attempt_missing) throws. A throw surfaces to
 * the caller as a truthful non-rebuilt outcome — it never silently continues.
 *
 * Recovery inputs after a restart come only from durable store artifacts plus
 * fresh observations, never pre-crash memory: reserveRebuiltSession reads the
 * durable reservation first and returns the exact existing one, minting a new
 * session id (randomUUID once) only when none is recorded.
 */

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AdvanceAttemptResult, GovernorReceiptStore } from "../governor/receipt-store.js";
import type { RecoveryArtifacts, RecoveryStage } from "../governor/recovery.js";
import { rolloutPathForSession } from "../rollout/sessions-index.js";
import type { RecoveryPort, RolloutVerificationArtifacts } from "./recovery-ops.js";

/**
 * A durable correlation/CAS conflict on the owned attempt (not_owner, stage
 * regression, artifact conflict, terminal, missing attempt, or an invalid/
 * mismatched reservation). These are STRUCTURAL: the caller may terminalize
 * (mutation_refused). Transient store I/O (SQLite errors) is NOT wrapped in this
 * type — it propagates as an ordinary Error so the caller leaves the attempt
 * open and retries.
 */
export class RecoveryPortCasError extends Error {
  readonly conflict:
    | "not_owner"
    | "stage_regression"
    | "artifact_conflict"
    | "terminal"
    | "attempt_missing"
    | "reservation_invalid"
    | "reservation_receipt_mismatch";
  constructor(conflict: RecoveryPortCasError["conflict"], message: string) {
    super(message);
    this.name = "RecoveryPortCasError";
    this.conflict = conflict;
  }
}

export interface StoreBackedRecoveryPortConfig {
  store: GovernorReceiptStore;
  receiptId: string;
  /** The attempt this operation owns; every advance CAS-checks it. */
  attemptId: string;
  /** Workspace root used to compute the reserved rollout path. */
  cwd: string;
  /** Identity artifacts recorded with the baseline. */
  threadId: string;
  oldSessionId: string;
  projectsRoot?: string;
  /** Session-id minting seam (tests); randomUUID in production, called once. */
  newSessionId?: () => string;
}

function defaultProjectsRoot(): string {
  return join(homedir(), ".claude", "projects");
}

function casErrorFor(
  result: Exclude<AdvanceAttemptResult, { kind: "advanced" } | { kind: "unchanged" }>,
  label: string,
) {
  switch (result.kind) {
    case "not_owner":
      return new RecoveryPortCasError(
        "not_owner",
        `recovery port ${label}: attempt ownership lost (stored attempt ${result.attempt.attemptId})`,
      );
    case "stage_regression":
      return new RecoveryPortCasError(
        "stage_regression",
        `recovery port ${label}: stage regression to ${result.requested} from ${result.attempt.stage}`,
      );
    case "artifact_conflict":
      return new RecoveryPortCasError(
        "artifact_conflict",
        `recovery port ${label}: artifact ${String(result.conflictKey)} contradicts the durable value`,
      );
    case "terminal":
      return new RecoveryPortCasError("terminal", `recovery port ${label}: attempt already terminal`);
    default:
      return new RecoveryPortCasError("attempt_missing", `recovery port ${label}: attempt row missing`);
  }
}

/**
 * Build a concrete RecoveryPort bound to one receipt + attempt. All four
 * methods are durable writes onto that attempt; none carries process lifecycle.
 */
export function createStoreBackedRecoveryPort(config: StoreBackedRecoveryPortConfig): RecoveryPort {
  const { store, receiptId, attemptId } = config;
  const projectsRoot = config.projectsRoot ?? defaultProjectsRoot();
  const mintSessionId = config.newSessionId ?? randomUUID;

  const advance = (stage: Exclude<RecoveryStage, "terminal">, artifacts: RecoveryArtifacts, label: string): void => {
    // store.advanceAttempt may THROW on transient store I/O — that propagates
    // as a plain Error (caller retries). A CAS-conflict RESULT is structural.
    const result = store.advanceAttempt({ receiptId, attemptId, stage, artifacts });
    if (result.kind !== "advanced" && result.kind !== "unchanged") {
      throw casErrorFor(result, label);
    }
  };

  return {
    recordBaseline(preMutationViewFingerprint) {
      advance(
        "operation_claimed",
        { preMutationViewFingerprint, threadId: config.threadId, oldSessionId: config.oldSessionId },
        "recordBaseline",
      );
    },
    recordViewInstalled({ viewId, installedViewFingerprint }) {
      advance("view_installed", { viewId, installedViewFingerprint }, "recordViewInstalled");
    },
    reserveRebuiltSession(durableReceipt) {
      // Idempotent per attempt: a COMPLETE existing reservation whose stored
      // durableReceipt equals the caller's exact receipt is returned as-is (no
      // new session id). randomUUID is used exactly once, only when NO reservation
      // artifact is recorded, so a retry after a crash keeps the same identity.
      const existing = store.getAttempt(receiptId);
      if (existing === null) {
        throw new RecoveryPortCasError("attempt_missing", "recovery port reserveRebuiltSession: attempt row missing");
      }
      if (existing.attemptId !== attemptId) {
        throw new RecoveryPortCasError(
          "not_owner",
          `recovery port reserveRebuiltSession: attempt ownership lost (stored attempt ${existing.attemptId})`,
        );
      }
      const {
        rebuiltSessionId: reservedId,
        rebuiltRolloutPath: reservedPath,
        durableReceipt: reservedReceipt,
      } = existing.artifacts;
      const anyReserved = reservedId !== undefined || reservedPath !== undefined || reservedReceipt !== undefined;
      if (anyReserved) {
        // A partial reservation (some but not all artifacts) is structurally invalid.
        if (reservedId === undefined || reservedPath === undefined || reservedReceipt === undefined) {
          throw new RecoveryPortCasError(
            "reservation_invalid",
            "recovery port reserveRebuiltSession: partial reservation (id/path/receipt not all present)",
          );
        }
        // A differing durable receipt is a correlation conflict: never let the
        // caller reuse the existing id/path while writing a different receipt.
        if (reservedReceipt !== durableReceipt) {
          throw new RecoveryPortCasError(
            "reservation_receipt_mismatch",
            "recovery port reserveRebuiltSession: stored durable receipt differs from the requested receipt",
          );
        }
        return { sessionId: reservedId, rolloutPath: reservedPath };
      }
      const sessionId = mintSessionId();
      const rolloutPath = rolloutPathForSession(projectsRoot, config.cwd, sessionId);
      advance(
        "view_installed",
        { rebuiltSessionId: sessionId, rebuiltRolloutPath: rolloutPath, durableReceipt },
        "reserveRebuiltSession",
      );
      return { sessionId, rolloutPath };
    },
    recordRolloutWritten(verification: RolloutVerificationArtifacts) {
      advance(
        "rollout_written",
        {
          rebuiltSessionId: verification.rebuiltSessionId,
          rebuiltRolloutPath: verification.rebuiltRolloutPath,
          rolloutFullSha256: verification.rolloutFullSha256,
          rolloutPrefixSha256: verification.rolloutPrefixSha256,
          rolloutPrefixLineCount: verification.rolloutPrefixLineCount,
          rolloutPrefixByteLength: verification.rolloutPrefixByteLength,
          rolloutLineCount: verification.rolloutLineCount,
          rolloutByteLength: verification.rolloutByteLength,
        },
        "recordRolloutWritten",
      );
    },
  };
}
