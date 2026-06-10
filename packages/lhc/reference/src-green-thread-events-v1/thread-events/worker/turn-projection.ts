import { countLocalTokens, localTokenizerMetadataFields } from "../../token-counting/local-token-counter.js";
import type { JsonObject, PersistedThreadEvent } from "../schema.js";
import type { EventRow, MessageBlockRow, MessageRow } from "../sqlite/rows.js";
import { rowToPersistedEvent } from "../persistence/threads.js";
import type { CanonicalTurn, ProjectedMessageBlock, StoreRuntime, TurnProcessingTrigger } from "../types.js";

export interface TurnProjectionDraft {
  turn: CanonicalTurn;
  startEvent: PersistedThreadEvent;
  endEvent: PersistedThreadEvent;
}

export async function buildTurnProjectionDraft(runtime: StoreRuntime, trigger: TurnProcessingTrigger): Promise<TurnProjectionDraft | undefined> {
  const endEvent = readEventById(runtime, trigger.turnEndEventId);
  if (!endEvent) {
    return undefined;
  }
  const startEvent = findInitiatingPrompt(runtime, endEvent.threadId, endEvent.eventOrder);
  if (!startEvent) {
    return undefined;
  }

  const messages = readMessageRowsInRange(runtime, endEvent.threadId, startEvent.eventOrder, endEvent.eventOrder);
  const sourceMessageIds = messages.map((message) => message.message_id);
  const blocks = readBlockRowsForMessages(runtime, sourceMessageIds);
  const smoothText = renderSmoothTranscript(messages, blocks);
  const lowerBandText = renderLowerBandProjection(messages, blocks);
  const turnId = deterministicTurnId(endEvent.threadId, endEvent.eventOrder);
  const lowerBandProjection = await buildLowerBandProjection(runtime, endEvent.threadId, turnId, lowerBandText);
  const processingStatus = lowerBandProjection.status === "ready" ? "ready" : "failed";

  return {
    startEvent,
    endEvent,
    turn: {
      turnId,
      threadId: endEvent.threadId,
      turnOrder: nextTurnOrder(runtime, endEvent.threadId),
      lifecycleStatus: "closed",
      processingStatus,
      sourceEventRange: { start: startEvent.eventOrder, end: endEvent.eventOrder },
      sourceMessageIds,
      smooth: {
        status: "ready",
        text: smoothText,
        tokenCountMetadata: {
          count: countLocalTokens(smoothText),
          ...localTokenizerMetadataFields(),
        },
      },
      lowerBandProjection,
    },
  };
}

function readEventById(runtime: StoreRuntime, eventId: string): PersistedThreadEvent | undefined {
  const row = runtime.db.db.prepare(`SELECT * FROM event WHERE thread_event_id = ?`).get(eventId) as EventRow | undefined;
  return row === undefined ? undefined : rowToPersistedEvent(row);
}

function findInitiatingPrompt(runtime: StoreRuntime, threadId: string, turnEndEventOrder: number): PersistedThreadEvent | undefined {
  const row = runtime.db.db.prepare(`
    SELECT *
    FROM event
    WHERE thread_id = ?
      AND event_order < ?
      AND event_kind IN ('user_prompt', 'turn_end')
    ORDER BY event_order DESC
    LIMIT 1
  `).get(threadId, turnEndEventOrder) as EventRow | undefined;
  if (row?.event_kind !== "user_prompt") {
    return undefined;
  }
  return rowToPersistedEvent(row);
}

function readMessageRowsInRange(runtime: StoreRuntime, threadId: string, startEventOrder: number, endEventOrder: number): MessageRow[] {
  return runtime.db.db.prepare(`
    SELECT *
    FROM message
    WHERE thread_id = ?
      AND source_event_order >= ?
      AND source_event_order < ?
    ORDER BY message_order ASC
  `).all(threadId, startEventOrder, endEventOrder) as unknown as MessageRow[];
}

