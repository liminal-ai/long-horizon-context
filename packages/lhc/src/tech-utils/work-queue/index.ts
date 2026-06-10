// Durable work-item mechanics: recording and ordered listing, nothing else.
// The util is domain-blind by the tech-arch capability rule — it knows the
// item vocabulary (owner, kind, sourceRef) but nothing about what a turn or
// a summary is; which kinds queue for which sources is the owning domains'
// business. Writes run on the caller's handle inside the batch transaction,
// so items commit (or roll back) with the batch. No public SDK surface:
// read-back reaches here only through the owning domains' listQueuedWork.
import type { DatabaseSync } from "node:sqlite";

export type WorkOwner = "messages" | "turns";
export type WorkKind = "prompt_smoothing" | "tool_result_summary" | "turn_derivation";
export type WorkSourceRef = { messageId: string } | { turnId: string };

export interface WorkItemRecord {
  workItemId: string;
  owner: WorkOwner;
  kind: WorkKind;
  sourceRef: WorkSourceRef;
  status: "queued"; // the only status this epic writes
  queuedAt: string;
}

export interface WorkItemInput {
  owner: WorkOwner;
  kind: WorkKind;
  sourceRef: WorkSourceRef;
}

function sourceIdOf(sourceRef: WorkSourceRef): string {
  return "messageId" in sourceRef ? sourceRef.messageId : sourceRef.turnId;
}

// Deterministic id: re-queueing the same kind for the same source is the
// same id — natural idempotency for Epic 02's repair path (design decision 7).
export function recordItem(
  db: DatabaseSync,
  input: WorkItemInput,
  queuedAt: string,
): WorkItemRecord {
  const workItemId = `w-${sourceIdOf(input.sourceRef)}-${input.kind}`;
  db.prepare(
    `INSERT INTO work_item (work_item_id, owner, kind, source_ref, status, queued_at)
     VALUES (?, ?, ?, ?, 'queued', ?)`,
  ).run(workItemId, input.owner, input.kind, JSON.stringify(input.sourceRef), queuedAt);
  return {
    workItemId,
    owner: input.owner,
    kind: input.kind,
    sourceRef: input.sourceRef,
    status: "queued",
    queuedAt,
  };
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
