// The mutation cascade (DD-8, Flows 5/6): walk the derivation chain upward
// from the mutated subject — the message's own forms, its turn's rendering
// and projection, the containing chunk's two summaries — clearing each to
// `pending` at the next source version and enqueueing replacement work, all
// inside the caller's mutation transaction. The clear-set is derived from
// the record's structure (the message → turn → chunk walk over the rows that
// actually exist), never from a hardcoded form list: a future form on any
// subject in the chain cascades without this module changing. Still-queued
// old-version items are supersede-deleted (tech design issue 1) and reported
// on the MutationResult; claimed items are deliberately left to the
// source-version check (DD-3) — their stale completions discard. The two
// close paths share one core walk parameterized drop-vs-clear: edit clears
// the whole chain, delete *drops* the deleted subject's own forms (state
// rows removed — a deleted source has nothing to rebuild) and clears
// everything upward for minus-one composition. Turn delete enters at the
// turn level, dropping the turn's and all live members' forms; a chunk left
// with no live members drops its summary forms too — dropped, never failed,
// and no rebuild queued (AC-6.6).
import type { DatabaseSync } from "node:sqlite";
import type { OperationContext } from "../../../shared/context.js";
import type { FormKind, SubjectKind } from "../../../shared/derivation.js";
import {
  enqueue,
  supersedeQueued,
  WORK_KIND_REGISTRY,
  type EnqueueFormTarget,
  type WorkKind,
  type WorkSourceRef,
} from "../../../tech-utils/work-queue/index.js";

// Each form's rebuild queue-site — the owning domains' enqueue mappings,
// gathered here because the cascade is the one place that re-queues across
// the whole chain (module responsibility matrix: replacement enqueues for
// all three mutations live with the cascade). Both turn forms ride the one
// turn_derivation item; every other form rides its same-named kind.
const FORM_REBUILD_KINDS: Record<FormKind, WorkKind> = {
  smoothed_prompt: "prompt_smoothing",
  tool_call_summary: "tool_call_summary",
  tool_result_summary: "tool_result_summary",
  turn_rendering: "turn_derivation",
  lower_band_projection: "turn_derivation",
  chunk_summary_detailed: "chunk_summary_detailed",
  chunk_summary_brief: "chunk_summary_brief",
};

export interface CascadeClear {
  subjectKind: SubjectKind;
  subjectId: string;
  form: FormKind;
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
  const turnRow = db
    .prepare(`SELECT turn_id FROM message WHERE message_id = ?`)
    .get(messageId) as unknown as { turn_id: string | null } | undefined;
  const turnId = turnRow?.turn_id ?? null;
  if (turnId === null) return subjects;
  subjects.push({ subjectKind: "turn", subjectId: turnId });
  const chunkRow = db
    .prepare(`SELECT chunk_id FROM chunk_member WHERE turn_id = ?`)
    .get(turnId) as unknown as { chunk_id: string } | undefined;
  if (chunkRow !== undefined) {
    subjects.push({ subjectKind: "chunk", subjectId: chunkRow.chunk_id });
  }
  return subjects;
}

// The call/result pair as a source dependency (AC-2.8's pair-as-source model,
// impl-lead ruling epic-fix-001): a tool summary derives from its message AND
// the paired counterpart, so mutating one half is a source change for the
// counterpart's summary. Find the live counterpart of a mutated tool message —
// the opposite block type sharing its toolCallId — as a clear subject, so the
// cascade clears and re-queues that summary alongside the rest of the chain.
// Returns nothing when the mutated message carries no tool block, or the
// counterpart is deleted or absent. The rebuilt summary derives from the live
// record only: with the deleted-read filter (epic-fix-001), a gone result
// reverts the call summary's outcome to `unknown`. AC-6.2's "nothing else
// changes" still bounds the cascade across other turns and chunks — only the
// counterpart message itself, inside the dependency graph, is in scope, so its
// own turn and chunk are deliberately not walked.
function pairedCounterpartSubject(
  db: DatabaseSync,
  messageId: string,
): ChainSubject | undefined {
  const own = db
    .prepare(
      `SELECT block_type, json_extract(content, '$.toolCallId') AS tool_call_id
       FROM message_block
       WHERE message_id = ? AND block_type IN ('tool_call', 'tool_result')
       LIMIT 1`,
    )
    .get(messageId) as unknown as
    | { block_type: string; tool_call_id: string | null }
    | undefined;
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
    .get(counterpartType, own.tool_call_id, messageId) as unknown as
    | { message_id: string }
    | undefined;
  if (row === undefined) return undefined;
  return { subjectKind: "message", subjectId: row.message_id };
}

interface RebuildGroup {
  subject: ChainSubject;
  kind: WorkKind;
  forms: EnqueueFormTarget[];
  maxSourceVersion: number;
}

function rebuildKindFor(form: string): WorkKind {
  const kind = FORM_REBUILD_KINDS[form as FormKind];
  if (kind === undefined) {
    // Every form names its queue site above; a miss is a wiring bug.
    throw new Error(`no rebuild work kind mapped for derived form ${form}`);
  }
  return kind;
}

