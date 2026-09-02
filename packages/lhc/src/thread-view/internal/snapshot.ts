// Stored view snapshot reads and the one atomic compact writer. This module
// reads the snapshot header and bands, the live tail messages after the compact
// point, and the tail token sum. Direct record/derivation reads are contained
// to thread-view internals; status derivation counting still goes through the
// owners' report surfaces in index.ts.
import type { DatabaseSync } from "node:sqlite";
import type { Band, RenderingPartKind, StoredView } from "../../shared-tech/index.js";
import { readBoundaryPosition } from "./boundary.js";

// ── view snapshot (header + bands) ────────────────────────────────

export interface ViewSnapshot {
  viewId: string;
  createdAt: string;
  compactPoint: number;
  coveredFrom: number;
  gapCount: number;
  degradedCount: number;
  // Non-empty bands in gradient order (brief → detailed → smooth), the order
  // the serving assembly prepends them in.
  bands: Array<{ band: Band; renderedText: string; tokenCount: number }>;
}

interface RawViewRow {
  view_id: string;
  created_at: string;
  compact_point: number | bigint;
  covered_from: number | bigint;
  arrangement_json: string;
  gaps_json: string;
}

const BAND_GRADIENT_ORDER: readonly Band[] = ["brief", "detailed", "smooth"];

// null means no view exists (never compacted): the whole record renders as tail
// from event 1 through the same serving assembly path, snapshot-absent rather
// than a separate branch.
export function readViewSnapshot(db: DatabaseSync): ViewSnapshot | null {
  const header = db
    .prepare(
      `SELECT view_id, created_at, compact_point, covered_from, arrangement_json, gaps_json
       FROM thread_view WHERE singleton = 1`,
    )
    .get() as RawViewRow | undefined;
  if (header === undefined) return null;

  const arrangement = JSON.parse(header.arrangement_json) as Array<{ degraded?: boolean }>;
  const gaps = JSON.parse(header.gaps_json) as unknown[];
  const bandRows = db
    .prepare(`SELECT band, rendered_text, token_count FROM thread_view_band WHERE view_id = ?`)
    .all(header.view_id) as unknown as Array<{
    band: string;
    rendered_text: string;
    token_count: number | bigint;
  }>;
  const byBand = new Map(bandRows.map((row) => [row.band, row]));

  return {
    viewId: header.view_id,
    createdAt: header.created_at,
    compactPoint: Number(header.compact_point),
    coveredFrom: Number(header.covered_from),
    gapCount: gaps.length,
    degradedCount: arrangement.filter((entry) => entry.degraded === true).length,
    bands: BAND_GRADIENT_ORDER.flatMap((band) => {
      const row = byBand.get(band);
      return row === undefined ? [] : [{ band, renderedText: row.rendered_text, tokenCount: Number(row.token_count) }];
    }),
  };
}

// The full stored row for `describe`: everything compact wrote, parsed
// verbatim. Arrangement, gaps, config, source-state provenance, and per-band
// stored token counts are read from the snapshot, never recomputed.
export function readStoredView(db: DatabaseSync): StoredView | null {
  const header = db
    .prepare(
      `SELECT view_id, created_at, compact_point, covered_from, profile_name,
              config_json, arrangement_json, gaps_json, source_state_json
       FROM thread_view WHERE singleton = 1`,
    )
    .get() as
    | {
        view_id: string;
        created_at: string;
        compact_point: number | bigint;
        covered_from: number | bigint;
        profile_name: string | null;
        config_json: string;
        arrangement_json: string;
        gaps_json: string;
        source_state_json: string;
      }
    | undefined;
  if (header === undefined) return null;

  const bandRows = db
    .prepare(`SELECT band, token_count FROM thread_view_band WHERE view_id = ?`)
    .all(header.view_id) as unknown as Array<{ band: string; token_count: number | bigint }>;
  const byBand = new Map(bandRows.map((row) => [row.band, row]));

  return {
    viewId: header.view_id,
    createdAt: header.created_at,
    compactPoint: Number(header.compact_point),
    coveredFrom: Number(header.covered_from),
    profileName: header.profile_name,
    config: JSON.parse(header.config_json) as StoredView["config"],
    arrangement: JSON.parse(header.arrangement_json) as StoredView["arrangement"],
    gaps: JSON.parse(header.gaps_json) as StoredView["gaps"],
    sourceState: JSON.parse(header.source_state_json) as StoredView["sourceState"],
    bands: BAND_GRADIENT_ORDER.flatMap((band) => {
      const row = byBand.get(band);
      return row === undefined ? [] : [{ band, storedTokens: Number(row.token_count) }];
    }),
  };
}

