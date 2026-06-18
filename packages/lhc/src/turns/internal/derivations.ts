// Turn-domain reads for derivation (Flow 3): the turn handler's view of its
// source turn, the member messages it composes (deleted-filtered — the
// shared read-filter rule lives here, once for this domain), the
// message-level derivation rows composition consumes, and the member projections
// the chunk summaries read. Completion writes for turn- and chunk-owned
// derivations ride the work-queue util's `complete` (UPDATE-only, version-checked)
// — no write path here.
import type { DatabaseSync } from "node:sqlite";
import type {
  DependencyGap,
  Derivation,
  DerivationMetadata,
  DerivationReportEntry,
  DerivationState,
  RenderingPartKind,
  SubjectKind,
  ToolRunReceipt,
} from "../../shared-tech/index.js";
import { type RawReportRow, reportEntryFromRow } from "../../shared-tech/index.js";
import type { ComposeDerivationRow, ComposeMessage } from "./compose.js";
import { composeDerivationKey } from "./compose.js";

export interface TurnSource {
  turnId: string;
  status: "open" | "closed";
  deleted: boolean;
}

export function readTurnSource(db: DatabaseSync, turnId: string): TurnSource | undefined {
  const row = db.prepare(`SELECT status, deleted_at FROM turns WHERE turn_id = ?`).get(turnId) as unknown as
    | { status: string; deleted_at: string | null }
    | undefined;
  if (row === undefined) return undefined;
  return {
    turnId,
    status: row.status as TurnSource["status"],
    deleted: row.deleted_at !== null,
  };
}

// Member messages in message order, blocks attached, deleted messages
// filtered (tech design §Mechanics: composition's member enumeration reads
// the live projection only).
export function readMemberMessages(db: DatabaseSync, turnId: string): ComposeMessage[] {
  const messages = db
    .prepare(
      `SELECT message_id, kind FROM message
       WHERE turn_id = ? AND deleted_at IS NULL ORDER BY source_event_order`,
    )
    .all(turnId) as unknown as Array<{ message_id: string; kind: string }>;
  const blockStmt = db.prepare(
    `SELECT block_type, content FROM message_block
     WHERE message_id = ? ORDER BY block_index`,
  );
  return messages.map((message) => {
    const blocks = blockStmt.all(message.message_id) as unknown as Array<{
      block_type: string;
      content: string;
    }>;
    return {
      messageId: message.message_id,
      kind: message.kind as RenderingPartKind,
      blocks: blocks.map((block) => ({
        blockType: block.block_type,
        content: JSON.parse(block.content) as Record<string, unknown>,
      })),
    };
  });
}

// The message-owned derivation rows for a set of member messages, keyed for
// composition. A cross-owner *read* by design: composition consumes message
// derivations; only message handlers ever write them (DD-2 ownership is a write
// rule).
export function readMessageDerivationRows(
  db: DatabaseSync,
  messageIds: readonly string[],
): Map<string, ComposeDerivationRow> {
  const rows = new Map<string, ComposeDerivationRow>();
  if (messageIds.length === 0) return rows;
  const placeholders = messageIds.map(() => "?").join(", ");
  const raw = db
    .prepare(
      `SELECT subject_id, derivation_type, state, content, reason, metadata, source_version
       FROM derivation
       WHERE subject_kind = 'message' AND subject_id IN (${placeholders})`,
    )
    .all(...messageIds) as unknown as Array<{
    subject_id: string;
    derivation_type: string;
    state: string;
    content: string | null;
    reason: string | null;
    metadata: string | null;
    source_version: number | bigint;
  }>;
  for (const row of raw) {
    const view: ComposeDerivationRow = {
      state: row.state as ComposeDerivationRow["state"],
      sourceVersion: Number(row.source_version),
    };
    if (row.content !== null) view.content = row.content;
    if (row.reason !== null) view.reason = row.reason;
    if (row.metadata !== null) {
      view.metadata = JSON.parse(row.metadata) as NonNullable<ComposeDerivationRow["metadata"]>;
    }
    rows.set(composeDerivationKey(row.subject_id, row.derivation_type as string), view);
  }
  return rows;
}

// Member projections in turn order for the chunk summaries: every
// chunk_member row by member_idx, each joined to its canonical turn, stored
// smooth_turn_compression row (state + content as landed — never re-derived),
// and turn_rendering's mechanically stamped tool-run receipts (AC-3.8: the
// detailed summary's receipt material, read not re-derived). Missing turns
// are returned as source corruption so background summaries block instead of
// silently summarizing a shortened member list; SDK soft-deleted turns stay
// filtered because sanctioned delete rebuilds chunk summaries from survivors.
export interface MemberProjection {
  turnId: string;
  state?: string; // undefined: no projection row exists for the member
  content?: string;
  receipts: ToolRunReceipt[]; // empty when the member turn had no tool activity
  sourceCorruptionReason?: string;
}

