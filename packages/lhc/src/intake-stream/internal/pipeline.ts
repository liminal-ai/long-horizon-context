// Flow 2 (recording half) + Flow 5: the batch transaction. The pipeline order
// is load-bearing: validate (pure, no lock) → BEGIN IMMEDIATE → per event in
// array order [dedup-check → record] → walk-time result assembly → COMMIT.
// Stories 3–5 extend the same per-event walk with projection, turn
// transitions, and work queueing.
import type { DatabaseSync } from "node:sqlite";
import { create as createMessage } from "../../messages/index.js";
import {
  createDbReadTransaction,
  createDbWriteTransaction,
  type OpResult,
  resolveInstanceToolResultConfig,
  storageFailure,
} from "../../shared-tech/index.js";
import type { WorkItemRecord } from "../../shared-tech/work-queue/index.js";
// The sanctioned intake→thread-view surface import (Epic 03 Flow 4, named in
// the boundary-advance registration below, nothing else.
// This is the domain graph's first surface-level cycle (intake → thread-view
// → messages ← intake) — runtime-safe because thread-view never imports
// intake-stream at runtime and the registration executes only at flush.
import { runPostCommitBoundaryAdvance } from "../../thread-view/index.js";
import type { ThreadRef } from "../../threads/index.js";
import { create as createTurn, TurnStateCorruptionError } from "../../turns/index.js";
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

  try {
    const result = await createDbWriteTransaction(
      thread,
      (transaction): OpResult<BatchResult> => {
        // The boundary-advance registration (Epic 03 Flow 4, AC-4.9; trigger
        // gated by Epic 05 AC-5.1): registered FIRST so the flush runs it before
        // any queue poke the walk's enqueues register — advance first, poke
        // second, the pinned order.
        let batchCommittedTurnEnd = false;
        transaction.postCommitHook.add(() => {
          if (!batchCommittedTurnEnd) return;
          try {
            runPostCommitBoundaryAdvance(transaction);
          } catch (cause) {
            process.stderr.write(
              `lhc: boundary advance failed after intake commit (boundary unchanged; condition visible in view status): ${detail(cause)}\n`,
            );
          }
        });

        const skipSet = recordedKeys(
          transaction.db,
          events.map((event) => event.idempotencyKey),
        );
        // Order counter from MAX(event_order): only recorded events increment it,
        // so skips consume no order numbers and the sequence stays dense.
        let lastOrder = maxEventOrder(transaction.db);

        const insert = transaction.db.prepare(
          `INSERT INTO event (event_order, event_kind, idempotency_key, actor, harness, payload, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );

        const eventResults: BatchResult["events"] = [];
        const turnTransitions: BatchResult["turnTransitions"] = [];
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
            const recordedEvent = {
              ...event,
              eventOrder: lastOrder,
              recordedAt,
            };
            const turnOutcome = createTurn(transaction, recordedEvent);
            if (
              event.eventKind === "turn_end" &&
              turnOutcome.transitions.some((transition) => transition.action === "closed")
            ) {
              batchCommittedTurnEnd = true;
            }
            turnTransitions.push(...turnOutcome.transitions);
            queuedItems.push(...turnOutcome.queuedWork);
            const created = createMessage(
              transaction,
              recordedEvent,
              turnOutcome.turnId,
              resolveInstanceToolResultConfig(),
            );
            queuedItems.push(...created.queuedWork);
            const entry: BatchResult["events"][number] = {
              idempotencyKey: event.idempotencyKey,
              outcome: "recorded",
            };
            if (created.message !== null) entry.messageId = created.message.messageId;
            eventResults.push(entry);
          }
          walkHook?.(transaction.db, index);
        }

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
      },
      clock,
    );
    return result.ok ? result.value : result;
  } catch (cause) {
    if (cause instanceof TurnStateCorruptionError) {
      return {
        ok: false,
        error: {
          errorClass: cause.errorClass,
          code: cause.code,
          reason: cause.message,
        },
      };
    }
    return storageFailure(`event batch failed and rolled back whole: ${detail(cause)}`);
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
  try {
    return await createDbReadTransaction(thread, (transaction) => {
      const rows = transaction.db
        .prepare(
          `SELECT event_order, event_kind, idempotency_key, actor, harness, payload, recorded_at
           FROM event ORDER BY event_order`,
        )
        .all() as unknown as RawEventRow[];
      return rows.map(
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
    });
  } catch (cause) {
    return storageFailure(`event read-back failed: ${detail(cause)}`);
  }
}
