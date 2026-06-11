// Turn-domain reads for derivation (Flow 3): the turn handler's view of its
// source turn, the member messages it composes (deleted-filtered — the
// shared read-filter rule lives here, once for this domain), the
// message-level form rows composition consumes, and the member projections
// the chunk summaries read. Completion writes for turn- and chunk-owned
// forms ride the work-queue util's `complete` (UPDATE-only, version-checked)
// — no write path here.
import type { DatabaseSync } from "node:sqlite";
import type { RenderingPartKind, ToolRunReceipt } from "../../../shared/derivation.js";
import type { ComposeFormRow, ComposeMessage } from "./compose.js";
import { composeFormKey } from "./compose.js";
import type { FormKind } from "../../../shared/derivation.js";

export interface TurnSource {
  turnId: string;
  status: "open" | "closed";
  deleted: boolean;
}

export function readTurnSource(db: DatabaseSync, turnId: string): TurnSource | undefined {
  const row = db
    .prepare(`SELECT status, deleted_at FROM turns WHERE turn_id = ?`)
    .get(turnId) as unknown as { status: string; deleted_at: string | null } | undefined;
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

// The message-owned form rows for a set of member messages, keyed for
// composition. A cross-owner *read* by design: composition consumes message
// forms; only message handlers ever write them (DD-2 ownership is a write
// rule).
export function readMessageFormRows(
  db: DatabaseSync,
  messageIds: readonly string[],
): Map<string, ComposeFormRow> {
  const rows = new Map<string, ComposeFormRow>();
  if (messageIds.length === 0) return rows;
  const placeholders = messageIds.map(() => "?").join(", ");
  const raw = db
    .prepare(
      `SELECT subject_id, form, state, content, metadata FROM derived_form
       WHERE subject_kind = 'message' AND subject_id IN (${placeholders})`,
    )
    .all(...messageIds) as unknown as Array<{
    subject_id: string;
    form: string;
    state: string;
    content: string | null;
    metadata: string | null;
  }>;
  for (const row of raw) {
    const view: ComposeFormRow = { state: row.state as ComposeFormRow["state"] };
    if (row.content !== null) view.content = row.content;
    if (row.metadata !== null) {
      view.metadata = JSON.parse(row.metadata) as NonNullable<ComposeFormRow["metadata"]>;
    }
    rows.set(composeFormKey(row.subject_id, row.form as FormKind), view);
  }
  return rows;
}

// Member projections in turn order for the chunk summaries: member rows by
// member_idx, deleted turns filtered, each joined to its stored
// lower_band_projection row (state + content as landed — never re-derived)
// and to its turn_rendering's mechanically stamped tool-run receipts
// (AC-3.8: the detailed summary's receipt material, read not re-derived).
export interface MemberProjection {
  turnId: string;
  state?: string; // undefined: no projection row exists for the member
  content?: string;
  receipts: ToolRunReceipt[]; // empty when the member turn had no tool activity
}

export function readMemberProjections(db: DatabaseSync, chunkId: string): MemberProjection[] {
  const rows = db
    .prepare(
      `SELECT cm.turn_id, df.state, df.content, rf.metadata AS rendering_metadata
       FROM chunk_member cm
       JOIN turns t ON t.turn_id = cm.turn_id AND t.deleted_at IS NULL
       LEFT JOIN derived_form df ON df.subject_kind = 'turn'
         AND df.subject_id = cm.turn_id AND df.form = 'lower_band_projection'
       LEFT JOIN derived_form rf ON rf.subject_kind = 'turn'
         AND rf.subject_id = cm.turn_id AND rf.form = 'turn_rendering'
       WHERE cm.chunk_id = ? ORDER BY cm.member_idx`,
    )
    .all(chunkId) as unknown as Array<{
    turn_id: string;
    state: string | null;
    content: string | null;
    rendering_metadata: string | null;
  }>;
  return rows.map((row) => {
    const metadata =
      row.rendering_metadata === null
        ? undefined
        : (JSON.parse(row.rendering_metadata) as { receipts?: ToolRunReceipt[] });
    const projection: MemberProjection = {
      turnId: row.turn_id,
      receipts: metadata?.receipts ?? [],
    };
    if (row.state !== null) projection.state = row.state;
    if (row.content !== null) projection.content = row.content;
    return projection;
  });
}

export function chunkExists(db: DatabaseSync, chunkId: string): boolean {
  return (
    db.prepare(`SELECT 1 FROM chunk WHERE chunk_id = ?`).get(chunkId) !== undefined
  );
}
