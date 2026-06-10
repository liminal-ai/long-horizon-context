// Message and block row operations. Writes run on the caller's handle inside
// the batch transaction (insert failures propagate so the pipeline rejects
// the whole batch); reads run on a fresh handle per operation.
import type { DatabaseSync } from "node:sqlite";
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

  const messageRows = db
    .prepare(
      `SELECT message_id, source_event_order, kind, token_estimate, actor, harness, turn_id
       FROM message ORDER BY source_event_order`,
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
