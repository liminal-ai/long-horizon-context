import type { DatabaseSync } from "node:sqlite";
import type { DbWriteTransaction, SubjectKind } from "../../shared-tech/index.js";
import {
  type EnqueueDerivationTarget,
  enqueue,
  supersedeQueued,
  WORK_KIND_REGISTRY,
  type WorkItemRecord,
  type WorkKind,
  type WorkSourceRef,
} from "../../shared-tech/work-queue/index.js";

const REBUILD_KIND_ORDER: Record<WorkKind, number> = {
  prompt_smoothing: 0,
  tool_result_summary: 1,
  turn_derivation: 2,
  detailed_turn_compression: 3,
  chunk_summary_detailed: 4,
  chunk_summary_brief: 5,
};

const DERIVATION_REBUILD_KINDS: Record<string, WorkKind> = {
  smoothed_prompt: "prompt_smoothing",
  tool_result_summary: "tool_result_summary",
  turn_rendering: "turn_derivation",
  pre_detailed_assembly: "turn_derivation",
  detailed_turn_compression: "detailed_turn_compression",
  chunk_summary_detailed: "chunk_summary_detailed",
  chunk_summary_brief: "chunk_summary_brief",
};

export interface CascadeClear {
  subjectKind: SubjectKind;
  subjectId: string;
  derivationType: string;
}

export interface CascadeOutcome {
  cleared: CascadeClear[];
  dropped: CascadeClear[];
  queued: Array<{ workItemId: string; kind: WorkKind }>;
  superseded: string[];
}

export interface ChainSubject {
  subjectKind: SubjectKind;
  subjectId: string;
}

function sourceRefFor(subject: ChainSubject): WorkSourceRef {
  switch (subject.subjectKind) {
    case "message":
      return { messageId: subject.subjectId };
    case "turn":
      return { turnId: subject.subjectId };
    case "chunk":
      return { chunkId: subject.subjectId };
  }
}

function chainSubjects(db: DatabaseSync, messageId: string): ChainSubject[] {
  const subjects: ChainSubject[] = [{ subjectKind: "message", subjectId: messageId }];
  const turnRow = db.prepare(`SELECT turn_id FROM message WHERE message_id = ?`).get(messageId) as unknown as
    | { turn_id: string }
    | undefined;
  const turnId = turnRow?.turn_id;
  if (turnId === undefined) return subjects;
  subjects.push({ subjectKind: "turn", subjectId: turnId });
  const chunkRow = db.prepare(`SELECT chunk_id FROM chunk_member WHERE turn_id = ?`).get(turnId) as unknown as
    | { chunk_id: string }
    | undefined;
  if (chunkRow !== undefined) {
    subjects.push({ subjectKind: "chunk", subjectId: chunkRow.chunk_id });
  }
  return subjects;
}

function pairedCounterpartSubject(db: DatabaseSync, messageId: string): ChainSubject | undefined {
  const own = db
    .prepare(
      `SELECT block_type, json_extract(content, '$.toolCallId') AS tool_call_id
       FROM message_block
       WHERE message_id = ? AND block_type IN ('tool_call', 'tool_result')
       LIMIT 1`,
    )
    .get(messageId) as unknown as { block_type: string; tool_call_id: string | null } | undefined;
  if (own === undefined || own.tool_call_id === null) return undefined;
  const counterpartType = own.block_type === "tool_call" ? "tool_result" : "tool_call";
  const row = db
    .prepare(
      `SELECT m.message_id FROM message_block b
       JOIN message m ON m.message_id = b.message_id AND m.deleted_at IS NULL
       WHERE b.block_type = ? AND json_extract(b.content, '$.toolCallId') = ?
         AND m.message_id <> ?
       ORDER BY m.source_event_order LIMIT 1`,
    )
    .get(counterpartType, own.tool_call_id, messageId) as unknown as { message_id: string } | undefined;
  if (row === undefined) return undefined;
  return { subjectKind: "message", subjectId: row.message_id };
}

interface RebuildGroup {
  subject: ChainSubject;
  kind: WorkKind;
  derivations: EnqueueDerivationTarget[];
  maxSourceVersion: number;
}

function rebuildKindFor(derivationType: string): WorkKind {
  const kind = DERIVATION_REBUILD_KINDS[derivationType as string];
  if (kind === undefined) {
    throw new Error(`no rebuild work kind mapped for derivation ${derivationType}`);
  }
  return kind;
}

