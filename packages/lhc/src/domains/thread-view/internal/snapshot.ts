// The pull's read path (Story 1): the stored view snapshot — header plus
// band rows, absent ⇒ tail-only signal — and the record reads the tail
// assembly needs (live messages after the compact point, their ready
// tool-result summaries, the tail token sum). Reads only; the atomic
// replace at compact lands in Story 2. Direct record/derived_form reads are
// sanctioned for thread-view internals (tech design §System View — the
// surface-import rule governs code imports, not SQL); what must NOT read
// derived_form directly is the status's derivation counting, which goes
// through the owners' report surfaces in index.ts.
import type { DatabaseSync } from "node:sqlite";
import type { Band } from "../../../shared/view.js";
import type { RenderingPartKind } from "../../../shared/derivation.js";

// ── view snapshot (header + bands) ────────────────────────────────

export interface ViewSnapshot {
  viewId: string;
  createdAt: string;
  compactPoint: number;
  coveredFrom: number;
  gapCount: number;
  degradedCount: number;
  // Non-empty bands in gradient order (brief → detailed → smooth), the order
  // the pull prepends them in.
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

// null ⇒ no view exists (never compacted): the whole record renders as tail
// from event 1 through the same pull code path — snapshot-absent, not a
// separate branch (story Anti-Shim Requirements).
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
    .prepare(
      `SELECT band, rendered_text, token_count FROM thread_view_band WHERE view_id = ?`,
    )
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
      return row === undefined
        ? []
        : [{ band, renderedText: row.rendered_text, tokenCount: Number(row.token_count) }];
    }),
  };
}

// ── tail record reads ─────────────────────────────────────────────

export interface TailMessageRow {
  messageId: string;
  sourceEventOrder: number;
  kind: RenderingPartKind;
  blocks: Array<{ blockType: string; content: Record<string, unknown> }>;
}

// Live messages after the compact point in record order, with their projected
// blocks — the deleted-read filter applied here so a deleted message never
// reaches rendering (AC-1.x delete filtering).
export function readTailMessages(db: DatabaseSync, compactPoint: number): TailMessageRow[] {
  const messageRows = db
    .prepare(
      `SELECT message_id, source_event_order, kind FROM message
       WHERE deleted_at IS NULL AND source_event_order > ?
       ORDER BY source_event_order`,
    )
    .all(compactPoint) as unknown as Array<{
    message_id: string;
    source_event_order: number | bigint;
    kind: string;
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
    kind: row.kind as RenderingPartKind,
    blocks: blocksByMessage.get(row.message_id) ?? [],
  }));
}

// The tail's token sum for status (AC-2.8): every live message after the
// compact point, all kinds — the same population the pull renders as tail.
export function tailTokenSum(db: DatabaseSync, compactPoint: number): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(token_estimate), 0) AS total FROM message
       WHERE deleted_at IS NULL AND source_event_order > ?`,
    )
    .get(compactPoint) as { total: number | bigint };
  return Number(row.total);
}

// Ready tool-result summaries by message id — the short-form ladder's first
// rung. Stored state read verbatim, never derived here (no-inference rule).
export function readReadyToolResultSummaries(db: DatabaseSync): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT subject_id, content FROM derived_form
       WHERE subject_kind = 'message' AND form = 'tool_result_summary'
         AND state = 'ready' AND content IS NOT NULL`,
    )
    .all() as unknown as Array<{ subject_id: string; content: string }>;
  return new Map(rows.map((row) => [row.subject_id, row.content]));
}