// Turn parts: the installed view's transition turn — the one turn served as
// parts — with its part ranges in served order. Null when every served turn
// is whole (or no view exists). The one reader of "has this thread served
// parts" for the walk, the host metadata surface, and mechanism exclusivity.
/** One part's step range, in host step indices. */
export interface PartRange {
  fromStep: number;
  toStep: number;
}

export interface InstalledTransition {
  turnId: string;
  parts: PartRange[];
}

// The durable mechanism fact: when this thread first installed a view serving
// parts, or null if it never has. Outlives the parts themselves.
export function readPartsActivation(db: DatabaseSync): string | null {
  const row = db.prepare(`SELECT parts_activated_at FROM thread_metadata WHERE id = 1`).get() as
    | { parts_activated_at: string | null }
    | undefined;
  return row?.parts_activated_at ?? null;
}

export function readInstalledTransition(db: DatabaseSync): InstalledTransition | null {
  const stored = readStoredView(db);
  if (stored === null) return null;
  const partEntries = stored.arrangement.filter((entry) => entry.subjectKind === "turn" && entry.part !== undefined);
  const first = partEntries[0];
  if (first === undefined) return null;
  return {
    turnId: first.subjectId,
    parts: partEntries
      .filter((entry) => entry.subjectId === first.subjectId)
      .map((entry) => ({ fromStep: entry.part!.fromStep, toStep: entry.part!.toStep })),
  };
}

// ── tail record reads ─────────────────────────────────────────────

export interface TailMessageRow {
  messageId: string;
  sourceEventOrder: number;
  idempotencyKey: string | null;
  kind: RenderingPartKind;
  // The source event's recorded_at: materialize's entry timestamp. Generated
  // fields derive from record times, never write-time clocks.
  recordedAt: string;
  blocks: Array<{ blockType: string; content: Record<string, unknown> }>;
}

// Live messages after the compact point in record order, with their projected
// blocks. The deleted-read filter is applied here so a deleted message never
// reaches rendering.
export function readTailMessages(db: DatabaseSync, compactPoint: number): TailMessageRow[] {
  const messageRows = db
    .prepare(
      `SELECT m.message_id, m.source_event_order, m.kind, e.recorded_at, e.idempotency_key FROM message m
       JOIN event e ON e.event_order = m.source_event_order
       WHERE m.deleted_at IS NULL AND m.source_event_order > ?
       ORDER BY m.source_event_order`,
    )
    .all(compactPoint) as unknown as Array<{
    message_id: string;
    source_event_order: number | bigint;
    kind: string;
    recorded_at: string;
    idempotency_key: string;
  }>;
  const blockRows = db
    .prepare(
      `SELECT mb.message_id, mb.block_type, mb.content
       FROM message_block mb JOIN message m ON m.message_id = mb.message_id
       WHERE m.deleted_at IS NULL AND m.source_event_order > ?
       ORDER BY m.source_event_order, mb.block_index`,
    )
    .all(compactPoint) as unknown as Array<{
    message_id: string;
    block_type: string;
    content: string;
  }>;
  const blocksByMessage = new Map<string, TailMessageRow["blocks"]>();
  for (const row of blockRows) {
    const blocks = blocksByMessage.get(row.message_id) ?? [];
    blocks.push({
      blockType: row.block_type,
      content: JSON.parse(row.content) as Record<string, unknown>,
    });
    blocksByMessage.set(row.message_id, blocks);
  }
  return messageRows.map((row) => ({
    messageId: row.message_id,
    sourceEventOrder: Number(row.source_event_order),
    idempotencyKey: row.idempotency_key,
    kind: row.kind as RenderingPartKind,
    recordedAt: row.recorded_at,
    blocks: blocksByMessage.get(row.message_id) ?? [],
  }));
}