export function readMemberProjections(db: DatabaseSync, chunkId: string): MemberProjection[] {
  const rows = db
    .prepare(
      `SELECT cm.turn_id, t.turn_id AS existing_turn_id, t.deleted_at,
              df.state, df.content, rf.metadata AS rendering_metadata
       FROM chunk_member cm
       LEFT JOIN turns t ON t.turn_id = cm.turn_id
       LEFT JOIN derivation df ON df.subject_kind = 'turn'
         AND df.subject_id = cm.turn_id AND df.derivation_type = 'smooth_turn_compression'
       LEFT JOIN derivation rf ON rf.subject_kind = 'turn'
         AND rf.subject_id = cm.turn_id AND rf.derivation_type = 'turn_rendering'
       WHERE cm.chunk_id = ? ORDER BY cm.member_idx`,
    )
    .all(chunkId) as unknown as Array<{
    turn_id: string;
    state: string | null;
    content: string | null;
    rendering_metadata: string | null;
    existing_turn_id: string | null;
    deleted_at: string | null;
  }>;
  return rows.flatMap((row) => {
    if (row.deleted_at !== null) return [];
    const metadata =
      row.rendering_metadata === null
        ? undefined
        : (JSON.parse(row.rendering_metadata) as { receipts?: ToolRunReceipt[] });
    const projection: MemberProjection = {
      turnId: row.turn_id,
      receipts: metadata?.receipts ?? [],
    };
    if (row.existing_turn_id === null) {
      projection.sourceCorruptionReason = `canonical record corrupt: chunk ${chunkId} member ${row.turn_id} references missing turn`;
    }
    if (row.state !== null) projection.state = row.state;
    if (row.content !== null) projection.content = row.content;
    return [projection];
  });
}

interface RawOwnedDerivationRow {
  subject_id: string;
  derivation_type: string;
  state: string;
  content: string | null;
  reason: string | null;
  metadata: string | null;
  source_version: number | bigint;
  gaps: string | null;
  derived_at: string | null;
}

// Every derivation row this owner holds for one subject kind, grouped by subject
// id — the derivation read-back joined onto turn and chunk reads (AC-4.7's
// "record with derivation states", mirroring messages.readMessageDerivations). Rows come
// back exactly as the pipeline landed them; nothing is derived at read time.
export function readOwnedDerivations(db: DatabaseSync, subjectKind: "turn" | "chunk"): Map<string, Derivation[]> {
  const rows = db
    .prepare(
      `SELECT subject_id, derivation_type, state, content, reason, metadata,
              source_version, gaps, derived_at
       FROM derivation WHERE subject_kind = ?
       ORDER BY subject_id, derivation_type`,
    )
    .all(subjectKind) as unknown as RawOwnedDerivationRow[];
  const bySubject = new Map<string, Derivation[]>();
  for (const row of rows) {
    const record: Derivation = {
      subjectKind,
      subjectId: row.subject_id,
      derivationType: row.derivation_type as string,
      state: row.state as DerivationState,
      sourceVersion: Number(row.source_version),
    };
    if (row.content !== null) record.content = row.content;
    if (row.reason !== null) record.reason = row.reason;
    if (row.metadata !== null) {
      record.metadata = JSON.parse(row.metadata) as DerivationMetadata;
    }
    if (row.gaps !== null) record.gaps = JSON.parse(row.gaps) as DependencyGap[];
    if (row.derived_at !== null) record.derivedAt = row.derived_at;
    const derivations = bySubject.get(row.subject_id) ?? [];
    derivations.push(record);
    bySubject.set(row.subject_id, derivations);
  }
  return bySubject;
}

// Chunk read-back rows for the listChunks surface: stored chunk state plus
// live (deleted-filtered) membership in member order.
export interface ChunkReadRow {
  chunkId: string;
  chunkOrder: number;
  status: "open" | "closed";
  accumulatedProjectedTokens: number;
  memberTurnIds: string[];
}

