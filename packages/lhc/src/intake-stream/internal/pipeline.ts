// Flow 2 (recording half) + Flow 5: the batch transaction. The pipeline order
// is load-bearing: validate (pure, no lock) → BEGIN IMMEDIATE → per event in
// array order [dedup-check → record] → walk-time result assembly → COMMIT.
// Stories 3–5 extend the same per-event walk with projection, turn
// transitions, and work queueing.
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import {
  createCommitHooks,
  resolveInstancePoke,
  resolveInstanceToolResultConfig,
  type OperationContext,
} from "../../shared-tech/index.js";
import { storageFailure, type ErrorResult, type OpResult } from "../../shared-tech/index.js";
import type { WorkItemRecord } from "../../shared-tech/work-queue/index.js";
import { createFromEvent, queueMessageWork } from "../../messages/index.js";
// The sanctioned intake→thread-view surface import (Epic 03 Flow 4, named in
// check-boundaries): the boundary-advance registration below, nothing else.
// This is the domain graph's first surface-level cycle (intake → thread-view
// → messages ← intake) — runtime-safe because thread-view never imports
// intake-stream at runtime and the registration executes only at flush.
import { runPostCommitBoundaryAdvance } from "../../thread-view/index.js";
import { openThreadDatabase, resolveThreadRef, type ThreadRef } from "../../threads/index.js";
import { applyEvent as applyTurnEvent, listOpenTurnIds } from "../../turns/index.js";
import type { BatchResult, EventRecord, MessageEventInput } from "../index.js";
import { validateEvents, validateThreadRef } from "./validate.js";

// Test seam (set only through test/fixtures): called after each event is
// processed inside the walk, so atomicity under mid-walk failure can be
// induced through a real mechanism — closing the handle — rather than a
// mocked transaction object.
export type IntakeWalkHook = (db: DatabaseSync, eventIndex: number) => void;
let walkHook: IntakeWalkHook | null = null;
export function setIntakeWalkHook(hook: IntakeWalkHook | null): void {
  walkHook = hook;
}

// Test seam (set only through test/fixtures): replaces the wall clock so
// recordedAt is sourced deterministically for the public SDK contract proof —
// TC-1.4 records the same batch through both reference forms and reads it back
// field-for-field, recordedAt included, with nothing stripped. Unset in
// production: recording stamps real wall time. An explicit clock argument to
// runMessageEvents still wins over the seam.
let injectedClock: (() => Date) | null = null;
export function setIntakeClock(clock: (() => Date) | null): void {
  injectedClock = clock;
}

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function threadNotFound(filePath: string): { ok: false; error: ErrorResult } {
  return {
    ok: false,
    error: {
      errorClass: "caller_error",
      code: "thread_not_found",
      reason: `no thread file exists at ${filePath}`,
    },
  };
}

// The skip set is read at transaction start and reads only the key column:
// key-wins-over-content is the absence of a content comparison (AC-5.5).
// Chunked to stay under SQLite's bound-parameter limit.
function recordedKeys(db: DatabaseSync, keys: readonly string[]): Set<string> {
  const found = new Set<string>();
  for (let offset = 0; offset < keys.length; offset += 400) {
    const chunk = keys.slice(offset, offset + 400);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .prepare(`SELECT idempotency_key FROM event WHERE idempotency_key IN (${placeholders})`)
      .all(...chunk) as unknown as Array<{ idempotency_key: string }>;
    for (const row of rows) found.add(row.idempotency_key);
  }
  return found;
}

function threadIdOf(db: DatabaseSync): string {
  const row = db.prepare("SELECT thread_id FROM thread_metadata WHERE id = 1").get() as
    | { thread_id: string }
    | undefined;
  if (row === undefined) throw new Error("thread file has no metadata row");
  return row.thread_id;
}

function maxEventOrder(db: DatabaseSync): number {
  const row = db.prepare("SELECT MAX(event_order) AS max_order FROM event").get() as
    | { max_order: number | bigint | null }
    | undefined;
  return Number(row?.max_order ?? 0);
}