interface CascadeRunOutcome extends CascadeOutcome {
  queuedWork: WorkItemRecord[];
}

function runCascade(
  transaction: DbWriteTransaction,
  dropSubjects: readonly ChainSubject[],
  clearSubjects: readonly ChainSubject[],
): CascadeRunOutcome {
  const readDerivations = transaction.db.prepare(
    `SELECT derivation_type, source_version FROM derivation
     WHERE subject_kind = ? AND subject_id = ? ORDER BY derivation_type`,
  );

  const dropped: CascadeClear[] = [];
  const supersedeTargets: Array<{ kind: WorkKind; sourceRef: WorkSourceRef }> = [];
  const dropRows = transaction.db.prepare(`DELETE FROM derivation WHERE subject_kind = ? AND subject_id = ?`);
  for (const subject of dropSubjects) {
    const rows = readDerivations.all(subject.subjectKind, subject.subjectId) as unknown as Array<{
      derivation_type: string;
    }>;
    const kinds = new Set<WorkKind>();
    for (const row of rows) {
      dropped.push({ ...subject, derivationType: row.derivation_type as string });
      kinds.add(rebuildKindFor(row.derivation_type));
    }
    for (const kind of kinds) {
      supersedeTargets.push({ kind, sourceRef: sourceRefFor(subject) });
    }
    dropRows.run(subject.subjectKind, subject.subjectId);
  }

  const cleared: CascadeClear[] = [];
  const groups = new Map<string, RebuildGroup>();
  for (const subject of clearSubjects) {
    const rows = readDerivations.all(subject.subjectKind, subject.subjectId) as unknown as Array<{
      derivation_type: string;
      source_version: number | bigint;
    }>;
    for (const row of rows) {
      const derivationType = row.derivation_type as string;
      cleared.push({ ...subject, derivationType });
      const kind = rebuildKindFor(row.derivation_type);
      const key = `${subject.subjectKind}:${subject.subjectId}:${kind}`;
      const group = groups.get(key) ?? {
        subject,
        kind,
        derivations: [],
        maxSourceVersion: 0,
      };
      group.derivations.push({ subjectKind: subject.subjectKind, subjectId: subject.subjectId, derivationType });
      group.maxSourceVersion = Math.max(group.maxSourceVersion, Number(row.source_version));
      groups.set(key, group);
    }
  }

  const superseded = supersedeQueued(transaction.db, [
    ...supersedeTargets,
    ...[...groups.values()].map((group) => ({
      kind: group.kind,
      sourceRef: sourceRefFor(group.subject),
    })),
  ]);

  const queuedWork = [...groups.values()]
    .sort((left, right) => REBUILD_KIND_ORDER[left.kind] - REBUILD_KIND_ORDER[right.kind])
    .map((group) =>
      enqueue(transaction, {
        owner: WORK_KIND_REGISTRY[group.kind].owner,
        kind: group.kind,
        sourceRef: sourceRefFor(group.subject),
        sourceVersion: group.maxSourceVersion + 1,
        derivations: group.derivations,
      }),
    );
  const queued = queuedWork.map((item) => ({ workItemId: item.workItemId, kind: item.kind }));

  return { cleared, dropped, queued, queuedWork, superseded };
}

export function cascadeFromMessage(transaction: DbWriteTransaction, messageId: string): CascadeOutcome {
  const clear = chainSubjects(transaction.db, messageId);
  const counterpart = pairedCounterpartSubject(transaction.db, messageId);
  if (counterpart !== undefined) clear.push(counterpart);
  return runCascade(transaction, [], clear);
}

export function cascadeMessageDelete(transaction: DbWriteTransaction, messageId: string): CascadeOutcome {
  const [own, ...upward] = chainSubjects(transaction.db, messageId);
  const counterpart = pairedCounterpartSubject(transaction.db, messageId);
  if (counterpart !== undefined) upward.push(counterpart);
  return runCascade(transaction, own === undefined ? [] : [own], upward);
}

export function cascadeRollback(
  transaction: DbWriteTransaction,
  drop: readonly ChainSubject[],
  clear: readonly ChainSubject[],
): WorkItemRecord[] {
  return runCascade(transaction, drop, clear).queuedWork;
}