export function readChunkRows(db: DatabaseSync): ChunkReadRow[] {
  const chunks = db
    .prepare(
      `SELECT chunk_id, chunk_order, status, accumulated_projected_tokens
       FROM chunk ORDER BY chunk_order`,
    )
    .all() as unknown as Array<{
    chunk_id: string;
    chunk_order: number | bigint;
    status: string;
    accumulated_projected_tokens: number | bigint;
  }>;
  const memberStmt = db.prepare(
    `SELECT cm.turn_id FROM chunk_member cm
     JOIN turns t ON t.turn_id = cm.turn_id AND t.deleted_at IS NULL
     WHERE cm.chunk_id = ? ORDER BY cm.member_idx`,
  );
  return chunks.map((row) => ({
    chunkId: row.chunk_id,
    chunkOrder: Number(row.chunk_order),
    status: row.status as "open" | "closed",
    accumulatedProjectedTokens: Number(row.accumulated_projected_tokens),
    memberTurnIds: (memberStmt.all(row.chunk_id) as unknown as Array<{ turn_id: string }>).map(
      (member) => member.turn_id,
    ),
  }));
}

// One derivation row by exact key for this owner's subjects — the requeue
// operation's refusal read (missing row, blocked state, current version).
export function readTurnDerivationRow(
  db: DatabaseSync,
  subjectKind: "turn" | "chunk",
  subjectId: string,
  derivation: string,
): { state: DerivationState; reason?: string; sourceVersion: number } | undefined {
  const row = db
    .prepare(
      `SELECT state, reason, source_version FROM derivation
       WHERE subject_kind = ? AND subject_id = ? AND derivation_type = ?`,
    )
    .get(subjectKind, subjectId, derivation) as unknown as
    | { state: string; reason: string | null; source_version: number | bigint }
    | undefined;
  if (row === undefined) return undefined;
  const view: { state: DerivationState; reason?: string; sourceVersion: number } = {
    state: row.state as DerivationState,
    sourceVersion: Number(row.source_version),
  };
  if (row.reason !== null) view.reason = row.reason;
  return view;
}

// The turns owner's report (Flow 4): one query over turn- and chunk-owned
// derivation rows LEFT JOINed with the live work_item targeting each derivation at its
// current source version. Both turn derivations map to the one turn_derivation
// kind; the chunk summary derivations map to their same-named kinds — the CASE is
// this owner's queue-site mapping inverted, mirroring the messages report.
export function reportTurnDerivations(
  db: DatabaseSync,
  opts: { notReady?: boolean; turnId?: string; chunkId?: string } = {},
): DerivationReportEntry[] {
  const conditions = ["df.subject_kind IN ('turn', 'chunk')"];
  const params: string[] = [];
  const subjectFilters: string[] = [];
  if (opts.turnId !== undefined) {
    subjectFilters.push("(df.subject_kind = 'turn' AND df.subject_id = ?)");
    params.push(opts.turnId);
  }
  if (opts.chunkId !== undefined) {
    subjectFilters.push("(df.subject_kind = 'chunk' AND df.subject_id = ?)");
    params.push(opts.chunkId);
  }
  if (subjectFilters.length > 0) conditions.push(`(${subjectFilters.join(" OR ")})`);
  // notReady is exact set equality by construction: every state but ready.
  if (opts.notReady === true) conditions.push("df.state <> 'ready'");
  const rows = db
    .prepare(
      `SELECT df.subject_kind, df.subject_id, df.derivation_type, df.state, df.content, df.reason,
              df.metadata, df.source_version, df.gaps, df.derived_at,
              w.status AS queue_status, w.attempts AS queue_attempts,
              w.last_error AS queue_last_error, w.eligible_at AS queue_eligible_at
       FROM derivation df
       LEFT JOIN work_item w
         ON w.status IN ('queued', 'claimed')
        AND w.kind = CASE WHEN df.subject_kind = 'turn' THEN 'turn_derivation' ELSE df.derivation_type END
        AND json_extract(
              w.source_ref,
              CASE WHEN df.subject_kind = 'turn' THEN '$.turnId' ELSE '$.chunkId' END
            ) = df.subject_id
        AND COALESCE(json_extract(w.payload, '$.sourceVersion'), 1) = df.source_version
       WHERE ${conditions.join(" AND ")}
       ORDER BY df.subject_kind DESC, df.subject_id, df.derivation_type`,
    )
    .all(...params) as unknown as Array<RawReportRow & { subject_kind: string }>;
  return rows.map((row) => reportEntryFromRow(row.subject_kind as SubjectKind, row));
}

export function chunkExists(db: DatabaseSync, chunkId: string): boolean {
  return db.prepare(`SELECT 1 FROM chunk WHERE chunk_id = ?`).get(chunkId) !== undefined;
}