// The thread's identity row: materialize's header source. The header id derives
// from thread id + view created-at; a never-compacted thread's header uses the
// thread's created-at.
export function readThreadMetadata(db: DatabaseSync): { threadId: string; createdAt: string } {
  const row = db.prepare(`SELECT thread_id, created_at FROM thread_metadata WHERE id = 1`).get() as
    | { thread_id: string; created_at: string }
    | undefined;
  if (row === undefined) {
    throw new Error("thread_metadata singleton row missing (creation writes it)");
  }
  return { threadId: row.thread_id, createdAt: row.created_at };
}

// The tail's token sum for status: every live message after the compact point,
// all kinds. This is the same population the serving assembly renders as tail.
export function tailTokenSum(db: DatabaseSync, compactPoint: number): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(token_estimate), 0) AS total FROM message
       WHERE deleted_at IS NULL AND source_event_order > ?`,
    )
    .get(compactPoint) as { total: number | bigint };
  return Number(row.total);
}

// ── the atomic replace ───────────────────────────────────────────

export interface ViewReplaceInput {
  viewId: string;
  createdAt: string;
  compactPoint: number;
  coveredFrom: number;
  profileName: string | null;
  configJson: string;
  arrangementJson: string;
  gapsJson: string;
  sourceStateJson: string;
  bands: Array<{ band: Band; renderedText: string; tokenCount: number }>;
  /**
   * True when the arrangement carries a part entry. The first such install
   * records the thread's mechanism choice durably, in this same transaction:
   * once a thread has served parts it never takes the forced-boundary path,
   * whether or not the parts are still in the installed snapshot.
   */
  servesParts?: boolean;
  /**
   * Visibility boundary written in the same transaction as the view replace.
   * Omitted: compactPoint (compact's boundary reset). A proposed advance is
   * resolved forward against durable state inside this transaction — never
   * behind the current boundary, never behind the compact point — so a
   * proposal computed against state that has since moved lands on the nearest
   * legal position instead of failing the install.
   */
  visibilityBoundary?: number;
}

// Compact's one transaction: delete the singleton view row (the FK cascade
// drops its bands), insert the new header and bands, and reset the boundary
// to the compact point. All inside one BEGIN IMMEDIATE, so a crash anywhere
// rolls the whole replace back and the previous view keeps serving. Compact is
// the writer of view rows and the boundary reset on compact.
/**
 * Replace the serving view under one BEGIN IMMEDIATE.
 * `resolveInput` runs inside that transaction and produces what gets written,
 * so an installer that has to read durable state first — to see whether the
 * snapshot it was handed still describes the thread — observes and writes
 * under the same lock. There is no window between the two.
 */
export function replaceViewSnapshot(db: DatabaseSync, resolveInput: () => ViewReplaceInput): void {
  db.exec("BEGIN IMMEDIATE;");
  try {
    const input = resolveInput();
    db.prepare(`DELETE FROM thread_view WHERE singleton = 1`).run();
    db.prepare(
      `INSERT INTO thread_view (singleton, view_id, created_at, compact_point, covered_from,
         profile_name, config_json, arrangement_json, gaps_json, source_state_json)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.viewId,
      input.createdAt,
      input.compactPoint,
      input.coveredFrom,
      input.profileName,
      input.configJson,
      input.arrangementJson,
      input.gapsJson,
      input.sourceStateJson,
    );
    const insertBand = db.prepare(
      `INSERT INTO thread_view_band (view_id, band, rendered_text, token_count)
       VALUES (?, ?, ?, ?)`,
    );
    for (const band of input.bands) {
      insertBand.run(input.viewId, band.band, band.renderedText, band.tokenCount);
    }
    if (input.servesParts === true) {
      db.prepare(`UPDATE thread_metadata SET parts_activated_at = COALESCE(parts_activated_at, ?) WHERE id = 1`).run(
        input.createdAt,
      );
    }
    const boundaryPosition =
      input.visibilityBoundary === undefined
        ? input.compactPoint
        : Math.max(input.visibilityBoundary, readBoundaryPosition(db), input.compactPoint);
    db.prepare(`UPDATE view_boundary SET position = ?, updated_at = ? WHERE thread_singleton = 1`).run(
      boundaryPosition,
      input.createdAt,
    );
    db.exec("COMMIT;");
  } catch (cause) {
    db.exec("ROLLBACK;");
    throw cause;
  }
}
