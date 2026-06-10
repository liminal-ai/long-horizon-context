import type { PersistedThreadEvent } from "../schema.js";
import { projectEventToMessageDraft } from "../projection/event-to-message.js";
import type { MessageBlockRow, MessageRow } from "../sqlite/rows.js";
import type { ProjectedMessage, ProjectedMessageBlock, ProjectedMessageWithBlocks, StoreRuntime } from "../types.js";

export interface MaterializedMessageBatch {
  messages: ProjectedMessage[];
  blocks: ProjectedMessageBlock[];
}

export function materializeMessageRecords(
  runtime: StoreRuntime,
  events: readonly PersistedThreadEvent[],
): MaterializedMessageBatch {
  const messages: ProjectedMessage[] = [];
  const blocks: ProjectedMessageBlock[] = [];

  for (const event of events) {
    const existing = readMessageForSourceEvent(runtime, event.threadId, event.threadEventId);
    if (existing) {
      messages.push(existing);
      blocks.push(...readBlocksForMessage(runtime, existing.messageId));
      continue;
    }

    const draft = projectEventToMessageDraft(event);
    if (!draft) {
      continue;
    }

    const message: ProjectedMessage = {
      messageId: runtime.idGenerator(),
      threadId: event.threadId,
      messageOrder: nextMessageOrder(runtime, event.threadId),
      messageKind: draft.messageKind,
      actor: event.actor,
      status: "complete",
      createdAt: event.occurredAt ?? event.recordedAt,
      sourceEventId: event.threadEventId,
      sourceEventOrder: event.eventOrder,
    };

    const block: ProjectedMessageBlock = {
      blockId: runtime.idGenerator(),
      messageId: message.messageId,
      threadId: event.threadId,
      blockOrder: 1,
      blockKind: draft.blockKind,
      payload: draft.payload,
      sourceEventId: event.threadEventId,
      sourceEventOrder: event.eventOrder,
    };

    insertMessage(runtime, message);
    insertMessageBlock(runtime, block);
    messages.push(message);
    blocks.push(block);
  }

  return { messages, blocks };
}

export function readProjectedMessagesForThread(runtime: StoreRuntime, threadId: string): ProjectedMessageWithBlocks[] {
  const messageRows = runtime.db.db.prepare(`
    SELECT *
    FROM message
    WHERE thread_id = ?
    ORDER BY message_order ASC
  `).all(threadId) as unknown as MessageRow[];

  return messageRows.map((row) => {
    const message = rowToMessage(row);
    return {
      ...message,
      blocks: readBlocksForMessage(runtime, message.messageId),
    };
  });
}

function readMessageForSourceEvent(runtime: StoreRuntime, threadId: string, sourceEventId: string): ProjectedMessage | undefined {
  const row = runtime.db.db.prepare(`
    SELECT *
    FROM message
    WHERE thread_id = ? AND source_event_id = ?
  `).get(threadId, sourceEventId) as MessageRow | undefined;
  return row === undefined ? undefined : rowToMessage(row);
}

function readBlocksForMessage(runtime: StoreRuntime, messageId: string): ProjectedMessageBlock[] {
  const rows = runtime.db.db.prepare(`
    SELECT *
    FROM message_block
    WHERE message_id = ?
    ORDER BY block_order ASC
  `).all(messageId) as unknown as MessageBlockRow[];
  return rows.map(rowToBlock);
}

function nextMessageOrder(runtime: StoreRuntime, threadId: string): number {
  const row = runtime.db.db.prepare(`
    SELECT MAX(message_order) AS max_message_order
    FROM message
    WHERE thread_id = ?
  `).get(threadId) as { max_message_order: number | null } | undefined;
  return (row?.max_message_order ?? 0) + 1;
}

function insertMessage(runtime: StoreRuntime, message: ProjectedMessage): void {
  runtime.db.db.prepare(`
    INSERT INTO message (
      message_id,
      thread_id,
      message_order,
      message_kind,
      actor_json,
      status,
      created_at,
      source_event_id,
      source_event_order
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    message.messageId,
    message.threadId,
    message.messageOrder,
    message.messageKind,
    JSON.stringify(message.actor),
    message.status,
    message.createdAt,
    message.sourceEventId,
    message.sourceEventOrder,
  );
}

function insertMessageBlock(runtime: StoreRuntime, block: ProjectedMessageBlock): void {
  runtime.db.db.prepare(`
    INSERT INTO message_block (
      block_id,
      message_id,
      thread_id,
      block_order,
      block_kind,
      payload_json,
      source_event_id,
      source_event_order
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    block.blockId,
    block.messageId,
    block.threadId,
    block.blockOrder,
    block.blockKind,
    JSON.stringify(block.payload),
    block.sourceEventId,
    block.sourceEventOrder,
  );
}

function rowToMessage(row: MessageRow): ProjectedMessage {
  return {
    messageId: row.message_id,
    threadId: row.thread_id,
    messageOrder: row.message_order,
    messageKind: row.message_kind as ProjectedMessage["messageKind"],
    actor: JSON.parse(row.actor_json) as unknown,
    status: row.status as ProjectedMessage["status"],
    createdAt: row.created_at,
    sourceEventId: row.source_event_id,
    sourceEventOrder: row.source_event_order,
  };
}

function rowToBlock(row: MessageBlockRow): ProjectedMessageBlock {
  return {
    blockId: row.block_id,
    messageId: row.message_id,
    threadId: row.thread_id,
    blockOrder: row.block_order,
    blockKind: row.block_kind as ProjectedMessageBlock["blockKind"],
    payload: JSON.parse(row.payload_json) as ProjectedMessageBlock["payload"],
    sourceEventId: row.source_event_id,
    sourceEventOrder: row.source_event_order,
  };
}
