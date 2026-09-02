// Batch transaction pipeline. The order is load-bearing: validate (pure, no
// lock) → BEGIN IMMEDIATE → per event in array order [dedup-check → record] →
// walk-time result assembly → COMMIT. The same per-event walk performs message
// creation, turn transitions, and work queueing.
import type { DatabaseSync } from "node:sqlite";
import { create as createMessage } from "../../messages/index.js";
import {
  createDbReadTransaction,
  createDbWriteTransaction,
  type ErrorResult,
  type OpResult,
  storageFailure,
} from "../../shared-tech/index.js";
import type { WorkItemRecord } from "../../shared-tech/work-queue/index.js";
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
// tests record the same batch through both reference shapes and read it back
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
// key-wins-over-content is the absence of a content comparison.
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
  threadRef: ThreadRef,
  events: readonly MessageEventInput[],
  clock: () => Date = injectedClock ?? (() => new Date()),
): Promise<OpResult<BatchResult>> {
  // Pure validation first: a rejected batch never opens the file, never takes
  // the write lock, and a duplicate key on a malformed event is a rejection,
  // not a skip (validation-before-idempotency precedence).
  const refFailure = validateThreadRef(threadRef);
  if (refFailure !== undefined) return { ok: false, error: refFailure };
  const batchFailure = validateEvents(events);
  if (batchFailure !== undefined) return { ok: false, error: batchFailure };

  try {
    const result = await createDbWriteTransaction(
      threadRef,
      (transaction): OpResult<BatchResult> => {
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
            turnTransitions.push(...turnOutcome.transitions);
            queuedItems.push(...turnOutcome.queuedWork);
            const created = createMessage(transaction, recordedEvent, turnOutcome.turnId);
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

export async function runListEvents(threadRef: ThreadRef): Promise<OpResult<EventRecord[]>> {
  const refFailure = validateThreadRef(threadRef);
  if (refFailure !== undefined) return { ok: false, error: refFailure };
  try {
    return await createDbReadTransaction(threadRef, (transaction) => {
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

// ── Bounded archive projections ───────────────────────────────────────────
//
// listEvents above is the explicit full-archive read. The projections below
// are the bounded alternative for consumers that only need durable position
// or a finite, caller-named slice of the key space: every statement selects
// indexed, non-payload columns only, and every result set is constant-sized
// or O(caller input).
//
// event.idempotency_key is UNIQUE (sqlite_autoindex_event_1) and event_order
// is the rowid, so a key-prefix range is an index range whose entries already
// carry the order — no payload is read or parsed on any of these paths.

/** Constant-row frontier statements. No payload column, no history-wide COUNT. */
export const FRONTIER_METADATA_SQL = "SELECT thread_id, created_at FROM thread_metadata WHERE id = 1";
export const FRONTIER_LAST_EVENT_SQL = "SELECT event_order, recorded_at FROM event ORDER BY event_order DESC LIMIT 1";
export const FRONTIER_VIEW_BOUNDARY_SQL = "SELECT position FROM view_boundary WHERE thread_singleton = 1";

/** Hard per-page row cap for the legacy prefix listing. */
export const LEGACY_KEY_PAGE_LIMIT = 200;
/** Named total cap on rows one cursor walk may traverse for a single prefix. */
export const LEGACY_KEY_TOTAL_LOOKUP_CAP = 2000;

function invalidBounds(reason: string): { ok: false; error: ErrorResult } {
  return { ok: false, error: { errorClass: "caller_error", code: "invalid_bounds", reason } };
}

/**
 * Least string strictly greater than every string carrying `prefix`.
 *
 * SQLite's BINARY collation compares UTF-8 bytes and UTF-8 byte order equals
 * code-point order, so incrementing the final code point — skipping the
 * surrogate gap, carrying past U+10FFFF — makes [prefix, upper) contain
 * exactly the prefixed keys. `undefined` means "no upper bound exists"
 * (prefix is all U+10FFFF); the range is then open-ended, which is still
 * exact because nothing sorts above it.
 */
export function prefixUpperBound(prefix: string): string | undefined {
  const points = Array.from(prefix);
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const codePoint = (points[i] as string).codePointAt(0) as number;
    if (codePoint >= 0x10ffff) continue; // carry into the previous position
    let next = codePoint + 1;
    if (next >= 0xd800 && next <= 0xdfff) next = 0xe000;
    return points.slice(0, i).join("") + String.fromCodePoint(next);
  }
  return undefined;
}

// A lone surrogate has no UTF-8 encoding, so it can never name a stored key
// and has no meaningful successor. Rust strings cannot hold one at all, so
// rejecting it here is what keeps the two ports' prefix contracts identical.
function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

// A prefix must be a non-empty, well-formed string: an empty prefix is the
// whole archive (listEvents' job, explicitly), and a lone surrogate has no
// UTF-8 encoding so it could never name a stored key.
function validatePrefix(prefix: string): ErrorResult | undefined {
  if (typeof prefix !== "string" || prefix.length === 0) {
    return invalidBounds("prefix must be a non-empty string; use listEvents for the full archive").error;
  }
  if (hasLoneSurrogate(prefix)) {
    return invalidBounds("prefix must be a well-formed string (no lone surrogates)").error;
  }
  return undefined;
}

function prefixRange(prefix: string): { lower: string; upper: string | undefined } {
  return { lower: prefix, upper: prefixUpperBound(prefix) };
}

export interface ThreadFrontierRow {
  threadId: string;
  createdAt: string;
  lastEventOrder: number;
  lastRecordedAt: string | null;
  viewBoundaryPosition: number;
}

export async function runThreadFrontier(threadRef: ThreadRef): Promise<OpResult<ThreadFrontierRow>> {
  const refFailure = validateThreadRef(threadRef);
  if (refFailure !== undefined) return { ok: false, error: refFailure };
  try {
    return await createDbReadTransaction(threadRef, (transaction) => {
      const metadata = transaction.db.prepare(FRONTIER_METADATA_SQL).get() as
        | { thread_id: string; created_at: string }
        | undefined;
      if (metadata === undefined) {
        throw new Error("thread_metadata row is missing");
      }
      const last = transaction.db.prepare(FRONTIER_LAST_EVENT_SQL).get() as
        | { event_order: number | bigint; recorded_at: string }
        | undefined;
      const boundary = transaction.db.prepare(FRONTIER_VIEW_BOUNDARY_SQL).get() as
        | { position: number | bigint }
        | undefined;
      return {
        threadId: metadata.thread_id,
        createdAt: metadata.created_at,
        // 0 on an empty archive — same origin as the recorded event counter.
        lastEventOrder: Number(last?.event_order ?? 0),
        lastRecordedAt: last?.recorded_at ?? null,
        viewBoundaryPosition: Number(boundary?.position ?? 0),
      };
    });
  } catch (cause) {
    return storageFailure(`thread frontier read failed: ${detail(cause)}`);
  }
}

export interface EventKeyPrefixCountRow {
  prefix: string;
  exists: boolean;
  count: number;
}

function prefixCountSql(bounded: boolean): string {
  return bounded
    ? "SELECT COUNT(*) AS matches FROM event WHERE idempotency_key >= ? AND idempotency_key < ?"
    : "SELECT COUNT(*) AS matches FROM event WHERE idempotency_key >= ?";
}

export async function runEventKeyPrefixCounts(
  threadRef: ThreadRef,
  prefixes: readonly string[],
): Promise<OpResult<EventKeyPrefixCountRow[]>> {
  const refFailure = validateThreadRef(threadRef);
  if (refFailure !== undefined) return { ok: false, error: refFailure };
  for (const prefix of prefixes) {
    const badPrefix = validatePrefix(prefix);
    if (badPrefix !== undefined) return { ok: false, error: badPrefix };
  }
  // Duplicates collapse to one queried, first-occurrence-ordered entry;
  // overlapping prefixes stay independent (a key under both is counted by
  // both), so the result is exactly one row per distinct input prefix.
  const distinct: string[] = [];
  const seen = new Set<string>();
  for (const prefix of prefixes) {
    if (seen.has(prefix)) continue;
    seen.add(prefix);
    distinct.push(prefix);
  }
  try {
    return await createDbReadTransaction(threadRef, (transaction) => {
      const bounded = transaction.db.prepare(prefixCountSql(true));
      const openEnded = transaction.db.prepare(prefixCountSql(false));
      return distinct.map((prefix) => {
        const { lower, upper } = prefixRange(prefix);
        const row = (upper === undefined ? openEnded.get(lower) : bounded.get(lower, upper)) as
          | { matches: number | bigint }
          | undefined;
        const count = Number(row?.matches ?? 0);
        return { prefix, exists: count > 0, count };
      });
    });
  } catch (cause) {
    return storageFailure(`event key prefix count failed: ${detail(cause)}`);
  }
}

export interface EventKeyRef {
  idempotencyKey: string;
  eventOrder: number;
}

export interface EventKeyPageResult {
  keys: EventKeyRef[];
  /** Opaque continuation token; null when the walk stopped for good. */
  cursor: string | null;
  /** True only when this page reached the end of the prefix at the walk's frontier. */
  complete: boolean;
  /** True when the total lookup cap stopped the walk short of the end. */
  capExhausted: boolean;
}

export interface EventKeyPageOptions {
  prefix: string;
  cursor?: string;
  limit?: number;
}

// ── Continuation cursor ────────────────────────────────────────────
//
// Wire form: "v1:<frontier>:<traversed>:<lastKey>" — version literal, decimal
// thread frontier, decimal traversed rank, raw key tail after the third
// colon. Identical to build and parse in either port.
//
// This is stateless database-consistency validation, not proof that this
// server issued the token and not an authorization boundary: the cursor
// carries no secret, no MAC, no persistent row and no cache. A continuation
// runs only when all three claims still agree with the database inside its
// own read transaction — the thread frontier is exactly the one the cursor
// names, the key is still present under the exact prefix, and its rank from
// the prefix start equals the traversed count. Stale, missing-key,
// count/rank-inconsistent, out-of-range and malformed tokens refuse as
// invalid_bounds. A database-consistent hand-built token is
// indistinguishable from an issued one and may choose any valid position at
// or below the cap, so callers must treat the token as opaque. The witness
// prevents stale or internally inconsistent continuation state and cap
// extension; it does not authenticate issuance, and it does not prove that
// the caller consumed every earlier row.
//
// Exact frontier equality is what keeps the walk honest under concurrent
// appends. Any append anywhere in the thread — a key sorting before the
// cursor's key, after it, or under an unrelated prefix — moves the frontier
// and makes every outstanding cursor stale. A stale cursor is refused
// visibly: never continued, never silently skipped past a new key, never
// reported as `complete`. The caller restarts the walk and sees the appends.
// That visible degradation is deliberate — it is what lets every statement
// below stay indexed, non-payload and hard-bounded, with no snapshot table,
// persistent cursor row or history-wide scan anywhere.
const KEY_CURSOR_VERSION = "v1";

// Largest integer both ports carry exactly (Number.MAX_SAFE_INTEGER, mirrored
// as an i64 bound in Rust) so a cursor integer decodes identically in each.
const MAX_EXACT_CURSOR_INTEGER = 9007199254740991;

/**
 * Thread frontier for one walk: the newest event order in the archive. An
 * index endpoint read (event_order is the rowid), one row, never a history
 * count. Page one stamps it into the cursor; a continuation must match it.
 */
export const KEY_WALK_FRONTIER_SQL = "SELECT event_order FROM event ORDER BY event_order DESC LIMIT 1";

/**
 * Bounded rank/existence witness for a continuation cursor.
 *
 * The inner LIMIT is bound to `KEY_CURSOR_WITNESS_LIMIT` — the total lookup
 * cap itself — so the statement examines at most that many indexed,
 * non-payload entries over one contiguous index range, never a history-wide
 * count.
 *
 * There is deliberately no `event_order` predicate. An accepted continuation
 * has already proven the frontier is unmoved, so no row outside the walk can
 * exist in this transaction; and an order filter would let arbitrarily many
 * newer keys interleave inside the range, forcing SQLite to examine and
 * reject them before the LIMIT could be satisfied. Dropping it is what makes
 * the examined-entry bound true, not just the returned-row bound.
 *
 * `rank` is the cursor key's exact 1-based position from the prefix start;
 * `last_key` equals the cursor key exactly when the key is still present and
 * its rank is inside the cap.
 *
 * No upper prefix bound is needed: `lastKey` carries the prefix, so every key
 * in [prefix, lastKey] carries it too.
 */
export const KEY_CURSOR_WITNESS_SQL = `SELECT COUNT(*) AS rank, MAX(idempotency_key) AS last_key FROM
     (SELECT idempotency_key FROM event
       WHERE idempotency_key >= ? AND idempotency_key <= ?
       ORDER BY idempotency_key ASC LIMIT ?)`;

/** The value bound to KEY_CURSOR_WITNESS_SQL's inner LIMIT: the total cap. */
export const KEY_CURSOR_WITNESS_LIMIT = LEGACY_KEY_TOTAL_LOOKUP_CAP;

interface KeyCursor {
  frontier: number;
  traversed: number;
  lastKey: string;
}

function encodeKeyCursor(frontier: number, traversed: number, lastKey: string): string {
  return `${KEY_CURSOR_VERSION}:${frontier}:${traversed}:${lastKey}`;
}

// Digits only, and inside the range both ports represent exactly: a value the
// other port could not hold is refused here rather than silently truncated.
function decodeCursorInteger(text: string): number | undefined {
  if (!/^[0-9]+$/.test(text)) return undefined;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_EXACT_CURSOR_INTEGER) return undefined;
  return value;
}

function decodeKeyCursor(cursor: string, prefix: string): KeyCursor | ErrorResult {
  const malformed = invalidBounds(`cursor is malformed: ${cursor}`).error;
  const version = cursor.indexOf(":");
  if (version < 0 || cursor.slice(0, version) !== KEY_CURSOR_VERSION) return malformed;
  const afterFrontier = cursor.indexOf(":", version + 1);
  if (afterFrontier < 0) return malformed;
  const afterTraversed = cursor.indexOf(":", afterFrontier + 1);
  if (afterTraversed < 0) return malformed;
  const frontier = decodeCursorInteger(cursor.slice(version + 1, afterFrontier));
  const traversed = decodeCursorInteger(cursor.slice(afterFrontier + 1, afterTraversed));
  if (frontier === undefined || traversed === undefined) return malformed;
  // A walk that returned nothing emits no cursor, and no walk may claim more
  // rows than the total cap allows.
  if (traversed < 1 || traversed > LEGACY_KEY_TOTAL_LOOKUP_CAP) {
    return invalidBounds(`cursor traversed count must be 1..${LEGACY_KEY_TOTAL_LOOKUP_CAP}, got ${traversed}`).error;
  }
  const lastKey = cursor.slice(afterTraversed + 1);
  if (!lastKey.startsWith(prefix)) {
    return invalidBounds("cursor belongs to a different prefix walk").error;
  }
  return { frontier, traversed, lastKey };
}

// Database witness for a decoded cursor, run inside the continuation's own
// read transaction. Refuses — never skips — on a frontier that has moved, a
// key absent under the prefix, a rank past the cap, or a rank that disagrees
// with the claimed traversed count.
//
// Work: one index-endpoint row for the frontier plus at most
// LEGACY_KEY_TOTAL_LOOKUP_CAP indexed, non-payload entries — never more than
// LEGACY_KEY_TOTAL_LOOKUP_CAP + 1 examined entries, whatever the archive size.
function witnessKeyCursor(
  db: DatabaseSync,
  prefix: string,
  cursor: KeyCursor,
  frontier: number,
): ErrorResult | undefined {
  // Exact equality, not `<=`: any append anywhere moves the frontier, and a
  // cursor issued before it no longer describes a walk over this archive.
  if (cursor.frontier !== frontier) {
    return invalidBounds(
      `cursor frontier ${cursor.frontier} does not match the thread frontier ${frontier}: restart the walk`,
    ).error;
  }
  const row = db.prepare(KEY_CURSOR_WITNESS_SQL).get(prefix, cursor.lastKey, KEY_CURSOR_WITNESS_LIMIT) as
    | { rank: number | bigint; last_key: string | null }
    | undefined;
  const rank = Number(row?.rank ?? 0);
  const witnessed = row?.last_key ?? null;
  if (witnessed !== cursor.lastKey) {
    if (rank >= LEGACY_KEY_TOTAL_LOOKUP_CAP) {
      return invalidBounds(
        `cursor rank exceeds LEGACY_KEY_TOTAL_LOOKUP_CAP (${LEGACY_KEY_TOTAL_LOOKUP_CAP}): ${cursor.lastKey}`,
      ).error;
    }
    return invalidBounds(`cursor key is not present under this prefix: ${cursor.lastKey}`).error;
  }
  if (rank !== cursor.traversed) {
    return invalidBounds(`cursor traversed count ${cursor.traversed} does not match its rank ${rank}`).error;
  }
  return undefined;
}

function pageSql(fromInclusive: boolean, bounded: boolean): string {
  const comparison = fromInclusive ? ">=" : ">";
  const upper = bounded ? " AND idempotency_key < ?" : "";
  // No event_order predicate, for the same reason the witness has none: a
  // continuation only runs on an unmoved frontier, so every row in range was
  // already there when the walk began, and an order filter would let newer
  // keys interleave into the range and be examined past the row LIMIT.
  return `SELECT idempotency_key, event_order FROM event
     WHERE idempotency_key ${comparison} ?${upper}
     ORDER BY idempotency_key ASC LIMIT ?`;
}

/** Exported for the structural bound assertions; not a caller surface. */
export const PAGE_SQL_SHAPES = [pageSql(true, true), pageSql(true, false), pageSql(false, true), pageSql(false, false)];

export async function runListEventKeysByPrefix(
  threadRef: ThreadRef,
  options: EventKeyPageOptions,
): Promise<OpResult<EventKeyPageResult>> {
  const refFailure = validateThreadRef(threadRef);
  if (refFailure !== undefined) return { ok: false, error: refFailure };
  const badPrefix = validatePrefix(options.prefix);
  if (badPrefix !== undefined) return { ok: false, error: badPrefix };
  // A limit above the hard page cap is refused, never silently clamped: a
  // caller that asked for more than the cap must see that it cannot have it.
  const limit = options.limit ?? LEGACY_KEY_PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    return invalidBounds(`limit must be an integer of at least 1, got ${limit}`);
  }
  if (limit > LEGACY_KEY_PAGE_LIMIT) {
    return invalidBounds(`limit must not exceed LEGACY_KEY_PAGE_LIMIT (${LEGACY_KEY_PAGE_LIMIT}), got ${limit}`);
  }
  let decoded: KeyCursor | undefined;
  if (options.cursor !== undefined) {
    const parsed = decodeKeyCursor(options.cursor, options.prefix);
    if ("errorClass" in parsed) return { ok: false, error: parsed };
    decoded = parsed;
  }
  const { lower, upper } = prefixRange(options.prefix);

  try {
    const outcome = await createDbReadTransaction(threadRef, (transaction): EventKeyPageResult | ErrorResult => {
      // Current frontier, read in this read transaction: page one stamps it
      // into the cursor, and every continuation must still match it exactly.
      const frontierRow = transaction.db.prepare(KEY_WALK_FRONTIER_SQL).get() as
        | { event_order: number | bigint }
        | undefined;
      const frontier = Number(frontierRow?.event_order ?? 0);
      let traversed = 0;
      let lastKey: string | undefined;
      if (decoded !== undefined) {
        const refusal = witnessKeyCursor(transaction.db, options.prefix, decoded, frontier);
        if (refusal !== undefined) return refusal;
        traversed = decoded.traversed;
        lastKey = decoded.lastKey;
      }
      const remaining = LEGACY_KEY_TOTAL_LOOKUP_CAP - traversed;
      if (remaining <= 0) {
        // Degraded truth: the walk is over, and it did not reach the end.
        return { keys: [], cursor: null, complete: false, capExhausted: true };
      }
      const pageSize = Math.min(limit, remaining);
      const statement = transaction.db.prepare(pageSql(lastKey === undefined, upper !== undefined));
      const from = lastKey ?? lower;
      // One extra row distinguishes "page full" from "prefix exhausted".
      const params: Array<string | number> = upper === undefined ? [from, pageSize + 1] : [from, upper, pageSize + 1];
      const rows = statement.all(...params) as unknown as Array<{
        idempotency_key: string;
        event_order: number | bigint;
      }>;
      const page = rows.slice(0, pageSize);
      const hasMore = rows.length > page.length;
      const keys = page.map((row) => ({
        idempotencyKey: row.idempotency_key,
        eventOrder: Number(row.event_order),
      }));
      const walked = traversed + keys.length;
      if (!hasMore) {
        // Complete: everything under the prefix at this frontier — which the
        // witness proved is still the current one — has been returned.
        return { keys, cursor: null, complete: true, capExhausted: false };
      }
      if (walked >= LEGACY_KEY_TOTAL_LOOKUP_CAP) {
        return { keys, cursor: null, complete: false, capExhausted: true };
      }
      const lastReturned = keys[keys.length - 1] as EventKeyRef;
      return {
        keys,
        cursor: encodeKeyCursor(frontier, walked, lastReturned.idempotencyKey),
        complete: false,
        capExhausted: false,
      };
    });
    if (!outcome.ok) return outcome;
    if ("errorClass" in outcome.value) return { ok: false, error: outcome.value };
    return { ok: true, value: outcome.value };
  } catch (cause) {
    return storageFailure(`event key prefix listing failed: ${detail(cause)}`);
  }
}
