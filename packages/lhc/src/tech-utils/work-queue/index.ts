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
import {
  createCommitHooks,
  fireSchedulerPoke,
  type OperationContext,
} from "../../shared/context.js";
import type {
  CompletionTx,
  FormKind,
  HandlerFormWrite,
  SubjectKind,
} from "../../shared/derivation.js";

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

// The derived forms an enqueue is scheduling work toward; the owning domain
// names them (the util stays meaning-blind). Stored in the row's payload so
// the drain's terminal paths (retry exhaustion, blocked source) can land the
// form's failed/blocked state without asking any domain what a kind means.
export interface EnqueueFormTarget {
  subjectKind: SubjectKind;
  subjectId: string;
  form: FormKind;
}

export interface WorkItemInput {
  owner: WorkOwner;
  kind: WorkKind;
  sourceRef: WorkSourceRef;
  sourceVersion?: number; // defaults to 1 — first version of a fresh source
  forms?: readonly EnqueueFormTarget[]; // carried in payload for the drain's terminal paths
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
    JSON.stringify({ sourceVersion, forms: input.forms ?? [] }),
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

// ── claim mechanics (Epic 02 Story 1, tech design §Mechanics) ─────
// All pure SQL against the caller's open handle, domain-blind. Claim,
// complete, and the terminal half of failAttempt each own one short
// BEGIN IMMEDIATE; the handler in between runs with no open transaction.

// The claimed row as the drain holds it: mechanical fields plus the payload's
// source version and form targets. `kind` is a plain string here — a raw row
// with an unregistered kind must still be claimable so the drain can land it
// failed_terminal instead of skipping it (AC-1.8).
export interface ClaimedWorkItem {
  workItemId: string;
  owner: WorkOwner;
  kind: string;
  sourceRef: WorkSourceRef;
  attempts: number;
  queuedAt: string;
  sourceVersion: number;
  forms: EnqueueFormTarget[];
}

export type ClaimOutcome =
  | { outcome: "claimed"; item: ClaimedWorkItem }
  | { outcome: "empty" }
  | { outcome: "in_flight"; claimExpiresAt: string }
  | { outcome: "waiting"; waitingUntil: string };

interface RawClaimRow {
  work_item_id: string;
  owner: string;
  kind: string;
  source_ref: string;
  attempts: number | bigint;
  queued_at: string;
  payload: string | null;
}

// Form targets for pre-v5 rows, whose payload is NULL (Epic 01 wrote no
// payload column). Exactly the F-02 backfill's kind→form mapping (migration
// v5, shared/storage.ts): the backfill created pending derived_form rows at
// source version 1 for these kinds, and a terminal failure must find them —
// otherwise exhaustion would delete the work row and strand the backfilled
// form as pending forever, breaking AC-1.9/DD-1 for upgraded threads.
const LEGACY_KIND_FORMS: Partial<
  Record<string, ReadonlyArray<{ subjectKind: SubjectKind; form: FormKind }>>
> = {
  prompt_smoothing: [{ subjectKind: "message", form: "smoothed_prompt" }],
  tool_result_summary: [{ subjectKind: "message", form: "tool_result_summary" }],
  turn_derivation: [
    { subjectKind: "turn", form: "turn_rendering" },
    { subjectKind: "turn", form: "lower_band_projection" },
  ],
};

function legacyFormTargets(kind: string, sourceRef: WorkSourceRef): EnqueueFormTarget[] {
  const mapped = LEGACY_KIND_FORMS[kind];
  if (mapped === undefined) return [];
  const subjectId = sourceIdOf(sourceRef);
  return mapped.map((target) => ({ ...target, subjectId }));
}

function toClaimedItem(row: RawClaimRow): ClaimedWorkItem {
  const sourceRef = JSON.parse(row.source_ref) as WorkSourceRef;
  const payload =
    row.payload === null
      ? // Pre-v5 row: version 1 (matching the backfill) and form targets
        // reconstructed from the backfill's own mapping.
        { sourceVersion: 1, forms: legacyFormTargets(row.kind, sourceRef) }
      : (JSON.parse(row.payload) as { sourceVersion?: number; forms?: EnqueueFormTarget[] });
  return {
    workItemId: row.work_item_id,
    owner: row.owner as WorkOwner,
    kind: row.kind,
    sourceRef,
    attempts: Number(row.attempts),
    queuedAt: row.queued_at,
    sourceVersion: payload.sourceVersion ?? 1,
    forms: payload.forms ?? [],
  };
}

// Head-first, never skip-ahead: the claim decision is made against the oldest
// live row only — a later eligible row is never considered while an older
// live row exists. One atomic UPDATE under BEGIN IMMEDIATE (no read-then-
// write split: the race window is the bug class). The CASE increments
// `attempts` only when reclaiming an expired claimed row — a reclaim means a
// run died or hung, and the increment makes the crash visible in the report
// and counts it against the retry budget; normal claims never touch it.
export function claimNext(db: DatabaseSync, now: string, leaseDurationMs: number): ClaimOutcome {
  const expiresAt = new Date(Date.parse(now) + leaseDurationMs).toISOString();
  db.exec("BEGIN IMMEDIATE;");
  try {
    const claimed = db
      .prepare(
        `UPDATE work_item SET status = 'claimed', claimed_at = ?, claim_expires_at = ?,
           attempts = attempts + CASE WHEN status = 'claimed' THEN 1 ELSE 0 END
         WHERE work_item_id = (
           SELECT work_item_id FROM (
             SELECT work_item_id, status, eligible_at, claim_expires_at
             FROM work_item WHERE status IN ('queued', 'claimed')
             ORDER BY rowid LIMIT 1
           )
           WHERE (status = 'queued' AND (eligible_at IS NULL OR eligible_at <= ?))
              OR (status = 'claimed' AND claim_expires_at <= ?)
         )
         RETURNING work_item_id, owner, kind, source_ref, attempts, queued_at, payload`,
      )
      .get(now, expiresAt, now, now) as unknown as RawClaimRow | undefined;
    if (claimed !== undefined) {
      db.exec("COMMIT;");
      return { outcome: "claimed", item: toClaimedItem(claimed) };
    }
    // No row claimable: re-read the head inside the same transaction to
    // classify the stop. A claimed head with a live lease gates the queue
    // (in_flight, AC-1.4); a queued head still backing off gates it too
    // (waiting) — strict ordering, never reordered around the head.
    const head = db
      .prepare(
        `SELECT status, eligible_at, claim_expires_at
         FROM work_item WHERE status IN ('queued', 'claimed')
         ORDER BY rowid LIMIT 1`,
      )
      .get() as unknown as
      | { status: string; eligible_at: string | null; claim_expires_at: string | null }
      | undefined;
    db.exec("COMMIT;");
    if (head === undefined) return { outcome: "empty" };
    if (head.status === "claimed") {
      return { outcome: "in_flight", claimExpiresAt: head.claim_expires_at ?? "" };
    }
    return { outcome: "waiting", waitingUntil: head.eligible_at ?? "" };
  } catch (cause) {
    db.exec("ROLLBACK;");
    throw cause;
  }
}

// Completion: the version-checked form writes and the item row's deletion in
// one short transaction (DD-1: terminal transition deletes the row; the
// disposition is reported in-memory, never stored). UPDATE-only, never
// upsert — the pending row exists from enqueue; a write that finds no row at
// the item's source version is discarded as stale (DD-3 truth table). The
// optional onApplied hook (Story 3) runs inside this same transaction, after
// the form writes and only when they landed — chunk placement and the
// close→summary enqueues ride the completion commit; its onCommit
// registrations (the enqueue pokes) flush after COMMIT and drop on rollback.
export function complete(
  db: DatabaseSync,
  item: ClaimedWorkItem,
  writes: readonly HandlerFormWrite[],
  derivedAt: string,
  onApplied?: (tx: CompletionTx) => void,
): "done" | "stale_discarded" {
  const hooks = createCommitHooks();
  db.exec("BEGIN IMMEDIATE;");
  try {
    let hits = 0;
    const update = db.prepare(
      `UPDATE derived_form
       SET state = 'ready', content = ?, reason = NULL, metadata = ?, gaps = ?, derived_at = ?
       WHERE subject_kind = ? AND subject_id = ? AND form = ? AND source_version = ?`,
    );
    for (const write of writes) {
      const changed = update.run(
        write.content,
        write.metadata === undefined ? null : JSON.stringify(write.metadata),
        write.gaps === undefined ? null : JSON.stringify(write.gaps),
        derivedAt,
        write.subjectKind,
        write.subjectId,
        write.form,
        item.sourceVersion,
      );
      hits += Number(changed.changes);
    }
    const stale = writes.length > 0 && hits === 0;
    if (!stale && onApplied !== undefined) {
      onApplied({ db, onCommit: hooks.register });
    }
    db.prepare(`DELETE FROM work_item WHERE work_item_id = ?`).run(item.workItemId);
    db.exec("COMMIT;");
    hooks.flush();
    return stale ? "stale_discarded" : "done";
  } catch (cause) {
    db.exec("ROLLBACK;");
    throw cause;
  }
}

export interface RetryPolicy {
  budget: number;
  backoffBaseMs: number;
  backoffCapMs: number;
}

export type FailAttemptResult =
  | { terminal: false; attempts: number; eligibleAt: string }
  | { terminal: true; attempts: number };

// Terminal failure: the form rows land `failed` (or `blocked` for source
// damage) carrying the final reason plus attempts/last-error copied onto the
// form's metadata, and the item row is deleted — one transaction (DD-1).
// Form writes stay version-checked: if a mutation moved the source since this
// item was queued, the stale failure must not stamp the rebuilt form.
export function failTerminal(
  db: DatabaseSync,
  item: ClaimedWorkItem,
  opts: { reason: string; formState: "failed" | "blocked"; attempts: number; now: string },
): void {
  db.exec("BEGIN IMMEDIATE;");
  try {
    const update = db.prepare(
      `UPDATE derived_form
       SET state = ?, content = NULL, reason = ?, metadata = ?, gaps = NULL, derived_at = ?
       WHERE subject_kind = ? AND subject_id = ? AND form = ? AND source_version = ?`,
    );
    const metadata = JSON.stringify({ attempts: opts.attempts, lastError: opts.reason });
    for (const target of item.forms) {
      update.run(
        opts.formState,
        opts.reason,
        metadata,
        opts.now,
        target.subjectKind,
        target.subjectId,
        target.form,
        item.sourceVersion,
      );
    }
    db.prepare(`DELETE FROM work_item WHERE work_item_id = ?`).run(item.workItemId);
    db.exec("COMMIT;");
  } catch (cause) {
    db.exec("ROLLBACK;");
    throw cause;
  }
}

// A failed run counts itself. Under budget and retryable: the row goes back
// to `queued` with attempts incremented and eligibility pushed out by backoff
// (min(base × 2^attempts, cap)) — retry is not a status (DD-1). At budget, or
// on a non-retryable failure, the item is terminal: form `failed` with the
// final reason, row deleted (AC-1.9).
export function failAttempt(
  db: DatabaseSync,
  item: ClaimedWorkItem,
  opts: { reason: string; retryable: boolean; now: string; retry: RetryPolicy },
): FailAttemptResult {
  const attempts = item.attempts + 1;
  if (opts.retryable && attempts < opts.retry.budget) {
    const backoffMs = Math.min(
      opts.retry.backoffBaseMs * 2 ** attempts,
      opts.retry.backoffCapMs,
    );
    const eligibleAt = new Date(Date.parse(opts.now) + backoffMs).toISOString();
    db.exec("BEGIN IMMEDIATE;");
    try {
      db.prepare(
        `UPDATE work_item
         SET status = 'queued', attempts = ?, last_error = ?,
             claimed_at = NULL, claim_expires_at = NULL, eligible_at = ?
         WHERE work_item_id = ?`,
      ).run(attempts, opts.reason, eligibleAt, item.workItemId);
      db.exec("COMMIT;");
    } catch (cause) {
      db.exec("ROLLBACK;");
      throw cause;
    }
    return { terminal: false, attempts, eligibleAt };
  }
  failTerminal(db, item, { reason: opts.reason, formState: "failed", attempts, now: opts.now });
  return { terminal: true, attempts };
}

// Cascade tidy (tech design issue 1): delete still-queued items for the given
// (kind, sourceRef) targets, returning the deleted ids for the mutation
// result's `superseded` list. Runs inside the caller's ambient transaction —
// the cascade owns the BEGIN/COMMIT — so no transaction is opened here.
// Claimed items are deliberately left alone: the source-version check (DD-3)
// discards their stale completions. Ships here as mechanics; its only caller
// is Story 5's cascade.
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

// The requeue no-op rule's EXISTS check (AC-4.5): is there a live item —
// queued or in flight — for this kind and source at this source version?
// Runs inside the caller's requeue transaction so the check and the enqueue
// commit together (anti-shim: a check-then-enqueue split across transactions
// reintroduces the duplicate-work race). Version-scoped on purpose: a
// claimed pre-mutation item at an older version is dying work whose
// completion DD-3 will discard — it must not block the repair.
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

// Live items left in the queue — the drain report's `remaining` and the
// repair report's join source (Story 4).
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
  attempts: number;
  lastError?: string;
  eligibleAt?: string;
  claimedAt?: string;
  claimExpiresAt?: string;
  queuedAt: string;
  sourceVersion: number;
}

// Mechanical detail of every live row in queue order — what the repair
// report joins against derived_form (Flow 4) and what tests read to assert
// lease/backoff state without raw SQL at every call site.
export function queueDetail(db: DatabaseSync): QueueDetailRow[] {
  const rows = db
    .prepare(
      `SELECT work_item_id, owner, kind, source_ref, status, attempts, last_error,
              eligible_at, claimed_at, claim_expires_at, queued_at, payload
       FROM work_item ORDER BY rowid`,
    )
    .all() as unknown as Array<
    RawClaimRow & {
      status: string;
      last_error: string | null;
      eligible_at: string | null;
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
      attempts: item.attempts,
      queuedAt: item.queuedAt,
      sourceVersion: item.sourceVersion,
    };
    if (row.last_error !== null) detail.lastError = row.last_error;
    if (row.eligible_at !== null) detail.eligibleAt = row.eligible_at;
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
