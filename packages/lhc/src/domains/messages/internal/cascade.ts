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
// source-version check (DD-3) — their stale completions discard. Two close
// paths share this walk by design: edit re-queues the subject's own forms,
// delete (Story 6) drops them and starts the clear at the turn level.
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

// The structural walk: the edited message's turn from its membership stamp,
// the turn's chunk from its placement row. Either link may be absent — a gap
// message has no turn, an unplaced turn no chunk — and the chain simply
// stops there; reach is structural, not configured.
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

interface RebuildGroup {
  subject: ChainSubject;
  kind: WorkKind;
  forms: EnqueueFormTarget[];
  maxSourceVersion: number;
}

// Clear-and-requeue for the full chain above (and including) the edited
// message. Runs inside the mutation's ambient transaction: the enqueue's
// pending upsert is the clear (state pending, content/reason/gaps/metadata
// reset, source version bumped past every version seen in the group), the
// work row and the commit poke ride the same transaction, and the supersede
// delete lands before the replacements so a tidied id can never collide.
export function cascadeFromMessage(
  ctx: OperationContext,
  messageId: string,
): CascadeOutcome {
  const subjects = chainSubjects(ctx.db, messageId);
  const cleared: CascadeClear[] = [];
  const groups = new Map<string, RebuildGroup>();
  const readForms = ctx.db.prepare(
    `SELECT form, source_version FROM derived_form
     WHERE subject_kind = ? AND subject_id = ? ORDER BY form`,
  );
  for (const subject of subjects) {
    const rows = readForms.all(subject.subjectKind, subject.subjectId) as unknown as Array<{
      form: string;
      source_version: number | bigint;
    }>;
    for (const row of rows) {
      const form = row.form as FormKind;
      cleared.push({ ...subject, form });
      const kind = FORM_REBUILD_KINDS[form];
      if (kind === undefined) {
        // Every form names its queue site above; a miss is a wiring bug.
        throw new Error(`no rebuild work kind mapped for derived form ${row.form}`);
      }
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

  const superseded = supersedeQueued(
    ctx.db,
    [...groups.values()].map((group) => ({
      kind: group.kind,
      sourceRef: sourceRefFor(group.subject),
    })),
  );

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

  return { cleared, queued, superseded };
}
