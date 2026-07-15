// Durable work-item mechanics: recording, ordered listing, and the enqueue
// wrapper that makes scheduling structural. The util is domain-blind: it
// knows item mechanics (owner, kind, sourceRef), while each owning domain
// supplies the derivation targets and handler meaning. Writes run on the
// caller's handle inside the ambient transaction, so items commit or roll back
// with the change that caused them.
import type { DatabaseSync } from "node:sqlite";
import type { CompletionTx, HandlerDerivationWrite, SubjectKind, WorkHandler } from "../derivation.js";
import type { DurableWorkOperation } from "../durable-work/index.js";
import { assertExactDerivationWrites, DerivationCompletionError, operationIntent } from "../durable-work/index.js";
import { createPostCommitHookSet, type DbWriteTransaction } from "../persist.js";

export type WorkOwner = "messages" | "turns";
export type WorkKind =
  | "prompt_smoothing"
  | "tool_result_summary"
  | "turn_derivation"
  | "detailed_turn_compression"
  | "chunk_summary_detailed"
  | "chunk_summary_brief";
export type WorkSourceRef = { messageId: string } | { turnId: string } | { chunkId: string };
export type WorkHandlerMap = Partial<Record<WorkKind, WorkHandler>>;

// Mechanical metadata only; what a kind means stays with the owning domain's
// handler.
export const WORK_KIND_REGISTRY: Readonly<
  Record<WorkKind, { owner: WorkOwner; sourceRefKey: "messageId" | "turnId" | "chunkId" }>
> = {
  prompt_smoothing: { owner: "messages", sourceRefKey: "messageId" },
  tool_result_summary: { owner: "messages", sourceRefKey: "messageId" },
  turn_derivation: { owner: "turns", sourceRefKey: "turnId" },
  detailed_turn_compression: { owner: "turns", sourceRefKey: "turnId" },
  chunk_summary_detailed: { owner: "turns", sourceRefKey: "chunkId" },
  chunk_summary_brief: { owner: "turns", sourceRefKey: "chunkId" },
};

// SDK construction wiring for durable work dispatch. Domains own their
// handler tables; shared-tech owns merging those tables into the queue's
// dispatch map and refusing duplicate kind claims.
export function mapWorkQHandlers(handlerGroups: ReadonlyArray<Readonly<WorkHandlerMap>>): WorkHandlerMap {
  const map: WorkHandlerMap = {};
  for (const handlers of handlerGroups) {
    for (const [kind, handler] of Object.entries(handlers)) {
      if (map[kind as WorkKind] !== undefined) {
        throw new TypeError(`work kind "${kind}" registered by more than one domain`);
      }
      map[kind as WorkKind] = handler;
    }
  }
  return map;
}

export interface WorkItemRecord {
  workItemId: string;
  owner: WorkOwner;
  kind: WorkKind;
  sourceRef: WorkSourceRef;
  status: "queued"; // the only status written before a drain claims it
  queuedAt: string;
}

// The derivations an enqueue is scheduling work toward; the owning domain
// names them (the util stays meaning-blind). Stored in the row's payload so
// the drain's failure paths can land the derivation's failed/blocked state
// without asking any domain what a kind means.
export interface EnqueueDerivationTarget {
  subjectKind: SubjectKind;
  subjectId: string;
  derivationType: string;
}

export interface WorkItemInput {
  owner: WorkOwner;
  kind: WorkKind;
  sourceRef: WorkSourceRef;
  operation?: DurableWorkOperation;
  sourceVersion?: number; // defaults to 1 — first version of a fresh source
  derivations?: readonly EnqueueDerivationTarget[]; // carried in payload for the drain's terminal paths
}

function sourceIdOf(sourceRef: WorkSourceRef): string {
  if ("messageId" in sourceRef) return sourceRef.messageId;
  if ("turnId" in sourceRef) return sourceRef.turnId;
  return sourceRef.chunkId;
}