export async function runMessageEvents(
  thread: ThreadRef,
  events: readonly MessageEventInput[],
  clock: () => Date = injectedClock ?? (() => new Date()),
): Promise<OpResult<BatchResult>> {
  // Pure validation first: a rejected batch never opens the file, never takes
  // the write lock, and a duplicate key on a malformed event is a rejection,
  // not a skip (validation-before-idempotency precedence).
  const refFailure = validateThreadRef(thread);
  if (refFailure !== undefined) return { ok: false, error: refFailure };
  const batchFailure = validateEvents(events);
  if (batchFailure !== undefined) return { ok: false, error: batchFailure };

  const resolved = await resolveThreadRef(thread);
  if (!resolved.ok) return resolved;
  const { filePath } = resolved.value;
  if (!existsSync(filePath)) return threadNotFound(filePath);

  // openThreadDatabase verifies the file is a real thread file, then brings
  // its schema to the current version before the batch transaction begins,
  // so a thread recorded under an earlier story is writable here (F-03-001)
  // and a non-thread file is rejected unmutated (F-03-002).
  const opened = openThreadDatabase(filePath);
  if (!opened.ok) return opened;
  const db = opened.value;

  // BEGIN IMMEDIATE (not deferred): the write lock is taken up front so
  // single-writer violations fail loudly at a defined point.
  let inTransaction = false;
  try {
    db.exec("BEGIN IMMEDIATE;");
    inTransaction = true;

    // Cross-domain calls inside the transaction share the open handle through
    // the operation context (design decision 8); built once per batch, never
    // stored. onCommit registrations (the scheduler pokes enqueue makes,
    // DD-5) flush only after COMMIT succeeds; a rollback path never flushes,
    // so they drop with the transaction.
    const hooks = createCommitHooks();
    const ctx: OperationContext = {
      db,
      clock,
      threadId: threadIdOf(db),
      onCommit: hooks.register,
      poke: resolveInstancePoke(),
    };

    // The boundary-advance registration (Epic 03 Flow 4, AC-4.9; trigger
    // gated by Epic 05 AC-5.1): registered FIRST so the flush runs it before
    // any queue poke the walk's enqueues register — advance first, poke
    // second, the pinned order. It runs in both host modes (deterministic and
    // cheap, unlike the mode-gated drain). Throw-isolated: a failing advance
    // is caught and diagnosed here, never thrown into the flush — it cannot
    // eat the pokes behind it and cannot reach this batch's caller; intake's
    // outcome never depends on it. The boundary is then unchanged and the
    // over-budget condition stays visible in status (computed live); the next
    // turn-end batch's check heals.
    //
    // The gate (Epic 05 DD-9): the advance check runs only when this batch
    // COMMITS a turn_end event. The registration site, ordering, and throw
    // isolation are untouched — the callback consults a flag the walk below
    // sets when it records a turn_end (skipped duplicates never set it, so a
    // resent turn_end alone triggers nothing). Mid-turn batches therefore
    // never move the boundary regardless of zone size.
    let batchCommittedTurnEnd = false;
    ctx.onCommit(() => {
      if (!batchCommittedTurnEnd) return;
      try {
        runPostCommitBoundaryAdvance(ctx);
      } catch (cause) {
        process.stderr.write(
          `lhc: boundary advance failed after intake commit (boundary unchanged; condition visible in view status): ${detail(cause)}\n`,
        );
      }
    });

    // Corruption check at state load (AC-3.9): after BEGIN IMMEDIATE, before
    // any event is processed — once is sufficient because only this pipeline
    // writes turn state and the write lock is already held, so more than one
    // open turn can only mean external interference. The batch records
    // nothing: nothing has been written yet, and the rollback closes the
    // never-used transaction.
    const openTurnIds = listOpenTurnIds(ctx);
    if (openTurnIds.length > 1) {
      db.exec("ROLLBACK;");
      inTransaction = false;
      return {
        ok: false,
        error: {
          errorClass: "state_corruption",
          code: "turn_state_corrupt",
          reason: `thread has ${openTurnIds.length} open turns (${openTurnIds.join(", ")}); the invariant is at most one`,
        },
      };
    }

    const skipSet = recordedKeys(
      db,
      events.map((event) => event.idempotencyKey),
    );
    // Order counter from MAX(event_order): only recorded events increment it,
    // so skips consume no order numbers and the sequence stays dense.
    let lastOrder = maxEventOrder(db);

    const insert = db.prepare(
      `INSERT INTO event (event_order, event_kind, idempotency_key, actor, harness, payload, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    const eventResults: BatchResult["events"] = [];
    const turnTransitions: BatchResult["turnTransitions"] = [];
    // Work items append as they queue, in walk order — the result is a
    // faithful log of what the transaction did (AC-2.7). The full records
    // (status, queuedAt) stay in the thread file; the result carries item
    // identity only.
    const queuedItems: WorkItemRecord[] = [];
    for (const [index, event] of events.entries()) {
      if (skipSet.has(event.idempotencyKey)) {
        eventResults.push({
          idempotencyKey: event.idempotencyKey,
          outcome: "skipped",
          skipReason: "duplicate_idempotency_key",
        });
      } else {
        lastOrder += 1;
        if (event.eventKind === "turn_end") batchCommittedTurnEnd = true;
        const recordedAt = clock().toISOString();
        insert.run(
          lastOrder,
          event.eventKind,
          event.idempotencyKey,
          event.actor,
          event.harness,
          JSON.stringify(event.payload),
          recordedAt,
        );
        skipSet.add(event.idempotencyKey);
        // Turn transition before projection — the order is load-bearing: a
        // prompt transitions first and stamps to the turn it just opened
        // (AC-3.1, AC-3.3); non-transition kinds stamp to whatever is open,
        // or null in a gap (AC-3.2, AC-3.8). Skipped events never reach this
        // call, so a resend causes no transition (TC-5.4).
        const turnOutcome = applyTurnEvent(ctx, event.eventKind, lastOrder);
        turnTransitions.push(...turnOutcome.transitions);
        queuedItems.push(...turnOutcome.queuedWork);
        // Projection runs in the same iteration that recorded the event, so
        // it can never drift from its source; a projection failure throws
        // and rejects the whole batch. Skipped events never reach this call
        // (no duplicate message, AC-5.4).
        const created = createFromEvent(
          ctx,
          {
            ...event,
            eventOrder: lastOrder,
            recordedAt,
          },
          turnOutcome.openTurnId,
        );
        // Message-owned work queues in the same iteration, gated on
        // recorded: a skipped event never reaches this call, so it queues
        // nothing (AC-5.4), and the kind gate inside queueMessageWork
        // decides which messages are derivation sources (AC-2.8).
        queuedItems.push(...queueMessageWork(ctx, created, resolveInstanceToolResultConfig()));
        const entry: BatchResult["events"][number] = {
          idempotencyKey: event.idempotencyKey,
          outcome: "recorded",
        };
        if (created !== null) entry.messageId = created.messageId;
        eventResults.push(entry);
      }
      walkHook?.(db, index);
    }

    db.exec("COMMIT;");
    inTransaction = false;
    hooks.flush();

    return {
      ok: true,
      value: {
        events: eventResults,
        turnTransitions,
        queuedWork: queuedItems.map((item) => ({
          workItemId: item.workItemId,
          owner: item.owner,
          kind: item.kind,
          sourceRef: item.sourceRef,
        })),
        threadPosition: { lastEventOrder: lastOrder },
      },
    };
  } catch (cause) {
    // Any in-transaction failure rolls back whole: AC-4.6's guarantee is
    // class-independent. The handle may already be gone (induced failure),
    // in which case SQLite has already discarded the uncommitted transaction.
    if (inTransaction) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        // handle closed mid-walk; the open transaction died with it
      }
    }
    return storageFailure(`event batch failed and rolled back whole: ${detail(cause)}`);
  } finally {
    try {
      db.close();
    } catch {
      // already closed by the induced-failure seam
    }
  }
}

interface RawEventRow {
  event_order: number | bigint;
  event_kind: string;
  idempotency_key: string;
  actor: string;
  harness: string;
  payload: string;
  recorded_at: string;
}

export async function runListEvents(thread: ThreadRef): Promise<OpResult<EventRecord[]>> {
  const refFailure = validateThreadRef(thread);
  if (refFailure !== undefined) return { ok: false, error: refFailure };

  const resolved = await resolveThreadRef(thread);
  if (!resolved.ok) return resolved;
  const { filePath } = resolved.value;
  if (!existsSync(filePath)) return threadNotFound(filePath);

  const opened = openThreadDatabase(filePath);
  if (!opened.ok) return opened;
  const db = opened.value;
  try {
    const rows = db
      .prepare(
        `SELECT event_order, event_kind, idempotency_key, actor, harness, payload, recorded_at
         FROM event ORDER BY event_order`,
      )
      .all() as unknown as RawEventRow[];
    const records = rows.map(
      (row) =>
        ({
          eventKind: row.event_kind,
          idempotencyKey: row.idempotency_key,
          actor: row.actor,
          harness: row.harness,
          payload: JSON.parse(row.payload) as Record<string, unknown>,
          eventOrder: Number(row.event_order),
          recordedAt: row.recorded_at,
        }) as unknown as EventRecord,
    );
    return { ok: true, value: records };
  } catch (cause) {
    return storageFailure(`event read-back failed: ${detail(cause)}`);
  } finally {
    db.close();
  }
}
