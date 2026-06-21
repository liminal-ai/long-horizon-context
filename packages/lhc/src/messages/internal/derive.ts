import type { DatabaseSync } from "node:sqlite";
import type { EventKind } from "../../intake-stream/index.js";
import type { ErrorResult, ResolvedSdkConfig } from "../../shared-tech/index.js";
import {
  applyDerivationSuccess,
  applyDerivationTerminalFailure,
  DerivationCompletionError,
  type DurableWorkDispatchResult,
  resolveInstancePoke,
  runWorkHandler,
} from "../../shared-tech/index.js";
import {
  createOrClaimImmediateWorkItem,
  type EnqueueDerivationTarget,
  type ImmediateDerivationBoundary,
  retryClaimedItem,
  type WorkKind,
} from "../../shared-tech/work-queue/index.js";
import { readMessageDerivationRow } from "./derivations.js";
import { messageWorkHandlers } from "./handlers.js";
import { readMessageById } from "./store.js";
import { MESSAGE_WORK_DERIVATIONS, MESSAGE_WORK_KINDS } from "./work.js";

export type MessageDeriveResult =
  | {
      messageId: string;
      outcome: "derived";
      derivationType: "smoothed_prompt" | "tool_result_summary";
      sourceVersion: number;
    }
  | { messageId: string; outcome: "not_derivable" }
  | { messageId: string; outcome: "failed"; error: ErrorResult };

function failedDerive(messageId: string, error: ErrorResult): MessageDeriveResult {
  return { messageId, outcome: "failed", error };
}

function derivationForKind(
  kind: Exclude<EventKind, "turn_end">,
): { workKind: WorkKind; derivationType: "smoothed_prompt" | "tool_result_summary" } | undefined {
  const workKind = MESSAGE_WORK_KINDS[kind];
  if (workKind === undefined) return undefined;
  const derivationType = MESSAGE_WORK_DERIVATIONS[workKind];
  if (derivationType === undefined) {
    throw new Error(`no derived derivation mapped for message work kind ${workKind}`);
  }
  return { workKind, derivationType };
}

function sourceVersionForDerive(row: { sourceVersion: number; state: string } | undefined): number {
  if (row === undefined) return 1;
  return row.state === "pending" ? row.sourceVersion : row.sourceVersion + 1;
}

function providerFailure(messageId: string, reason: string): MessageDeriveResult {
  return failedDerive(messageId, {
    errorClass: "system_error",
    code: "provider_failure",
    reason,
  });
}

function retryScheduled(messageId: string, reason: string): MessageDeriveResult {
  return failedDerive(messageId, {
    errorClass: "system_error",
    code: "derivation_retry_scheduled",
    reason,
  });
}

function pokeThreadScheduler(db: DatabaseSync): void {
  const row = db.prepare(`SELECT thread_id FROM thread_metadata WHERE id = 1`).get() as
    | { thread_id: string }
    | undefined;
  if (row !== undefined) resolveInstancePoke()(row.thread_id);
}

function workInFlight(messageId: string, workKind: WorkKind, sourceVersion: number): MessageDeriveResult {
  return failedDerive(messageId, {
    errorClass: "caller_error",
    code: "derivation_work_in_flight",
    reason: `${workKind} work for message ${messageId} at sourceVersion ${sourceVersion} is already live`,
  });
}

