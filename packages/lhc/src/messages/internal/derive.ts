import type { EventKind } from "../../intake-stream/index.js";
import type { CompletionTx, ErrorResult, HandlerDerivationWrite, HandlerRunContext } from "../../shared-tech/index.js";
import {
  applyDerivationSuccess,
  createPostCommitHookSet,
  type DurableWorkDispatchResult,
  runWorkHandler,
} from "../../shared-tech/index.js";
import { type EnqueueDerivationTarget, hasLiveItem, type WorkKind } from "../../shared-tech/work-queue/index.js";
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

function workInFlight(messageId: string, workKind: WorkKind, sourceVersion: number): MessageDeriveResult {
  return failedDerive(messageId, {
    errorClass: "caller_error",
    code: "derivation_work_in_flight",
    reason: `${workKind} work for message ${messageId} at sourceVersion ${sourceVersion} is already live`,
  });
}

function applyRecoveredMessageWrite(
  run: HandlerRunContext,
  workKind: WorkKind,
  messageId: string,
  expected: { state: string; sourceVersion: number } | undefined,
  sourceVersion: number,
  write: HandlerDerivationWrite,
  onApplied?: (transaction: CompletionTx) => void,
): { applied: boolean; liveWork: boolean } {
  const db = run.openDb();
  const postCommitHook = createPostCommitHookSet();
  db.exec("BEGIN IMMEDIATE;");
  try {
    if (hasLiveItem(db, workKind, { messageId }, sourceVersion)) {
      db.exec("COMMIT;");
      return { applied: false, liveWork: true };
    }

    const metadata = write.metadata === undefined ? null : JSON.stringify(write.metadata);
    const gaps = write.gaps === undefined ? null : JSON.stringify(write.gaps);
    const derivedAt = run.clock().toISOString();
    let applied = false;
    let wrote = false;
    if (expected === undefined) {
      const inserted = db
        .prepare(
          `INSERT OR IGNORE INTO derivation
             (subject_kind, subject_id, derivation_type, state, content, metadata, gaps, source_version, derived_at)
           VALUES ('message', ?, ?, 'ready', ?, ?, ?, ?, ?)`,
        )
        .run(messageId, write.derivationType, write.content, metadata, gaps, sourceVersion, derivedAt);
      applied = Number(inserted.changes) > 0;
      wrote = applied;
    } else if (expected.state !== "pending" && expected.state !== "failed") {
      applied = expected.state === "ready" && expected.sourceVersion === sourceVersion;
    } else {
      const changed = db
        .prepare(
          `UPDATE derivation
           SET state = 'ready', content = ?, reason = NULL, metadata = ?,
               gaps = ?, derived_at = ?, source_version = ?
           WHERE subject_kind = 'message' AND subject_id = ? AND derivation_type = ?
             AND state = ? AND source_version = ?`,
        )
        .run(
          write.content,
          metadata,
          gaps,
          derivedAt,
          sourceVersion,
          messageId,
          write.derivationType,
          expected.state,
          expected.sourceVersion,
        );
      applied = Number(changed.changes) > 0;
      wrote = applied;
    }
    if (!applied) {
      const current = readMessageDerivationRow(db, messageId, write.derivationType);
      applied = current?.state === "ready" && current.sourceVersion === sourceVersion;
    }
    if (wrote && onApplied !== undefined) onApplied({ db, onCommit: postCommitHook.add });
    db.exec("COMMIT;");
    if (wrote) postCommitHook.flush();
    return { applied, liveWork: false };
  } catch (cause) {
    db.exec("ROLLBACK;");
    throw cause;
  }
}

export async function deriveMessageInThread(
  run: HandlerRunContext,
  messageId: string,
  opts?: { sourceVersion?: number },
): Promise<MessageDeriveResult> {
  const db = run.openDb();
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
  if (hasLiveItem(db, mapped.workKind, { messageId }, sourceVersion)) {
    return workInFlight(messageId, mapped.workKind, sourceVersion);
  }
  const handler = messageWorkHandlers[mapped.workKind];
  if (handler === undefined) {
    return failedDerive(messageId, {
      errorClass: "state_corruption",
      code: "unknown_work_kind",
      reason: `no handler registered for work kind "${mapped.workKind}"`,
    });
  }
  const outcome = await runWorkHandler(
    db,
    run.config,
    handler,
    { workItemId: `inline-${messageId}-${mapped.workKind}`, kind: mapped.workKind, sourceRef: { messageId } },
    run,
  );
  if (!outcome.ok) {
    if ("deferred" in outcome) {
      return failedDerive(messageId, {
        errorClass: "state_corruption",
        code: "unknown_work_kind",
        reason: "message derivation handler returned unsupported deferred outcome",
      });
    }
    if ("blocked" in outcome) {
      return failedDerive(messageId, {
        errorClass: "state_corruption",
        code: "source_damaged",
        reason: outcome.reason,
      });
    }
    return providerFailure(messageId, outcome.reason);
  }
  const write = outcome.derivations?.[0];
  if (write === undefined) return providerFailure(messageId, "message handler returned no derivation write");
  const persisted = applyRecoveredMessageWrite(
    run,
    mapped.workKind,
    messageId,
    row,
    sourceVersion,
    write,
    outcome.onApplied,
  );
  if (!persisted.applied) {
    if (persisted.liveWork) return workInFlight(messageId, mapped.workKind, sourceVersion);
    const current = readMessageDerivationRow(db, messageId, mapped.derivationType);
    if (current?.state !== "ready" || current.sourceVersion !== sourceVersion) {
      return workInFlight(messageId, mapped.workKind, sourceVersion);
    }
  }
  return { messageId, outcome: "derived", derivationType: mapped.derivationType, sourceVersion };
}

export function writeMessageDerivationFloorInThread(
  run: HandlerRunContext,
  recovery: {
    messageId: string;
    derivationType: "smoothed_prompt" | "tool_result_summary";
    content: string;
    sourceVersion: number;
  },
): { persisted: boolean } {
  const workKind = recovery.derivationType === "smoothed_prompt" ? "prompt_smoothing" : "tool_result_summary";
  const row = readMessageDerivationRow(run.openDb(), recovery.messageId, recovery.derivationType);
  const persisted = applyRecoveredMessageWrite(run, workKind, recovery.messageId, row, recovery.sourceVersion, {
    subjectKind: "message",
    subjectId: recovery.messageId,
    derivationType: recovery.derivationType,
    content: recovery.content,
  });
  return { persisted: persisted.applied };
}

export async function dispatchMessageDeriveWork(
  run: HandlerRunContext,
  item: {
    workItemId: string;
    claimEpoch: number;
    sourceVersion: number;
    derivations: readonly EnqueueDerivationTarget[];
  },
): Promise<DurableWorkDispatchResult> {
  const db = run.openDb();
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
  const outcome = await runWorkHandler(
    db,
    run.config,
    handler,
    {
      workItemId: item.workItemId,
      kind: mapped.workKind,
      sourceRef: { messageId: target.subjectId },
    },
    run,
  );
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
      run.config.clock().toISOString(),
      outcome.onApplied,
    );
    return { disposition };
  }
  if ("deferred" in outcome) {
    return { disposition: "failed", retryable: false, reason: "unsupported_deferred_message_derivation" };
  }
  if ("blocked" in outcome) return { disposition: "blocked", reason: outcome.reason };
  return { disposition: "failed", retryable: outcome.retryable, reason: outcome.reason };
}
