// Durable work-item mechanics: recording, ordered listing, and the enqueue
// wrapper that makes "queueing is what schedules processing" structural
// (DD-5). The util is domain-blind by the tech-arch capability rule — it
// knows the item vocabulary (owner, kind, sourceRef) but nothing about what
// a turn or a summary is; which kinds queue for which sources, and which
// derived forms a kind produces, is the owning domains' business (callers
// pass the form targets in). Writes run on the caller's handle inside the
// ambient transaction, so items commit (or roll back) with the batch. No
// public SDK surface: read-back reaches here only through the owning
// domains' listQueuedWork.
import type { DatabaseSync } from "node:sqlite";
import { fireSchedulerPoke, type OperationContext } from "../../shared/context.js";
import type { FormKind, SubjectKind } from "../../shared/derivation.js";

export type WorkOwner = "messages" | "turns";
export type WorkKind =
  | "prompt_smoothing"
  | "tool_call_summary"
  | "tool_result_summary"
  | "turn_derivation"
  | "chunk_summary_detailed"
  | "chunk_summary_brief";
export type WorkSourceRef = { messageId: string } | { turnId: string } | { chunkId: string };

// The work-kind registry: owner and sourceRef semantics per the epic's Work
// Item contract. Mechanical metadata only — what a kind *means* stays with
// the owning domain's handler (registered at SDK construction, DD-6).
export const WORK_KIND_REGISTRY: Readonly<
  Record<WorkKind, { owner: WorkOwner; sourceRefKey: "messageId" | "turnId" | "chunkId" }>
> = {
  prompt_smoothing: { owner: "messages", sourceRefKey: "messageId" },
  tool_call_summary: { owner: "messages", sourceRefKey: "messageId" },
  tool_result_summary: { owner: "messages", sourceRefKey: "messageId" },
  turn_derivation: { owner: "turns", sourceRefKey: "turnId" },
  chunk_summary_detailed: { owner: "turns", sourceRefKey: "chunkId" },
  chunk_summary_brief: { owner: "turns", sourceRefKey: "chunkId" },
};

export interface WorkItemRecord {
  workItemId: string;
  owner: WorkOwner;
  kind: WorkKind;
  sourceRef: WorkSourceRef;
  status: "queued"; // the only status written before a drain claims (Epic 02 Story 1)
  queuedAt: string;
}

export interface WorkItemInput {
  owner: WorkOwner;
  kind: WorkKind;
  sourceRef: WorkSourceRef;
  sourceVersion?: number; // defaults to 1 — first version of a fresh source
}

function sourceIdOf(sourceRef: WorkSourceRef): string {
  if ("messageId" in sourceRef) return sourceRef.messageId;
  if ("turnId" in sourceRef) return sourceRef.turnId;
  return sourceRef.chunkId;
}

// Deterministic id scoped to the source version (DD-1/DD-3): re-queueing the
// same kind for the same source *at the same version* is the same id —
// natural idempotency for the repair path — while a post-mutation
// replacement (next version) never collides with an in-flight pre-mutation
// item.
export function recordItem(
  db: DatabaseSync,
  input: WorkItemInput,
  queuedAt: string,
): WorkItemRecord {
  const sourceVersion = input.sourceVersion ?? 1;
  const workItemId = `w-${sourceIdOf(input.sourceRef)}-${input.kind}-v${sourceVersion}`;
  db.prepare(
    `INSERT INTO work_item (work_item_id, owner, kind, source_ref, status, queued_at, payload)
     VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
  ).run(
    workItemId,
    input.owner,
    input.kind,
    JSON.stringify(input.sourceRef),
    queuedAt,
    JSON.stringify({ sourceVersion }),
  );
  return {
    workItemId,
    owner: input.owner,
    kind: input.kind,
    sourceRef: input.sourceRef,
    status: "queued",
    queuedAt,
  };
}

// The derived forms an enqueue is scheduling work toward; the owning domain
// names them (the util stays meaning-blind).
export interface EnqueueFormTarget {
  subjectKind: SubjectKind;
  subjectId: string;
  form: FormKind;
}

export interface EnqueueInput extends WorkItemInput {
  forms: readonly EnqueueFormTarget[];
}

// The one way work is scheduled (DD-5): the work row, the form's `pending`
// state row, and the scheduler poke all ride the ambient transaction — they
// commit together or vanish together. Enqueue is the *only* place a
// derived_form row is created (completion is UPDATE-only); re-enqueueing
// resets an existing row to pending at the enqueued source version.
export function enqueue(ctx: OperationContext, input: EnqueueInput): WorkItemRecord {
  const item = recordItem(ctx.db, input, ctx.clock().toISOString());
  const sourceVersion = input.sourceVersion ?? 1;
  const upsert = ctx.db.prepare(
    `INSERT INTO derived_form (subject_kind, subject_id, form, state, source_version)
     VALUES (?, ?, ?, 'pending', ?)
     ON CONFLICT (subject_kind, subject_id, form) DO UPDATE SET
       state = 'pending', content = NULL, reason = NULL, metadata = NULL,
       gaps = NULL, derived_at = NULL, source_version = excluded.source_version`,
  );
  for (const target of input.forms) {
    upsert.run(target.subjectKind, target.subjectId, target.form, sourceVersion);
  }
  ctx.onCommit(() => fireSchedulerPoke(ctx.threadId));
  return item;
}

interface RawWorkItemRow {
  work_item_id: string;
  owner: string;
  kind: string;
  source_ref: string;
  queued_at: string;
}

// Listing in queue order (insertion order within the walk); each owning
// domain lists only its own items.
export function listItems(db: DatabaseSync, owner: WorkOwner): WorkItemRecord[] {
  const rows = db
    .prepare(
      `SELECT work_item_id, owner, kind, source_ref, queued_at
       FROM work_item WHERE owner = ? ORDER BY rowid`,
    )
    .all(owner) as unknown as RawWorkItemRow[];
  return rows.map((row) => ({
    workItemId: row.work_item_id,
    owner: row.owner as WorkOwner,
    kind: row.kind as WorkKind,
    sourceRef: JSON.parse(row.source_ref) as WorkSourceRef,
    status: "queued",
    queuedAt: row.queued_at,
  }));
}