export async function deriveMessageInOpenDb(
  db: DatabaseSync,
  config: ResolvedSdkConfig,
  messageId: string,
  opts?: { sourceVersion?: number },
): Promise<MessageDeriveResult> {
  const record = readMessageById(db, messageId);
  if (record === undefined || record.deleted === true) {
    return failedDerive(messageId, {
      errorClass: "caller_error",
      code: "message_not_found",
      reason: `no message ${messageId} exists in this thread`,
    });
  }
  const mapped = derivationForKind(record.kind);
  if (mapped === undefined) return { messageId, outcome: "not_derivable" };
  const row = readMessageDerivationRow(db, messageId, mapped.derivationType);
  if (row?.state === "blocked") {
    return failedDerive(messageId, {
      errorClass: "state_corruption",
      code: "source_damaged",
      reason: row.reason ?? `derivation ${mapped.derivationType} for message ${messageId} is blocked`,
    });
  }
  const sourceVersion = opts?.sourceVersion ?? sourceVersionForDerive(row);
  const derivations = [
    { subjectKind: "message" as const, subjectId: messageId, derivationType: mapped.derivationType },
  ];
  const expectedDerivations: ImmediateDerivationBoundary[] =
    row === undefined
      ? derivations.map((target) => ({ ...target, exists: false }))
      : derivations.map((target) => ({ ...target, exists: true, state: row.state, sourceVersion: row.sourceVersion }));
  const handler = messageWorkHandlers[mapped.workKind];
  if (handler === undefined) {
    return failedDerive(messageId, {
      errorClass: "state_corruption",
      code: "unknown_work_kind",
      reason: `no handler registered for work kind "${mapped.workKind}"`,
    });
  }
  const claim = createOrClaimImmediateWorkItem(
    db,
    {
      owner: "messages",
      kind: mapped.workKind,
      sourceRef: { messageId },
      sourceVersion,
      derivations,
      expectedDerivations,
    },
    { now: config.clock().toISOString(), leaseDurationMs: config.lease.durationMs },
  );
  if (claim.outcome !== "claimed") {
    if (claim.outcome === "queued") pokeThreadScheduler(db);
    return workInFlight(messageId, mapped.workKind, sourceVersion);
  }
  const outcome = await runWorkHandler(db, config, handler, {
    workItemId: claim.item.workItemId,
    kind: mapped.workKind,
    sourceRef: { messageId },
  });
  const attempt = {
    sourceVersion,
    derivations,
    workItemId: claim.item.workItemId,
    claimEpoch: claim.item.claimEpoch,
  };
  if (outcome.ok) {
    try {
      const disposition = applyDerivationSuccess(
        db,
        attempt,
        outcome.derivations ?? [],
        config.clock().toISOString(),
        outcome.onApplied,
      );
      if (disposition !== "done") {
        return workInFlight(messageId, mapped.workKind, sourceVersion);
      }
    } catch (cause) {
      if (cause instanceof DerivationCompletionError) {
        return failedDerive(messageId, {
          errorClass: cause.errorClass,
          code: cause.code,
          reason: cause.message,
        });
      }
      throw cause;
    }
    return { messageId, outcome: "derived", derivationType: mapped.derivationType, sourceVersion };
  }
  const reason = outcome.reason;
  const attempts = claim.item.attempts + 1;
  const now = config.clock().toISOString();
  if (!("blocked" in outcome) && outcome.retryable && attempts < config.retry.budget) {
    const backoffMs = Math.min(config.retry.backoffBaseMs * 2 ** attempts, config.retry.backoffCapMs);
    const eligibleAt = new Date(Date.parse(now) + backoffMs).toISOString();
    const owned = retryClaimedItem(db, claim.item, { reason, attempts, eligibleAt });
    if (!owned) return workInFlight(messageId, mapped.workKind, sourceVersion);
    pokeThreadScheduler(db);
    return retryScheduled(messageId, reason);
  }
  try {
    const disposition = applyDerivationTerminalFailure(db, attempt, {
      reason,
      state: "blocked" in outcome ? "blocked" : "failed",
      attempts,
      now,
    });
    if (disposition === "lost_lease") {
      return workInFlight(messageId, mapped.workKind, sourceVersion);
    }
  } catch (cause) {
    if (cause instanceof DerivationCompletionError) {
      return failedDerive(messageId, {
        errorClass: cause.errorClass,
        code: cause.code,
        reason: cause.message,
      });
    }
    throw cause;
  }
  return providerFailure(messageId, reason);
}

export async function dispatchMessageDeriveWork(
  db: DatabaseSync,
  config: ResolvedSdkConfig,
  item: {
    workItemId: string;
    claimEpoch: number;
    sourceVersion: number;
    derivations: readonly EnqueueDerivationTarget[];
  },
): Promise<DurableWorkDispatchResult> {
  const target = item.derivations[0];
  if (target === undefined) return { disposition: "failed", retryable: false, reason: "missing_derivation_target" };
  const record = readMessageById(db, target.subjectId);
  if (record === undefined || record.deleted === true) {
    return { disposition: "blocked", reason: `source_damaged: message ${target.subjectId} not found` };
  }
  const mapped = derivationForKind(record.kind);
  if (mapped === undefined) return { disposition: "failed", retryable: false, reason: "not_derivable" };
  const handler = messageWorkHandlers[mapped.workKind];
  if (handler === undefined) return { disposition: "failed", retryable: false, reason: "unknown_work_kind" };
  const outcome = await runWorkHandler(db, config, handler, {
    workItemId: item.workItemId,
    kind: mapped.workKind,
    sourceRef: { messageId: target.subjectId },
  });
  if (outcome.ok) {
    const disposition = applyDerivationSuccess(
      db,
      {
        sourceVersion: item.sourceVersion,
        derivations: item.derivations,
        workItemId: item.workItemId,
        claimEpoch: item.claimEpoch,
      },
      outcome.derivations ?? [],
      config.clock().toISOString(),
      outcome.onApplied,
    );
    return { disposition };
  }
  if ("blocked" in outcome) return { disposition: "blocked", reason: outcome.reason };
  return { disposition: "failed", retryable: outcome.retryable, reason: outcome.reason };
}