function readBlockRowsForMessages(runtime: StoreRuntime, messageIds: readonly string[]): MessageBlockRow[] {
  if (messageIds.length === 0) {
    return [];
  }
  const placeholders = messageIds.map(() => "?").join(", ");
  return runtime.db.db.prepare(`
    SELECT *
    FROM message_block
    WHERE message_id IN (${placeholders})
    ORDER BY source_event_order ASC, block_order ASC
  `).all(...messageIds) as unknown as MessageBlockRow[];
}

function renderSmoothTranscript(messages: readonly MessageRow[], blocks: readonly MessageBlockRow[]): string {
  const blocksByMessage = groupBlocksByMessage(blocks);
  const lines: string[] = [];
  for (const message of messages) {
    const label = message.message_kind;
    for (const block of blocksByMessage.get(message.message_id) ?? []) {
      const text = blockText(block);
      if (text.length > 0) {
        lines.push(`${label}: ${text}`);
      }
    }
  }
  return lines.join("\n\n");
}

function renderLowerBandProjection(messages: readonly MessageRow[], blocks: readonly MessageBlockRow[]): string {
  const messageKindById = new Map(messages.map((message) => [message.message_id, message.message_kind]));
  const lines: string[] = [];
  for (const block of blocks) {
    const messageKind = messageKindById.get(block.message_id);
    if (block.block_kind !== "text" || (messageKind !== "user" && messageKind !== "assistant")) {
      continue;
    }
    const text = blockText(block);
    if (text.length > 0) {
      lines.push(`${messageKind === "user" ? ">" : "●"} ${text}`);
    }
  }
  return lines.join("\n\n");
}

async function buildLowerBandProjection(runtime: StoreRuntime, threadId: string, turnId: string, text: string): Promise<JsonObject> {
  if (text.length === 0) {
    return { status: "invalid", text, errorCode: "LOWER_BAND_PROJECTION_EMPTY" };
  }
  if (!runtime.options.lowerBandProjectionTokenCounter) {
    return {
      status: "failed",
      text,
      errorCode: "LOWER_BAND_PROJECTION_TOKEN_COUNTER_MISSING",
      tokenCountMetadata: {
        count: countLocalTokens(text),
        ...localTokenizerMetadataFields(),
      },
    };
  }
  const counted = await runtime.options.lowerBandProjectionTokenCounter.countTurnLowerBandProjection({ threadId, turnId, text });
  return {
    status: "ready",
    text,
    tokenCountMetadata: {
      count: counted.count,
      ...(counted.metadata ?? {}),
    },
  };
}

function nextTurnOrder(runtime: StoreRuntime, threadId: string): number {
  const row = runtime.db.db.prepare(`SELECT MAX(turn_order) AS max_turn_order FROM turn WHERE thread_id = ?`).get(threadId) as { max_turn_order: number | null } | undefined;
  return (row?.max_turn_order ?? 0) + 1;
}

function blockText(block: MessageBlockRow): string {
  const payload = JSON.parse(block.payload_json) as ProjectedMessageBlock["payload"];
  if (typeof payload.text === "string") {
    return payload.text;
  }
  if (typeof payload.encryptedContent === "string") {
    return "[encrypted reasoning]";
  }
  if (block.block_kind === "tool_call" && typeof payload.toolName === "string") {
    return `tool call ${payload.toolName}`;
  }
  return "";
}

function groupBlocksByMessage(blocks: readonly MessageBlockRow[]): Map<string, MessageBlockRow[]> {
  const grouped = new Map<string, MessageBlockRow[]>();
  for (const block of blocks) {
    const existing = grouped.get(block.message_id) ?? [];
    existing.push(block);
    grouped.set(block.message_id, existing);
  }
  return grouped;
}

function deterministicTurnId(threadId: string, endEventOrder: number): string {
  return `turn_${threadId}_${endEventOrder}`.replace(/[^a-zA-Z0-9_-]/g, "_");
}
