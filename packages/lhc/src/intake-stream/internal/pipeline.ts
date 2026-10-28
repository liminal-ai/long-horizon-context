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
import {
  applyRollback,
  create as createTurn,
  RollbackAnchorError,
  TurnStateCorruptionError,
} from "../../turns/index.js";
import type { BatchResult, EventRecord, MessageEventInput } from "../index.js";
import { extractPayloadBlobs } from "./blobs.js";
import { validateEvents, validateThreadRef } from "./validate.js";

export type IntakeWalkHook = (db: DatabaseSync, eventIndex: number) => void;
let walkHook: IntakeWalkHook | null = null;
export function setIntakeWalkHook(hook: IntakeWalkHook | null): void {
  walkHook = hook;
}

let injectedClock: (() => Date) | null = null;
export function setIntakeClock(clock: (() => Date) | null): void {
  injectedClock = clock;
}

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

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
        let lastOrder = maxEventOrder(transaction.db);

        const insert = transaction.db.prepare(
          `INSERT INTO event (event_order, event_kind, idempotency_key, actor, harness, payload, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        const insertBlob = transaction.db.prepare(
          `INSERT OR IGNORE INTO blob (sha256, media_type, byte_length, data, created_at) VALUES (?, ?, ?, ?, ?)`,
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
            const { payload, blobs } = extractPayloadBlobs(event.payload);
            for (const blob of blobs)
              insertBlob.run(blob.sha256, blob.mediaType, blob.data.byteLength, blob.data, recordedAt);
            insert.run(
              lastOrder,
              event.eventKind,
              event.idempotencyKey,
              event.actor,
              event.harness,
              JSON.stringify(payload),
              recordedAt,
            );
            skipSet.add(event.idempotencyKey);
            const recordedEvent = {
              ...event,
              payload,
              eventOrder: lastOrder,
              recordedAt,
            } as typeof event & { eventOrder: number; recordedAt: string };
            if (recordedEvent.eventKind === "rollback") {
              const outcome = applyRollback(transaction, recordedEvent);
              queuedItems.push(...outcome.queuedWork);
              eventResults.push({ idempotencyKey: event.idempotencyKey, outcome: "recorded" });
            } else {
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
    if (cause instanceof TurnStateCorruptionError || cause instanceof RollbackAnchorError) {
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

export const FRONTIER_METADATA_SQL = "SELECT thread_id, created_at FROM thread_metadata WHERE id = 1";
export const FRONTIER_LAST_EVENT_SQL = "SELECT event_order, recorded_at FROM event ORDER BY event_order DESC LIMIT 1";
export const FRONTIER_VIEW_BOUNDARY_SQL = "SELECT position FROM view_boundary WHERE thread_singleton = 1";

export const LEGACY_KEY_PAGE_LIMIT = 200;
export const LEGACY_KEY_TOTAL_LOOKUP_CAP = 2000;

function invalidBounds(reason: string): { ok: false; error: ErrorResult } {
  return { ok: false, error: { errorClass: "caller_error", code: "invalid_bounds", reason } };
}

export function prefixUpperBound(prefix: string): string | undefined {
  const points = Array.from(prefix);
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const codePoint = (points[i] as string).codePointAt(0) as number;
    if (codePoint >= 0x10ffff) continue;
    let next = codePoint + 1;
    if (next >= 0xd800 && next <= 0xdfff) next = 0xe000;
    return points.slice(0, i).join("") + String.fromCodePoint(next);
  }
  return undefined;
}

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
  cursor: string | null;
  complete: boolean;
  capExhausted: boolean;
}

export interface EventKeyPageOptions {
  prefix: string;
  cursor?: string;
  limit?: number;
}

const KEY_CURSOR_VERSION = "v1";

const MAX_EXACT_CURSOR_INTEGER = 9007199254740991;

export const KEY_WALK_FRONTIER_SQL = "SELECT event_order FROM event ORDER BY event_order DESC LIMIT 1";

export const KEY_CURSOR_WITNESS_SQL = `SELECT COUNT(*) AS rank, MAX(idempotency_key) AS last_key FROM
     (SELECT idempotency_key FROM event
       WHERE idempotency_key >= ? AND idempotency_key <= ?
       ORDER BY idempotency_key ASC LIMIT ?)`;

export const KEY_CURSOR_WITNESS_LIMIT = LEGACY_KEY_TOTAL_LOOKUP_CAP;

interface KeyCursor {
  frontier: number;
  traversed: number;
  lastKey: string;
}

function encodeKeyCursor(frontier: number, traversed: number, lastKey: string): string {
  return `${KEY_CURSOR_VERSION}:${frontier}:${traversed}:${lastKey}`;
}

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
  if (traversed < 1 || traversed > LEGACY_KEY_TOTAL_LOOKUP_CAP) {
    return invalidBounds(`cursor traversed count must be 1..${LEGACY_KEY_TOTAL_LOOKUP_CAP}, got ${traversed}`).error;
  }
  const lastKey = cursor.slice(afterTraversed + 1);
  if (!lastKey.startsWith(prefix)) {
    return invalidBounds("cursor belongs to a different prefix walk").error;
  }
  return { frontier, traversed, lastKey };
}

function witnessKeyCursor(
  db: DatabaseSync,
  prefix: string,
  cursor: KeyCursor,
  frontier: number,
): ErrorResult | undefined {
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
  return `SELECT idempotency_key, event_order FROM event
     WHERE idempotency_key ${comparison} ?${upper}
     ORDER BY idempotency_key ASC LIMIT ?`;
}

export const PAGE_SQL_SHAPES = [pageSql(true, true), pageSql(true, false), pageSql(false, true), pageSql(false, false)];

export async function runListEventKeysByPrefix(
  threadRef: ThreadRef,
  options: EventKeyPageOptions,
): Promise<OpResult<EventKeyPageResult>> {
  const refFailure = validateThreadRef(threadRef);
  if (refFailure !== undefined) return { ok: false, error: refFailure };
  const badPrefix = validatePrefix(options.prefix);
  if (badPrefix !== undefined) return { ok: false, error: badPrefix };
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
        return { keys: [], cursor: null, complete: false, capExhausted: true };
      }
      const pageSize = Math.min(limit, remaining);
      const statement = transaction.db.prepare(pageSql(lastKey === undefined, upper !== undefined));
      const from = lastKey ?? lower;
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