function targetKey(target: Pick<EnqueueDerivationTarget, "subjectKind" | "subjectId" | "derivationType">): string {
  return `${target.subjectKind}/${target.subjectId}/${target.derivationType}`;
}

// Deterministic id scoped to source version: re-queueing the same kind for
// the same source at the same version is the same id, while a post-mutation
// replacement at the next version never collides with older in-flight work.
export function recordItem(db: DatabaseSync, input: WorkItemInput, queuedAt: string): WorkItemRecord {
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
    JSON.stringify({
      sourceVersion,
      operation: input.operation ?? operationIntent(input.kind, input.sourceRef),
      derivations: input.derivations ?? [],
    }),
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

export interface EnqueueInput extends WorkItemInput {
  derivations: readonly EnqueueDerivationTarget[];
}

export type ImmediateDerivationBoundary =
  | (EnqueueDerivationTarget & { exists: false })
  | (EnqueueDerivationTarget & { exists: true; state: string; sourceVersion: number });

export interface ImmediateClaimInput extends EnqueueInput {
  expectedDerivations: readonly ImmediateDerivationBoundary[];
}

export type ImmediateClaimOutcome =
  | { outcome: "claimed"; item: ClaimedWorkItem }
  | { outcome: "expired"; item: ClaimedWorkItem }
  | { outcome: "queued"; workItemId: string }
  | { outcome: "in_flight"; workItemId: string };

// The one way work is scheduled: the work row, the derivation's `pending`
// state row, and the scheduler poke all ride the ambient transaction. They
// commit together or vanish together. Enqueue is the *only* place a
// derivation row is created (completion is UPDATE-only); re-enqueueing
// resets an existing row to pending at the enqueued source version.
export function enqueue(transaction: DbWriteTransaction, input: EnqueueInput): WorkItemRecord {
  const item = recordItem(transaction.db, input, transaction.clock().toISOString());
  const sourceVersion = input.sourceVersion ?? 1;
  const upsert = transaction.db.prepare(
    `INSERT INTO derivation (subject_kind, subject_id, derivation_type, state, source_version)
     VALUES (?, ?, ?, 'pending', ?)
     ON CONFLICT (subject_kind, subject_id, derivation_type) DO UPDATE SET
       state = 'pending', content = NULL, reason = NULL, metadata = NULL,
       gaps = NULL, derived_at = NULL, source_version = excluded.source_version`,
  );
  for (const target of input.derivations) {
    upsert.run(target.subjectKind, target.subjectId, target.derivationType, sourceVersion);
  }
  transaction.postCommitHook.add(() => transaction.poke(transaction.threadId));
  return item;
}

export function createOrClaimImmediateWorkItem(
  db: DatabaseSync,
  input: ImmediateClaimInput,
  claimTiming: { now: string; leaseDurationMs: number },
): ImmediateClaimOutcome {
  const sourceVersion = input.sourceVersion ?? 1;
  const queuedAt = claimTiming.now;
  const claimExpiresAt = new Date(Date.parse(claimTiming.now) + claimTiming.leaseDurationMs).toISOString();
  const sourceRef = JSON.stringify(input.sourceRef);
  const workItemId = `w-${sourceIdOf(input.sourceRef)}-${input.kind}-v${sourceVersion}`;
  const currentBoundary = db.prepare(
    `SELECT state, source_version
     FROM derivation
     WHERE subject_kind = ? AND subject_id = ? AND derivation_type = ?`,
  );
  const boundariesMatch = (): boolean => {
    for (const target of input.expectedDerivations) {
      const row = currentBoundary.get(target.subjectKind, target.subjectId, target.derivationType) as
        | { state: string; source_version: number | bigint }
        | undefined;
      if (!target.exists) {
        if (row !== undefined) return false;
        continue;
      }
      if (row === undefined || row.state !== target.state || Number(row.source_version) !== target.sourceVersion) {
        return false;
      }
    }
    return true;
  };
  const upsertPending = (): void => {
    const upsert = db.prepare(
      `INSERT INTO derivation (subject_kind, subject_id, derivation_type, state, source_version)
       VALUES (?, ?, ?, 'pending', ?)
       ON CONFLICT (subject_kind, subject_id, derivation_type) DO UPDATE SET
         state = 'pending', content = NULL, reason = NULL, metadata = NULL,
         gaps = NULL, derived_at = NULL, source_version = excluded.source_version`,
    );
    for (const target of input.derivations) {
      upsert.run(target.subjectKind, target.subjectId, target.derivationType, sourceVersion);
    }
  };
  const exactLive = (): { work_item_id: string } | undefined =>
    db
      .prepare(
        `SELECT work_item_id
         FROM work_item
         WHERE status IN ('queued', 'claimed') AND owner = ? AND kind = ? AND source_ref = ?
           AND COALESCE(json_extract(payload, '$.sourceVersion'), 1) = ?
         LIMIT 1`,
      )
      .get(input.owner, input.kind, sourceRef, sourceVersion) as { work_item_id: string } | undefined;
  db.exec("BEGIN IMMEDIATE;");
  try {
    const head = db
      .prepare(
        `SELECT work_item_id, owner, kind, source_ref, status, queued_at, claim_expires_at, payload
         FROM work_item
         WHERE status IN ('queued', 'claimed')
         ORDER BY rowid LIMIT 1`,
      )
      .get() as unknown as
      | (RawClaimRow & {
          status: "queued" | "claimed";
          claim_expires_at: string | null;
        })
      | undefined;
    if (head !== undefined) {
      const headSourceVersion = parseWorkPayload(head).sourceVersion ?? 1;
      const isExactOperation =
        head.owner === input.owner &&
        head.kind === input.kind &&
        head.source_ref === sourceRef &&
        headSourceVersion === sourceVersion;
      if (!isExactOperation) {
        const live = exactLive();
        if (live !== undefined) {
          db.exec("COMMIT;");
          return { outcome: "in_flight", workItemId: live.work_item_id };
        }
        if (!boundariesMatch()) {
          db.exec("COMMIT;");
          return { outcome: "in_flight", workItemId };
        }
        const item = recordItem(db, input, queuedAt);
        upsertPending();
        db.exec("COMMIT;");
        return { outcome: "queued", workItemId: item.workItemId };
      }
      if (!boundariesMatch()) {
        db.exec("COMMIT;");
        return { outcome: "in_flight", workItemId: head.work_item_id };
      }
      if (head.status === "claimed") {
        const expiresAt = Date.parse(head.claim_expires_at ?? "");
        if (!Number.isFinite(expiresAt) || expiresAt <= Date.parse(claimTiming.now)) {
          const item = toClaimedItem(head);
          db.exec("COMMIT;");
          return { outcome: "expired", item };
        }
        db.exec("COMMIT;");
        return { outcome: "in_flight", workItemId: head.work_item_id };
      }
      const claimed = db
        .prepare(
          `UPDATE work_item
           SET status = 'claimed', claimed_at = ?, claim_expires_at = ?
           WHERE work_item_id = ? AND status = 'queued'
           RETURNING work_item_id, owner, kind, source_ref, queued_at, payload`,
        )
        .get(claimTiming.now, claimExpiresAt, head.work_item_id) as unknown as RawClaimRow | undefined;
      if (claimed === undefined) {
        db.exec("COMMIT;");
        return { outcome: "in_flight", workItemId: head.work_item_id };
      }
      const item = toClaimedItem(claimed);
      db.exec("COMMIT;");
      return { outcome: "claimed", item };
    }

    if (!boundariesMatch()) {
      db.exec("COMMIT;");
      return { outcome: "in_flight", workItemId };
    }

    const item = recordItem(db, input, queuedAt);
    upsertPending();

    const claimed = db
      .prepare(
        `UPDATE work_item
         SET status = 'claimed', claimed_at = ?, claim_expires_at = ?
         WHERE work_item_id = ? AND status = 'queued'
         RETURNING work_item_id, owner, kind, source_ref, queued_at, payload`,
      )
      .get(claimTiming.now, claimExpiresAt, item.workItemId) as unknown as RawClaimRow | undefined;
    if (claimed === undefined) {
      throw new Error(`failed to claim immediate work item ${item.workItemId}`);
    }
    const claimedItem = toClaimedItem(claimed);
    db.exec("COMMIT;");
    return { outcome: "claimed", item: claimedItem };
  } catch (cause) {
    db.exec("ROLLBACK;");
    throw cause;
  }
}

interface RawWorkItemRow {
  work_item_id: string;
  owner: string;
  kind: string;
  source_ref: string;
  queued_at: string;
}

// ── claim mechanics ───────────────────────────────────────────────
// All pure SQL against the caller's open handle, domain-blind. Claim,
// completion, and failure each own one short BEGIN IMMEDIATE; the handler in
// between runs with no open transaction.

// The claimed row as the drain holds it: mechanical fields plus the payload's
// source version and derivation targets. `kind` is a plain string here — a raw row
// with an unregistered kind must still be claimable so the drain can land it
// failed_terminal instead of skipping it.
export interface ClaimedWorkItem {
  workItemId: string;
  owner: WorkOwner;
  kind: string;
  sourceRef: WorkSourceRef;
  queuedAt: string;
  sourceVersion: number;
  operation?: DurableWorkOperation;
  derivations: EnqueueDerivationTarget[];
}

export type ClaimOutcome =
  | { outcome: "claimed"; item: ClaimedWorkItem }
  | { outcome: "expired"; item: ClaimedWorkItem }
  | { outcome: "empty" }
  | { outcome: "in_flight"; claimExpiresAt: string };

interface RawClaimRow {
  work_item_id: string;
  owner: string;
  kind: string;
  source_ref: string;
  queued_at: string;
  payload: string;
}

interface WorkPayload {
  sourceVersion?: number;
  operation?: DurableWorkOperation;
  derivations?: EnqueueDerivationTarget[];
}

function parseWorkPayload(row: Pick<RawClaimRow, "work_item_id" | "payload">): WorkPayload {
  return JSON.parse(row.payload) as WorkPayload;
}

function operationIntentForRow(kind: string, sourceRef: WorkSourceRef): DurableWorkOperation | undefined {
  if (!(kind in WORK_KIND_REGISTRY)) return undefined;
  return operationIntent(kind as WorkKind, sourceRef);
}

function toClaimedItem(row: RawClaimRow): ClaimedWorkItem {
  const sourceRef = JSON.parse(row.source_ref) as WorkSourceRef;
  const payload = parseWorkPayload(row);
  const operation = payload.operation ?? operationIntentForRow(row.kind, sourceRef);
  return {
    workItemId: row.work_item_id,
    owner: row.owner as WorkOwner,
    kind: row.kind,
    sourceRef,
    queuedAt: row.queued_at,
    sourceVersion: payload.sourceVersion ?? 1,
    ...(operation === undefined ? {} : { operation }),
    derivations: payload.derivations ?? [],
  };
}

export function deleteClaimedItem(db: DatabaseSync, item: { workItemId: string }): boolean {
  db.exec("BEGIN IMMEDIATE;");
  try {
    const deleted = db
      .prepare(`DELETE FROM work_item WHERE work_item_id = ? AND status = 'claimed'`)
      .run(item.workItemId);
    db.exec("COMMIT;");
    return Number(deleted.changes) > 0;
  } catch (cause) {
    db.exec("ROLLBACK;");
    throw cause;
  }
}

// Head-first, never skip-ahead: the claim decision is made against the oldest
// live row only. A queued head is claimed once. An expired claim is returned
// as dead work so the drain can fail it without running the handler again.
export function claimNext(db: DatabaseSync, now: string, leaseDurationMs: number): ClaimOutcome {
  const expiresAt = new Date(Date.parse(now) + leaseDurationMs).toISOString();
  db.exec("BEGIN IMMEDIATE;");
  try {
    const head = db
      .prepare(
        `SELECT work_item_id, owner, kind, source_ref, status, queued_at, claim_expires_at, payload
         FROM work_item WHERE status IN ('queued', 'claimed')
         ORDER BY rowid LIMIT 1`,
      )
      .get() as unknown as
      | (RawClaimRow & { status: "queued" | "claimed"; claim_expires_at: string | null })
      | undefined;
    if (head === undefined) {
      db.exec("COMMIT;");
      return { outcome: "empty" };
    }
    if (head.status === "claimed") {
      const expiry = Date.parse(head.claim_expires_at ?? "");
      const item = toClaimedItem(head);
      db.exec("COMMIT;");
      if (!Number.isFinite(expiry) || expiry <= Date.parse(now)) {
        return { outcome: "expired", item };
      }
      return { outcome: "in_flight", claimExpiresAt: head.claim_expires_at ?? "" };
    }
    const claimed = db
      .prepare(
        `UPDATE work_item
         SET status = 'claimed', claimed_at = ?, claim_expires_at = ?
         WHERE work_item_id = ? AND status = 'queued'
         RETURNING work_item_id, owner, kind, source_ref, queued_at, payload`,
      )
      .get(now, expiresAt, head.work_item_id) as unknown as RawClaimRow | undefined;
    if (claimed === undefined) throw new Error(`failed to claim queued work item ${head.work_item_id}`);
    const item = toClaimedItem(claimed);
    db.exec("COMMIT;");
    return { outcome: "claimed", item };
  } catch (cause) {
    db.exec("ROLLBACK;");
    throw cause;
  }
}

// Completion writes derivations and deletes the item row in one short
// transaction. UPDATE-only, never upsert: enqueue created the pending row, and
// completions for older source versions are discarded as stale. The optional
// onApplied hook runs after successful writes inside the same transaction, so
// follow-on chunk placement and summary enqueues commit or roll back with the
// completion.
export function complete(
  db: DatabaseSync,
  item: ClaimedWorkItem,
  writes: readonly HandlerDerivationWrite[],
  derivedAt: string,
  onApplied?: (tx: CompletionTx) => void,
): "done" | "stale_discarded" | "lost_lease" {
  const postCommitHook = createPostCommitHookSet();
  db.exec("BEGIN IMMEDIATE;");
  try {
    const owned = db
      .prepare(`SELECT 1 FROM work_item WHERE work_item_id = ? AND status = 'claimed'`)
      .get(item.workItemId);
    if (owned === undefined) {
      db.exec("COMMIT;");
      return "lost_lease";
    }
    assertExactDerivationWrites(item.derivations, writes);
    let hits = 0;
    let misses = 0;
    const update = db.prepare(
      `UPDATE derivation
       SET state = 'ready', content = ?, reason = NULL, metadata = ?, gaps = NULL, derived_at = ?
       WHERE subject_kind = ? AND subject_id = ? AND derivation_type = ? AND source_version = ?`,
    );
    for (const write of writes) {
      const changed = update.run(
        write.content,
        write.metadata === undefined ? null : JSON.stringify(write.metadata),
        derivedAt,
        write.subjectKind,
        write.subjectId,
        write.derivationType,
        item.sourceVersion,
      );
      const count = Number(changed.changes);
      if (count === 0) misses += 1;
      if (count > 1) {
        throw new DerivationCompletionError(
          `derivation completion write hit ${count} rows for ${targetKey(write)} at sourceVersion ${item.sourceVersion}`,
        );
      }
      hits += count;
    }
    const stale = writes.length > 0 && hits === 0;
    if (!stale && misses > 0) {
      throw new DerivationCompletionError(
        `derivation completion partially hit ${hits} of ${writes.length} rows at sourceVersion ${item.sourceVersion}`,
      );
    }
    if (!stale && onApplied !== undefined) {
      onApplied({ db, onCommit: postCommitHook.add });
    }
    db.prepare(`DELETE FROM work_item WHERE work_item_id = ? AND status = 'claimed'`).run(item.workItemId);
    db.exec("COMMIT;");
    postCommitHook.flush();
    return stale ? "stale_discarded" : "done";
  } catch (cause) {
    db.exec("ROLLBACK;");
    throw cause;
  }
}

// Delete still-queued items for the given (kind, sourceRef) targets, returning
// the deleted ids for mutation results. Runs inside the caller's ambient
// transaction. Claimed items are deliberately left alone: source-version
// checks discard their stale completions.
export function supersedeQueued(
  db: DatabaseSync,
  targets: ReadonlyArray<{ kind: WorkKind; sourceRef: WorkSourceRef }>,
): string[] {
  const ids: string[] = [];
  const remove = db.prepare(
    `DELETE FROM work_item WHERE status = 'queued' AND kind = ? AND source_ref = ?
     RETURNING work_item_id`,
  );
  for (const target of targets) {
    const rows = remove.all(target.kind, JSON.stringify(target.sourceRef)) as unknown as Array<{
      work_item_id: string;
    }>;
    for (const row of rows) ids.push(row.work_item_id);
  }
  return ids;
}

// Is there a live item, queued or in flight, for this kind and source at this
// source version? Runs inside the caller's repair transaction so the check and
// enqueue commit together. Version-scoped on purpose: older claimed work is
// already fenced by source version and must not block repair.
export function hasLiveItem(
  db: DatabaseSync,
  kind: WorkKind,
  sourceRef: WorkSourceRef,
  sourceVersion: number,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM work_item
       WHERE status IN ('queued', 'claimed') AND kind = ? AND source_ref = ?
         AND COALESCE(json_extract(payload, '$.sourceVersion'), 1) = ?
       LIMIT 1`,
    )
    .get(kind, JSON.stringify(sourceRef), sourceVersion);
  return row !== undefined;
}

// Live items left in the queue; used by drain reporting and owner repair reports.
export function countLiveItems(db: DatabaseSync): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM work_item WHERE status IN ('queued', 'claimed')`)
    .get() as unknown as { n: number | bigint };
  return Number(row.n);
}

