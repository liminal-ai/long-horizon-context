import type { DatabaseSync } from "node:sqlite";
import type {
  CompletionTx,
  HandlerDerivationWrite,
  HandlerOutcome,
  HandlerRunContext,
  ResolvedSdkConfig,
  SubjectKind,
} from "../derivation.js";
import { createPostCommitHookSet } from "../persist.js";
import type { EnqueueDerivationTarget, WorkKind, WorkSourceRef } from "../work-queue/index.js";

export type DurableWorkOperation =
  | { operation: "messages.derive"; messageId: string }
  | { operation: "turns.deriveTurn"; turnId: string }
  | { operation: "turns.deriveDetailedChunk"; chunkId: string }
  | { operation: "turns.deriveBriefChunk"; chunkId: string };

export interface DerivationAttempt {
  sourceVersion: number;
  derivations: readonly EnqueueDerivationTarget[];
  workItemId?: string;
}

export type DurableWorkDispatchResult =
  | { disposition: "done" | "stale_discarded" }
  | { disposition: "failed"; retryable: boolean; reason: string }
  | { disposition: "blocked"; reason: string };

export type DurableWorkDispatcher = (
  run: HandlerRunContext,
  item: {
    workItemId: string;
    kind: string;
    sourceRef: WorkSourceRef;
    sourceVersion: number;
    derivations: readonly EnqueueDerivationTarget[];
    operation: DurableWorkOperation;
  },
) => Promise<DurableWorkDispatchResult>;

export type DurableWorkDispatcherMap = Partial<Record<DurableWorkOperation["operation"], DurableWorkDispatcher>>;

export function operationIntent(kind: WorkKind, sourceRef: WorkSourceRef): DurableWorkOperation {
  switch (kind) {
    case "prompt_smoothing":
    case "tool_result_summary":
      if (!("messageId" in sourceRef)) throw new Error(`${kind} work requires a messageId source`);
      return { operation: "messages.derive", messageId: sourceRef.messageId };
    case "turn_derivation":
      if (!("turnId" in sourceRef)) throw new Error("turn_derivation work requires a turnId source");
      return { operation: "turns.deriveTurn", turnId: sourceRef.turnId };
    case "chunk_summary_detailed":
      if (!("chunkId" in sourceRef)) throw new Error("chunk_summary_detailed work requires a chunkId source");
      return { operation: "turns.deriveDetailedChunk", chunkId: sourceRef.chunkId };
    case "chunk_summary_brief":
      if (!("chunkId" in sourceRef)) throw new Error("chunk_summary_brief work requires a chunkId source");
      return { operation: "turns.deriveBriefChunk", chunkId: sourceRef.chunkId };
  }
}

export function writePendingDerivations(
  db: DatabaseSync,
  derivations: readonly EnqueueDerivationTarget[],
  sourceVersion: number,
): void {
  db.exec("BEGIN IMMEDIATE;");
  try {
    const upsert = db.prepare(
      `INSERT INTO derivation (subject_kind, subject_id, derivation_type, state, source_version)
       VALUES (?, ?, ?, 'pending', ?)
       ON CONFLICT (subject_kind, subject_id, derivation_type) DO UPDATE SET
         state = 'pending', content = NULL, reason = NULL, metadata = NULL,
         gaps = NULL, derived_at = NULL, source_version = excluded.source_version`,
    );
    for (const target of derivations) {
      upsert.run(target.subjectKind, target.subjectId, target.derivationType, sourceVersion);
    }
    db.exec("COMMIT;");
  } catch (cause) {
    db.exec("ROLLBACK;");
    throw cause;
  }
}

export function applyDerivationSuccess(
  db: DatabaseSync,
  attempt: DerivationAttempt,
  writes: readonly HandlerDerivationWrite[],
  derivedAt: string,
  onApplied?: (transaction: CompletionTx) => void,
): "done" | "stale_discarded" {
  const postCommitHook = createPostCommitHookSet();
  db.exec("BEGIN IMMEDIATE;");
  try {
    let hits = 0;
    const update = db.prepare(
      `UPDATE derivation
       SET state = 'ready', content = ?, reason = NULL, metadata = ?, gaps = ?, derived_at = ?
       WHERE subject_kind = ? AND subject_id = ? AND derivation_type = ? AND source_version = ?`,
    );
    for (const write of writes) {
      const changed = update.run(
        write.content,
        write.metadata === undefined ? null : JSON.stringify(write.metadata),
        write.gaps === undefined ? null : JSON.stringify(write.gaps),
        derivedAt,
        write.subjectKind,
        write.subjectId,
        write.derivationType,
        attempt.sourceVersion,
      );
      hits += Number(changed.changes);
    }
    const stale = writes.length > 0 && hits === 0;
    if (!stale && onApplied !== undefined) {
      onApplied({ db, onCommit: postCommitHook.add });
    }
    if (attempt.workItemId !== undefined) {
      db.prepare(`DELETE FROM work_item WHERE work_item_id = ?`).run(attempt.workItemId);
    }
    db.exec("COMMIT;");
    postCommitHook.flush();
    return stale ? "stale_discarded" : "done";
  } catch (cause) {
    db.exec("ROLLBACK;");
    throw cause;
  }
}

export function applyDerivationTerminalFailure(
  db: DatabaseSync,
  attempt: DerivationAttempt,
  opts: { reason: string; state: "failed" | "blocked"; attempts: number; now: string },
): void {
  db.exec("BEGIN IMMEDIATE;");
  try {
    const update = db.prepare(
      `UPDATE derivation
       SET state = ?, content = NULL, reason = ?, metadata = ?, gaps = NULL, derived_at = ?
       WHERE subject_kind = ? AND subject_id = ? AND derivation_type = ? AND source_version = ?`,
    );
    const metadata = JSON.stringify({ attempts: opts.attempts, lastError: opts.reason });
    for (const target of attempt.derivations) {
      update.run(
        opts.state,
        opts.reason,
        metadata,
        opts.now,
        target.subjectKind,
        target.subjectId,
        target.derivationType,
        attempt.sourceVersion,
      );
    }
    if (attempt.workItemId !== undefined) {
      db.prepare(`DELETE FROM work_item WHERE work_item_id = ?`).run(attempt.workItemId);
    }
    db.exec("COMMIT;");
  } catch (cause) {
    db.exec("ROLLBACK;");
    throw cause;
  }
}

export async function runWorkHandler(
  db: DatabaseSync,
  config: ResolvedSdkConfig,
  handler: (
    run: HandlerRunContext,
    item: { workItemId: string; kind: string; sourceRef: Record<string, string> },
  ) => Promise<HandlerOutcome>,
  item: { workItemId: string; kind: string; sourceRef: WorkSourceRef },
): Promise<HandlerOutcome> {
  try {
    return await handler(
      { openDb: () => db, inferenceCallbacks: config.inferenceCallbacks, clock: config.clock, config },
      {
        workItemId: item.workItemId,
        kind: item.kind,
        sourceRef: item.sourceRef as unknown as Record<string, string>,
      },
    );
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, retryable: false, reason: `handler threw: ${reason}` };
  }
}

export function derivationTarget(
  subjectKind: SubjectKind,
  subjectId: string,
  derivationType: string,
): EnqueueDerivationTarget {
  return { subjectKind, subjectId, derivationType };
}
