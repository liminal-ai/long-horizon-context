import type { DatabaseSync } from "node:sqlite";
import type { TokenEstimator } from "../../shared-tech/token-counting/index.js";
import type { Block, MessageRecord } from "../index.js";

export interface MessageRow {
  messageId: string;
  sourceEventOrder: number;
  kind: MessageRecord["kind"];
  tokenEstimate: number;
  actor: string;
  harness: string;
  turnId: string;
  providerUsage?: Record<string, unknown>;
  stepIndex?: number;
  blocks: Block[];
}

export function insertMessage(db: DatabaseSync, row: MessageRow): void {
  db.prepare(
    `INSERT INTO message (message_id, source_event_order, kind, token_estimate, actor, harness, turn_id, provider_usage, step_index)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.messageId,
    row.sourceEventOrder,
    row.kind,
    row.tokenEstimate,
    row.actor,
    row.harness,
    row.turnId,
    row.providerUsage === undefined ? null : JSON.stringify(row.providerUsage),
    row.stepIndex === undefined ? null : row.stepIndex,
  );

  const insertBlock = db.prepare(
    `INSERT INTO message_block (message_id, block_index, block_type, content)
     VALUES (?, ?, ?, ?)`,
  );
  for (const [index, block] of row.blocks.entries()) {
    insertBlock.run(row.messageId, index, block.blockType, JSON.stringify(block.content));
  }
}

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

export function markMessageDeleted(db: DatabaseSync, messageId: string, deletedAt: string): void {
  db.prepare(`UPDATE message SET deleted_at = ? WHERE message_id = ?`).run(deletedAt, messageId);
}

export function applyMessageEdit(
  db: DatabaseSync,
  messageId: string,
  content: string,
  estimator: TokenEstimator,
): void {
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
  let tokenEstimate = estimator.rawCount(content);
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
        parsed["arguments"] = content;
        tokenEstimate = estimator.rawCount(JSON.stringify(content));
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
  provider_usage: string | null;
  step_index: number | bigint | null;
  deleted_at: string | null;
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
  if (row.provider_usage !== null) {
    record.providerUsage = JSON.parse(row.provider_usage) as Record<string, unknown>;
  }
  if (row.step_index !== null) record.stepIndex = Number(row.step_index);
  if (row.deleted_at !== null) record.deleted = true;
  return record;
}

export interface MessageReadOptions {
  from?: number;
  to?: number;
  limit?: number;
  includeDeleted?: boolean;
}

export function readMessages(db: DatabaseSync, opts: MessageReadOptions = {}): MessageRecord[] {
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
              m.turn_id, m.provider_usage, m.step_index, m.deleted_at, e.recorded_at
       FROM message m JOIN event e ON e.event_order = m.source_event_order${conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY m.source_event_order${opts.limit !== undefined ? " LIMIT ?" : ""}`,
    )
    .all(...params) as unknown as RawMessageRow[];
  if (messageRows.length === 0) return [];

  const ids = messageRows.map((row) => row.message_id);
  const blockRows: RawBlockRow[] = [];
  const blockReadBatchSize = 400;
  for (let offset = 0; offset < ids.length; offset += blockReadBatchSize) {
    const batch = ids.slice(offset, offset + blockReadBatchSize);
    const rows = db
      .prepare(
        `SELECT message_id, block_type, content FROM message_block
         WHERE message_id IN (${batch.map(() => "?").join(", ")})
         ORDER BY message_id, block_index`,
      )
      .all(...batch) as unknown as RawBlockRow[];
    blockRows.push(...rows);
  }
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

export function readMessageById(
  db: DatabaseSync,
  messageId: string,
): (MessageRecord & { deleted: boolean }) | undefined {
  const row = db
    .prepare(
      `SELECT m.message_id, m.source_event_order, m.kind, m.token_estimate, m.actor, m.harness,
              m.turn_id, m.provider_usage, m.step_index, m.deleted_at, e.recorded_at
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