export interface QueueDetailRow {
  workItemId: string;
  owner: WorkOwner;
  kind: string;
  sourceRef: WorkSourceRef;
  status: "queued" | "claimed";
  claimedAt?: string;
  claimExpiresAt?: string;
  queuedAt: string;
  sourceVersion: number;
}

// Mechanical detail of every live row in queue order. Owner reports join this
// against derivations; tests use it for lease assertions.
export function queueDetail(db: DatabaseSync): QueueDetailRow[] {
  const rows = db
    .prepare(
      `SELECT work_item_id, owner, kind, source_ref, status, claimed_at,
              claim_expires_at, queued_at, payload
       FROM work_item ORDER BY rowid`,
    )
    .all() as unknown as Array<
    RawClaimRow & {
      status: string;
      claimed_at: string | null;
      claim_expires_at: string | null;
    }
  >;
  return rows.map((row) => {
    const item = toClaimedItem(row);
    const detail: QueueDetailRow = {
      workItemId: item.workItemId,
      owner: item.owner,
      kind: item.kind,
      sourceRef: item.sourceRef,
      status: row.status as "queued" | "claimed",
      queuedAt: item.queuedAt,
      sourceVersion: item.sourceVersion,
    };
    if (row.claimed_at !== null) detail.claimedAt = row.claimed_at;
    if (row.claim_expires_at !== null) detail.claimExpiresAt = row.claim_expires_at;
    return detail;
  });
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
