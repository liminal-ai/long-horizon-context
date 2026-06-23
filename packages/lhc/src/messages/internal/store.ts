// Message and block row operations. Writes run on the caller's handle inside
// the batch transaction (insert failures propagate so the pipeline rejects
// the whole batch); reads run on a fresh handle per operation. Edit/delete
// validation and row applies also live here: row-level mechanics, no policy.
import type { DatabaseSync } from "node:sqlite";
import { estimateTokens } from "../../shared-tech/token-counting/index.js";
import type { Block, MessageRecord } from "../index.js";

export interface MessageRow {
  messageId: string;
  sourceEventOrder: number;
  kind: MessageRecord["kind"];
  tokenEstimate: number;
  actor: string;
  harness: string;
  // Membership stamp, settled at intake: the current open turn after turn
  // intake. Written once here, never updated.
  turnId: string;
  blocks: Block[];
}

export function insertMessage(db: DatabaseSync, row: MessageRow): void {
  db.prepare(
    `INSERT INTO message (message_id, source_event_order, kind, token_estimate, actor, harness, turn_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.messageId, row.sourceEventOrder, row.kind, row.tokenEstimate, row.actor, row.harness, row.turnId);

  const insertBlock = db.prepare(
    `INSERT INTO message_block (message_id, block_index, block_type, content)
     VALUES (?, ?, ?, ?)`,
  );
  for (const [index, block] of row.blocks.entries()) {
    insertBlock.run(row.messageId, index, block.blockType, JSON.stringify(block.content));
  }
}

// Mutation validation reads the live (deleted-filtered) message joined to its
// turn's status. A deleted target misses here and refuses as message_not_found:
// the filtered view is the refusal read by design, including double delete.
// turnStatus is null only when the stored membership references no readable
// turn; the closed-turn target boundary refuses it the same as an open turn.
// initiatesTurn carries the prompt-protection fact: with initial empty turns,
// the initiator is the first live member of a turn, not necessarily the turn's
// open event.
export interface MutableMessageView {
  messageId: string;
  kind: string;
  turnId: string;
  turnStatus: "open" | "closed" | null;
  initiatesTurn: boolean;
}

export function readMutableMessage(db: DatabaseSync, messageId: string): MutableMessageView | undefined {
  const row = db
    .prepare(
      `SELECT m.message_id, m.kind, m.turn_id, m.source_event_order,
              t.status AS turn_status,
              NOT EXISTS (
                SELECT 1 FROM message prior
                WHERE prior.turn_id = m.turn_id
                  AND prior.deleted_at IS NULL
                  AND prior.source_event_order < m.source_event_order
              ) AS is_first_member
       FROM message m LEFT JOIN turns t ON t.turn_id = m.turn_id
       WHERE m.message_id = ? AND m.deleted_at IS NULL`,
    )
    .get(messageId) as unknown as
    | {
        message_id: string;
        kind: string;
        turn_id: string;
        source_event_order: number | bigint;
        turn_status: string | null;
        is_first_member: number | bigint;
      }
    | undefined;
  if (row === undefined) return undefined;
  return {
    messageId: row.message_id,
    kind: row.kind,
    turnId: row.turn_id,
    turnStatus: row.turn_status as MutableMessageView["turnStatus"],
    initiatesTurn: Number(row.is_first_member) === 1,
  };
}

// Delete applies the message-record tombstone: the deleted_at stamp every
// normal message read filters on. Source events are never touched; event
// read-back keeps showing them.
export function markMessageDeleted(db: DatabaseSync, messageId: string, deletedAt: string): void {
  db.prepare(`UPDATE message SET deleted_at = ? WHERE message_id = ?`).run(deletedAt, messageId);
}

// Edit applies new content to each block's content-bearing field — the same
// field per block type that internal/project.ts wrote and counted — and the
// token estimate re-stamps from the same estimator, so placement arithmetic
// stays current after edits. Events are untouched; the log keeps the original.
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
  const update = db.prepare(`UPDATE message_block SET content = ? WHERE message_id = ? AND block_index = ?`);
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
        // verbatim as the new arguments value, mirroring projectEvent's
        // serialized-arguments estimate.
        parsed["arguments"] = content;
        tokenEstimate = estimateTokens(JSON.stringify(content));
        break;
      case "model_change":
        parsed["newModel"] = content;
        break;
      case "thinking_level_change":
        parsed["newLevel"] = content;
        break;
      default:
        throw new Error(`message ${messageId} carries unknown block type ${block.block_type}`);
    }
    update.run(JSON.stringify(parsed), messageId, Number(block.block_index));
  }
  db.prepare(`UPDATE message SET token_estimate = ? WHERE message_id = ?`).run(tokenEstimate, messageId);
}

interface RawMessageRow {
  message_id: string;
  source_event_order: number | bigint;
  kind: string;
  token_estimate: number | bigint;
  actor: string;
  harness: string;
  turn_id: string;
  deleted_at: string | null;
  // The source event's recorded_at, joined from the durable event row on
  // source_event_order = event_order (every message has exactly one source
  // event).
  recorded_at: string;
}

interface RawBlockRow {
  message_id: string;
  block_type: string;
  content: string;
}

function recordFromRow(row: RawMessageRow, blocks: Block[]): MessageRecord {
  const record: MessageRecord = {
    messageId: row.message_id,
    sourceEventOrder: Number(row.source_event_order),
    kind: row.kind as MessageRecord["kind"],
    blocks,
    tokenEstimate: Number(row.token_estimate),
    actor: row.actor,
    harness: row.harness,
    recordedAt: row.recorded_at,
    turnId: row.turn_id,
  };
  // The deleted marker is present only on deleted rows, which only the
  // includeDeleted read surfaces. It is never silently mixed into default reads.
  if (row.deleted_at !== null) record.deleted = true;
  return record;
}

// Bounds are in source-event-order coordinates: the coordinate the reports
// name, so drill-down uses what the operator already holds. limit caps the
// count after bounds. Defaults preserve visible messages, unbounded, in record
// order.
export interface MessageReadOptions {
  from?: number;
  to?: number;
  limit?: number;
  includeDeleted?: boolean;
}

export function readMessages(db: DatabaseSync, opts: MessageReadOptions = {}): MessageRecord[] {
  // Bounds before content: the message query carries the deleted filter, the
  // source-order window, and the limit, so a bounded list resolves its window
  // from the message table first. It never reads a row, or parses a block
  // below, outside that window.
  //
  // The deleted-read filter keeps default message reads to live rows only. A
  // deleted message's source events stay readable through event read-back, the
  // unfiltered audit surface. includeDeleted returns deleted rows flagged.
  const conditions: string[] = [];
  const params: number[] = [];
  if (opts.includeDeleted !== true) conditions.push("m.deleted_at IS NULL");
  if (opts.from !== undefined) {
    conditions.push("m.source_event_order >= ?");
    params.push(opts.from);
  }
  if (opts.to !== undefined) {
    conditions.push("m.source_event_order <= ?");
    params.push(opts.to);
  }
  if (opts.limit !== undefined) params.push(opts.limit);
  const messageRows = db
    .prepare(
      `SELECT m.message_id, m.source_event_order, m.kind, m.token_estimate, m.actor, m.harness,
              m.turn_id, m.deleted_at, e.recorded_at
       FROM message m JOIN event e ON e.event_order = m.source_event_order${conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY m.source_event_order${opts.limit !== undefined ? " LIMIT ?" : ""}`,
    )
    .all(...params) as unknown as RawMessageRow[];
  if (messageRows.length === 0) return [];

  // Block content only for the windowed messages — never the whole table:
  // an out-of-window block is never selected, so its content is never loaded
  // or parsed (the no-load-everything proof corrupts one to assert this).
  const ids = messageRows.map((row) => row.message_id);
  const blockRows = db
    .prepare(
      `SELECT message_id, block_type, content FROM message_block
       WHERE message_id IN (${ids.map(() => "?").join(", ")})
       ORDER BY message_id, block_index`,
    )
    .all(...ids) as unknown as RawBlockRow[];
  const blocksByMessage = new Map<string, Block[]>();
  for (const row of blockRows) {
    const blocks = blocksByMessage.get(row.message_id) ?? [];
    blocks.push({
      blockType: row.block_type as Block["blockType"],
      content: JSON.parse(row.content) as Record<string, unknown>,
    });
    blocksByMessage.set(row.message_id, blocks);
  }
  return messageRows.map((row) => recordFromRow(row, blocksByMessage.get(row.message_id) ?? []));
}

// The show operation's by-id read returns the canonical record: full blocks
// verbatim, never view-shortened, with the deleted flag honest. It is
// deliberately unfiltered on deleted_at: show on a deleted message is the audit
// read, never not-found.
export function readMessageById(
  db: DatabaseSync,
  messageId: string,
): (MessageRecord & { deleted: boolean }) | undefined {
  const row = db
    .prepare(
      `SELECT m.message_id, m.source_event_order, m.kind, m.token_estimate, m.actor, m.harness,
              m.turn_id, m.deleted_at, e.recorded_at
       FROM message m JOIN event e ON e.event_order = m.source_event_order
       WHERE m.message_id = ?`,
    )
    .get(messageId) as unknown as RawMessageRow | undefined;
  if (row === undefined) return undefined;
  const blockRows = db
    .prepare(
      `SELECT message_id, block_type, content FROM message_block
       WHERE message_id = ? ORDER BY block_index`,
    )
    .all(messageId) as unknown as RawBlockRow[];
  const blocks = blockRows.map((block) => ({
    blockType: block.block_type as Block["blockType"],
    content: JSON.parse(block.content) as Record<string, unknown>,
  }));
  return { ...recordFromRow(row, blocks), deleted: row.deleted_at !== null };
}