// The shared core (DD-8's one cascade, parameterized): drop subjects lose
// their form rows outright; clear subjects go pending at the next source
// version with replacement work enqueued. Supersede-deletes land before the
// replacement enqueues so a tidied id can never collide, and queued items
// against dropped subjects are tidied with no replacement — dead work for a
// source that no longer reads.
function runCascade(
  ctx: OperationContext,
  dropSubjects: readonly ChainSubject[],
  clearSubjects: readonly ChainSubject[],
): CascadeOutcome {
  const readForms = ctx.db.prepare(
    `SELECT form, source_version FROM derived_form
     WHERE subject_kind = ? AND subject_id = ? ORDER BY form`,
  );

  const dropped: CascadeClear[] = [];
  const supersedeTargets: Array<{ kind: WorkKind; sourceRef: WorkSourceRef }> = [];
  const dropRows = ctx.db.prepare(
    `DELETE FROM derived_form WHERE subject_kind = ? AND subject_id = ?`,
  );
  for (const subject of dropSubjects) {
    const rows = readForms.all(subject.subjectKind, subject.subjectId) as unknown as Array<{
      form: string;
    }>;
    const kinds = new Set<WorkKind>();
    for (const row of rows) {
      dropped.push({ ...subject, form: row.form as FormKind });
      kinds.add(rebuildKindFor(row.form));
    }
    for (const kind of kinds) {
      supersedeTargets.push({ kind, sourceRef: sourceRefFor(subject) });
    }
    dropRows.run(subject.subjectKind, subject.subjectId);
  }

  const cleared: CascadeClear[] = [];
  const groups = new Map<string, RebuildGroup>();
  for (const subject of clearSubjects) {
    const rows = readForms.all(subject.subjectKind, subject.subjectId) as unknown as Array<{
      form: string;
      source_version: number | bigint;
    }>;
    for (const row of rows) {
      const form = row.form as FormKind;
      cleared.push({ ...subject, form });
      const kind = rebuildKindFor(row.form);
      const key = `${subject.subjectKind}:${subject.subjectId}:${kind}`;
      const group = groups.get(key) ?? {
        subject,
        kind,
        forms: [],
        maxSourceVersion: 0,
      };
      group.forms.push({ subjectKind: subject.subjectKind, subjectId: subject.subjectId, form });
      group.maxSourceVersion = Math.max(group.maxSourceVersion, Number(row.source_version));
      groups.set(key, group);
    }
  }

  const superseded = supersedeQueued(ctx.db, [
    ...supersedeTargets,
    ...[...groups.values()].map((group) => ({
      kind: group.kind,
      sourceRef: sourceRefFor(group.subject),
    })),
  ]);

  const queued = [...groups.values()].map((group) => {
    const item = enqueue(ctx, {
      owner: WORK_KIND_REGISTRY[group.kind].owner,
      kind: group.kind,
      sourceRef: sourceRefFor(group.subject),
      sourceVersion: group.maxSourceVersion + 1,
      forms: group.forms,
    });
    return { workItemId: item.workItemId, kind: group.kind };
  });

  return { cleared, dropped, queued, superseded };
}

// Edit's close path: clear-and-requeue for the full chain above (and
// including) the edited message, inside the mutation's ambient transaction.
// A call/result pair counterpart (epic-fix-001) joins the clear set: editing
// one half is a source change for the other's summary.
export function cascadeFromMessage(
  ctx: OperationContext,
  messageId: string,
): CascadeOutcome {
  const clear = chainSubjects(ctx.db, messageId);
  const counterpart = pairedCounterpartSubject(ctx.db, messageId);
  if (counterpart !== undefined) clear.push(counterpart);
  return runCascade(ctx, [], clear);
}

// Message delete's close path (Flow 6): the deleted message's own forms
// drop; its turn and chunk clear and re-queue for minus-one composition.
// The message-delete validation refuses turn-initiating prompts, so the turn
// always keeps members and never empties through this path.
export function cascadeMessageDelete(
  ctx: OperationContext,
  messageId: string,
): CascadeOutcome {
  const [own, ...upward] = chainSubjects(ctx.db, messageId);
  // The deleted half's live pair counterpart re-derives from the live record
  // (epic-fix-001): its summary clears and re-queues, reverting outcome to
  // `unknown` for a call whose result is now gone.
  const counterpart = pairedCounterpartSubject(ctx.db, messageId);
  if (counterpart !== undefined) upward.push(counterpart);
  return runCascade(ctx, own === undefined ? [] : [own], upward);
}

// Turn delete's close path (Flow 6): the turn's forms and every live
// member's forms drop — the drop-set walk goes down as well as up — and the
// containing chunk clears and re-queues from its remaining live members.
// A chunk left empty drops its summary forms instead: nothing remains to
// summarize, so the forms are removed, never failed, and no rebuild queues
// (AC-6.6). Runs after the delete stamps land, so the live-member count
// already excludes the deleted turn. Membership rows are untouched —
// shrink-only: reads filter deleted turns; boundaries never re-cut.
export function cascadeTurnDelete(
  ctx: OperationContext,
  turnId: string,
  memberMessageIds: readonly string[],
): CascadeOutcome {
  const drop: ChainSubject[] = [
    ...memberMessageIds.map((messageId): ChainSubject => ({
      subjectKind: "message",
      subjectId: messageId,
    })),
    { subjectKind: "turn", subjectId: turnId },
  ];
  const chunkRow = ctx.db
    .prepare(`SELECT chunk_id FROM chunk_member WHERE turn_id = ?`)
    .get(turnId) as unknown as { chunk_id: string } | undefined;
  if (chunkRow === undefined) return runCascade(ctx, drop, []);
  const chunk: ChainSubject = { subjectKind: "chunk", subjectId: chunkRow.chunk_id };
  const remaining = ctx.db
    .prepare(
      `SELECT COUNT(*) AS n FROM chunk_member cm
       JOIN turns t ON t.turn_id = cm.turn_id AND t.deleted_at IS NULL
       WHERE cm.chunk_id = ?`,
    )
    .get(chunkRow.chunk_id) as unknown as { n: number | bigint };
  return Number(remaining.n) > 0
    ? runCascade(ctx, drop, [chunk])
    : runCascade(ctx, [...drop, chunk], []);
}
