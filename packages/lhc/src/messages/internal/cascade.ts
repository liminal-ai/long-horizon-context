// The mutation cascade walks the derivation chain upward from the mutated
// subject: the message's own derivations, its turn derivations, and the
// containing chunk summaries. Each cleared row moves to `pending` at the next
// source version and replacement work is enqueued inside the caller's mutation
// transaction. The clear-set is derived from record structure, never from a
// hardcoded derivation list, so future derivations on subjects in the chain
// cascade without this module changing. Still-queued old-version items are
// supersede-deleted and reported on MutationResult; claimed items are left to
// the source-version check, where stale completions discard. Edit clears the
// whole chain. Delete drops the deleted subject's own derivations and clears
// everything upward for minus-one composition. Turn delete enters at the turn
// level, dropping the turn's and all live members' derivations; a chunk left
// with no live members drops its summary derivations too, with no rebuild
// queued.
import type { DatabaseSync } from "node:sqlite";
import type { DbWriteTransaction, SubjectKind } from "../../shared-tech/index.js";
import {
  type EnqueueDerivationTarget,
  enqueue,
  supersedeQueued,
  WORK_KIND_REGISTRY,
  type WorkKind,
  type WorkSourceRef,
} from "../../shared-tech/work-queue/index.js";

// Each derivation's rebuild queue-site — the owning domains' enqueue mappings,
// gathered here because the cascade is the one place that re-queues across
// the whole chain (module responsibility matrix: replacement enqueues for
// all three mutations live with the cascade). Both turn derivations ride the one
// turn_derivation item; every other derivation rides its same-named kind.
const DERIVATION_REBUILD_KINDS: Record<string, WorkKind> = {
  smoothed_prompt: "prompt_smoothing",
  tool_result_summary: "tool_result_summary",
  turn_rendering: "turn_derivation",
  smooth_turn_compression: "turn_derivation",
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

interface ChainSubject {
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

// The structural walk: the mutated message's turn from its membership stamp,
// the turn's chunk from its placement row. Either link may be absent — a gap
// message has no turn, an unplaced turn no chunk — and the chain simply
// stops there; reach is structural, not configured. Deliberately unfiltered:
// the walk runs after a delete stamps its subject, and the chain above a
// just-deleted record is exactly what must still cascade.
function chainSubjects(db: DatabaseSync, messageId: string): ChainSubject[] {
  const subjects: ChainSubject[] = [{ subjectKind: "message", subjectId: messageId }];
  const turnRow = db.prepare(`SELECT turn_id FROM message WHERE message_id = ?`).get(messageId) as unknown as
    | { turn_id: string | null }
    | undefined;
  const turnId = turnRow?.turn_id ?? null;
  if (turnId === null) return subjects;
  subjects.push({ subjectKind: "turn", subjectId: turnId });
  const chunkRow = db.prepare(`SELECT chunk_id FROM chunk_member WHERE turn_id = ?`).get(turnId) as unknown as
    | { chunk_id: string }
    | undefined;
  if (chunkRow !== undefined) {
    subjects.push({ subjectKind: "chunk", subjectId: chunkRow.chunk_id });
  }
  return subjects;
}

// A tool summary derives from its message and paired counterpart, so mutating
// one half is a source change for the counterpart's summary. Find the live
// counterpart of a mutated tool message — the opposite block type sharing its
// toolCallId — as a clear subject, so the cascade clears and re-queues that
// summary alongside the rest of the chain. Returns nothing when the mutated
// message carries no tool block, or the counterpart is deleted or absent. The
// rebuilt summary derives from the live record only: with the deleted-read
// filter, a gone result reverts the call summary's outcome to `unknown`. Only
// the counterpart message itself is in scope; its own turn and chunk are not
// walked.
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
    // Every derivation names its queue site above; a miss is a wiring bug.
    throw new Error(`no rebuild work kind mapped for derivation ${derivationType}`);
  }
  return kind;
}

// Shared cascade core: drop subjects lose their derivation rows outright; clear
// subjects go pending at the next source version with replacement work
// enqueued. Supersede-deletes land before replacement enqueues so a tidied id
// can never collide, and queued items against dropped subjects are tidied with
// no replacement: dead work for a source that no longer reads.
function runCascade(
  transaction: DbWriteTransaction,
  dropSubjects: readonly ChainSubject[],
  clearSubjects: readonly ChainSubject[],
): CascadeOutcome {
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

  const queued = [...groups.values()].map((group) => {
    const item = enqueue(transaction, {
      owner: WORK_KIND_REGISTRY[group.kind].owner,
      kind: group.kind,
      sourceRef: sourceRefFor(group.subject),
      sourceVersion: group.maxSourceVersion + 1,
      derivations: group.derivations,
    });
    return { workItemId: item.workItemId, kind: group.kind };
  });

  return { cleared, dropped, queued, superseded };
}

// Edit's close path: clear-and-requeue for the full chain above (and
// including) the edited message, inside the mutation's ambient transaction.
// A call/result pair counterpart joins the clear set: editing one half is a
// source change for the other's summary.
export function cascadeFromMessage(transaction: DbWriteTransaction, messageId: string): CascadeOutcome {
  const clear = chainSubjects(transaction.db, messageId);
  const counterpart = pairedCounterpartSubject(transaction.db, messageId);
  if (counterpart !== undefined) clear.push(counterpart);
  return runCascade(transaction, [], clear);
}

// Message delete drops the deleted message's own derivations; its turn and
// chunk clear and re-queue for minus-one composition. Message-delete validation
// refuses turn-initiating prompts, so the turn always keeps members and never
// empties through this path.
export function cascadeMessageDelete(transaction: DbWriteTransaction, messageId: string): CascadeOutcome {
  const [own, ...upward] = chainSubjects(transaction.db, messageId);
  // The deleted half's live pair counterpart re-derives from the live record
  // only: its summary clears and re-queues, reverting outcome to `unknown` for
  // a call whose result is now gone.
  const counterpart = pairedCounterpartSubject(transaction.db, messageId);
  if (counterpart !== undefined) upward.push(counterpart);
  return runCascade(transaction, own === undefined ? [] : [own], upward);
}
