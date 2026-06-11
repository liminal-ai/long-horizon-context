// Message and block row operations. Writes run on the caller's handle inside
// the batch transaction (insert failures propagate so the pipeline rejects
// the whole batch); reads run on a fresh handle per operation. The mutation
// half (Epic 02 Story 5) — the edit's validation read and content apply —
// also lives here: row-level mechanics, no policy.
import type { DatabaseSync } from "node:sqlite";
import { estimateTokens } from "../../../tech-utils/token-counting/index.js";
import type { Block, MessageRecord } from "../index.js";

export interface MessageRow {
  messageId: string;
  sourceEventOrder: number;
  kind: MessageRecord["kind"];
  tokenEstimate: number;
  actor: string;
  harness: string;
  // Membership stamp, settled at intake: the turn open after this event's
  // transition, or null in a gap. Written once here, never updated — a null
  // gap stamp stays null forever (AC-3.8), a closed turn's members never
  // change (AC-3.7).
  turnId: string | null;
  blocks: Block[];
}

export function insertMessage(db: DatabaseSync, row: MessageRow): void {
  db.prepare(
    `INSERT INTO message (message_id, source_event_order, kind, token_estimate, actor, harness, turn_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.messageId,
    row.sourceEventOrder,
    row.kind,
    row.tokenEstimate,
    row.actor,
    row.harness,
    row.turnId,
  );

  const insertBlock = db.prepare(
    `INSERT INTO message_block (message_id, block_index, block_type, content)
     VALUES (?, ?, ?, ?)`,
  );
  for (const [index, block] of row.blocks.entries()) {
    insertBlock.run(row.messageId, index, block.blockType, JSON.stringify(block.content));
  }
}

// The mutation operations' validation read (Flows 5/6): the live
// (deleted-filtered) message joined to its turn's status. A deleted target
// misses here and refuses as message_not_found — the filtered view is the
// refusal's read by design (never a distinct error for deleted; double
// delete reads the same way, AC-6.7). turnStatus is null for a gap message
// (no membership); the closed-turn target boundary refuses it the same as
// an open turn. initiatesTurn carries the prompt-protection fact (AC-6.3):
// a turn opens on its prompt's event, so the member whose source event
// order equals the turn's opened-at order is the turn's initiating prompt.
export interface MutableMessageView {
  messageId: string;
  kind: string;
  turnId: string | null;
  turnStatus: "open" | "closed" | null;
  initiatesTurn: boolean;
}

export function readMutableMessage(
  db: DatabaseSync,
  messageId: string,
): MutableMessageView | undefined {
  const row = db
    .prepare(
      `SELECT m.message_id, m.kind, m.turn_id, m.source_event_order,
              t.status AS turn_status, t.opened_at_event_order
       FROM message m LEFT JOIN turns t ON t.turn_id = m.turn_id
       WHERE m.message_id = ? AND m.deleted_at IS NULL`,
    )
    .get(messageId) as unknown as
    | {
        message_id: string;
        kind: string;
        turn_id: string | null;
        source_event_order: number | bigint;
        turn_status: string | null;
        opened_at_event_order: number | bigint | null;
      }
    | undefined;
  if (row === undefined) return undefined;
  return {
    messageId: row.message_id,
    kind: row.kind,
    turnId: row.turn_id,
    turnStatus: row.turn_status as MutableMessageView["turnStatus"],
    initiatesTurn:
      row.opened_at_event_order !== null &&
      Number(row.source_event_order) === Number(row.opened_at_event_order),
  };
}

// The delete's record apply (Flow 6): a projection-level tombstone — the
// deleted_at stamp every read filters on. The source events are never
// touched (record-never-destroyed, DD-12); event read-back keeps showing
// them. The bulk variant is turns.deleteTurn's member stamp, scoped to live
// rows so a turn whose messages were individually deleted first still
// deletes cleanly (membership walk on live rows); it returns the stamped
// ids in record order for the mutation result and the cascade's drop set.
export function markMessageDeleted(
  db: DatabaseSync,
  messageId: string,
  deletedAt: string,
): void {
  db.prepare(`UPDATE message SET deleted_at = ? WHERE message_id = ?`).run(
    deletedAt,
    messageId,
  );
}

export function markTurnMessagesDeleted(
  db: DatabaseSync,
  turnId: string,
  deletedAt: string,
): string[] {
  const rows = db
    .prepare(
      `UPDATE message SET deleted_at = ?
       WHERE turn_id = ? AND deleted_at IS NULL
       RETURNING message_id, source_event_order`,
    )
    .all(deletedAt, turnId) as unknown as Array<{
    message_id: string;
    source_event_order: number | bigint;
  }>;
  return rows
    .sort((a, b) => Number(a.source_event_order) - Number(b.source_event_order))
    .map((row) => row.message_id);
}

// The edit's record apply (AC-5.1): the new content lands in each block's
// content-bearing field — the same field per block type the projection wrote
// and counted (internal/project.ts) — and the token estimate re-stamps from
// the same estimator, so placement arithmetic stays current after edits.
// Events are untouched: this is projection-level mutation; the log keeps the
// original (DD-12).
export function applyMessageEdit(db: DatabaseSync, messageId: string, content: string): void {
  const blocks = db
    .prepare(
      `SELECT block_index, block_type, content FROM message_block
       WHERE message_id = ? ORDER BY block_index`,
    )
    .all(messageId) as unknown as Array<{
    block_index: number | bigint;
    block_type: string;
    content: string;
  }>;
  const update = db.prepare(
    `UPDATE message_block SET content = ? WHERE message_id = ? AND block_index = ?`,
  );
  let tokenEstimate = estimateTokens(content);
  for (const block of blocks) {
    const parsed = JSON.parse(block.content) as Record<string, unknown>;
    switch (block.block_type) {
      case "text":
        parsed["text"] = content;
        break;
      case "tool_result":
        parsed["content"] = content;
        break;
      case "tool_call":
        // Arguments are the call's counted content; the edit's string lands
        // verbatim as the new arguments value, mirroring projection's
        // serialized-arguments estimate.
        parsed["arguments"] = content;
        tokenEstimate = estimateTokens(JSON.stringify(content));
        break;
      default:
        throw new Error(`message ${messageId} carries unknown block type ${block.block_type}`);
    }
    update.run(JSON.stringify(parsed), messageId, Number(block.block_index));
  }
  db.prepare(`UPDATE message SET token_estimate = ? WHERE message_id = ?`).run(
    tokenEstimate,
    messageId,
  );
}

interface RawMessageRow {
  message_id: string;
  source_event_order: number | bigint;
  kind: string;
  token_estimate: number | bigint;
  actor: string;
  harness: string;
  turn_id: string | null;
}

interface RawBlockRow {
  message_id: string;
  block_type: string;
  content: string;
}

export function readMessages(db: DatabaseSync): MessageRecord[] {
  const blockRows = db
    .prepare(
      `SELECT message_id, block_type, content FROM message_block
       ORDER BY message_id, block_index`,
    )
    .all() as unknown as RawBlockRow[];
  const blocksByMessage = new Map<string, Block[]>();
  for (const row of blockRows) {
    const blocks = blocksByMessage.get(row.message_id) ?? [];
    blocks.push({
      blockType: row.block_type as Block["blockType"],
      content: JSON.parse(row.content) as Record<string, unknown>,
    });
    blocksByMessage.set(row.message_id, blocks);
  }

  // The deleted-read filter (tech design §Mechanics): message reads surface
  // live projection rows only; a deleted message's source events stay
  // readable through the Epic 01 event read-back, the one unfiltered surface.
  const messageRows = db
    .prepare(
      `SELECT message_id, source_event_order, kind, token_estimate, actor, harness, turn_id
       FROM message WHERE deleted_at IS NULL ORDER BY source_event_order`,
    )
    .all() as unknown as RawMessageRow[];
  return messageRows.map((row) => {
    const record: MessageRecord = {
      messageId: row.message_id,
      sourceEventOrder: Number(row.source_event_order),
      kind: row.kind as MessageRecord["kind"],
      blocks: blocksByMessage.get(row.message_id) ?? [],
      tokenEstimate: Number(row.token_estimate),
      actor: row.actor,
      harness: row.harness,
    };
    if (row.turn_id !== null) record.turnId = row.turn_id;
    return record;
  });
}
