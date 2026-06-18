// The mutation cascade (DD-8, Flows 5/6): walk the derivation chain upward
// from the mutated subject — the message's own derivations, its turn's rendering
// and projection, the containing chunk's two summaries — clearing each to
// `pending` at the next source version and enqueueing replacement work, all
// inside the caller's mutation transaction. The clear-set is derived from
// the record's structure (the message → turn → chunk walk over the rows that
// actually exist), never from a hardcoded derivation list: a future derivation on any
// subject in the chain cascades without this module changing. Still-queued
// old-version items are supersede-deleted (tech design issue 1) and reported
// on the MutationResult; claimed items are deliberately left to the
// source-version check (DD-3) — their stale completions discard. The two
// close paths share one core walk parameterized drop-vs-clear: edit clears
// the whole chain, delete *drops* the deleted subject's own derivations (state
// rows removed — a deleted source has nothing to rebuild) and clears
// everything upward for minus-one composition. Turn delete enters at the
// turn level, dropping the turn's and all live members' derivations; a chunk left
// with no live members drops its summary derivations too — dropped, never failed,
// and no rebuild queued (AC-6.6).
import type { DatabaseSync } from "node:sqlite";
import type { OperationContext } from "../../shared-tech/index.js";
import type { SubjectKind } from "../../shared-tech/index.js";
import {
  enqueue,
  supersedeQueued,
  WORK_KIND_REGISTRY,
  type EnqueueDerivationTarget,
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

// The shared core (DD-8's one cascade, parameterized): drop subjects lose
// their derivation rows outright; clear subjects go pending at the next source
// version with replacement work enqueued. Supersede-deletes land before the
// replacement enqueues so a tidied id can never collide, and queued items
// against dropped subjects are tidied with no replacement — dead work for a
// source that no longer reads.
function runCascade(
  ctx: OperationContext,
  dropSubjects: readonly ChainSubject[],
  clearSubjects: readonly ChainSubject[],
): CascadeOutcome {
  const readDerivations = ctx.db.prepare(
    `SELECT derivation_type, source_version FROM derivation
     WHERE subject_kind = ? AND subject_id = ? ORDER BY derivation_type`,
  );

  const dropped: CascadeClear[] = [];
  const supersedeTargets: Array<{ kind: WorkKind; sourceRef: WorkSourceRef }> = [];
  const dropRows = ctx.db.prepare(
    `DELETE FROM derivation WHERE subject_kind = ? AND subject_id = ?`,
  );
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
      derivations: group.derivations,
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

// Message delete's close path (Flow 6): the deleted message's own derivations
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

// Turn delete's close path (Flow 6): the turn's derivations and every live
// member's derivations drop — the drop-set walk goes down as well as up — and the
// containing chunk clears and re-queues from its remaining live members.
// A chunk left empty drops its summary derivations instead: nothing remains to
// summarize, so the derivations are removed, never failed, and no rebuild queues
// (AC-6.6). Runs after the delete stamps land, so the live-member count
// already excludes the deleted turn. Membership rows are untouched —
// shrink-only: reads filter deleted turns; boundaries never re-cut.
//
// REVERIFY-02-001: the call/result pair is a source dependency (epic-fix-001),
// and this third cascade caller honored it nowhere — a cross-turn pair is
// reachable when a late result lands in a later turn. Deleting a member whose
// counterpart lives in another (still-live) turn is a source change for that
// counterpart's tool-activity summary, so each deleted member's live
// counterpart joins the clear set and re-derives from the now-deleted record
// (its outcome reverts to `unknown`). Same-turn counterparts are skipped: they
// are themselves deleted members (the live-read filter already excludes them,
// and we drop them explicitly), so they belong to the drop set, not the clear
// set. AC-6.2's "nothing else changes" still bounds the cascade across other
// turns/chunks — only the counterpart message, inside the dependency graph, is
// pulled in; its own turn and chunk are deliberately not walked.
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
  const memberSet = new Set(memberMessageIds);
  const counterparts = new Map<string, ChainSubject>();
  for (const messageId of memberMessageIds) {
    const counterpart = pairedCounterpartSubject(ctx.db, messageId);
    if (counterpart !== undefined && !memberSet.has(counterpart.subjectId)) {
      counterparts.set(counterpart.subjectId, counterpart);
    }
  }
  const counterpartClears = [...counterparts.values()];
  const chunkRow = ctx.db
    .prepare(`SELECT chunk_id FROM chunk_member WHERE turn_id = ?`)
    .get(turnId) as unknown as { chunk_id: string } | undefined;
  if (chunkRow === undefined) return runCascade(ctx, drop, counterpartClears);
  const chunk: ChainSubject = { subjectKind: "chunk", subjectId: chunkRow.chunk_id };
  const remaining = ctx.db
    .prepare(
      `SELECT COUNT(*) AS n FROM chunk_member cm
       JOIN turns t ON t.turn_id = cm.turn_id AND t.deleted_at IS NULL
       WHERE cm.chunk_id = ?`,
    )
    .get(chunkRow.chunk_id) as unknown as { n: number | bigint };
  return Number(remaining.n) > 0
    ? runCascade(ctx, drop, [chunk, ...counterpartClears])
    : runCascade(ctx, [...drop, chunk], counterpartClears);
}
