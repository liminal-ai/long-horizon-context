import type { TurnRow } from "../sqlite/rows.js";
import type { JsonObject } from "../schema.js";
import type { CanonicalTurn, StoreRuntime, TurnProcessingTrigger } from "../types.js";

export interface PersistTurnInput {
  trigger: TurnProcessingTrigger;
  turn: CanonicalTurn;
  startEventId: string;
  endEventId: string;
}

export function upsertTurnRecord(runtime: StoreRuntime, input: PersistTurnInput): CanonicalTurn {
  const existing = readTurnByTriggerId(runtime, input.trigger.triggerId);
  if (existing) {
    return existing;
  }

  runtime.db.db.prepare(`
    INSERT INTO turn (
      turn_id,
      thread_id,
      trigger_id,
      turn_order,
      lifecycle_status,
      processing_status,
      start_event_id,
      end_event_id,
      start_event_order,
      end_event_order,
      source_message_ids_json,
      smooth_json,
      lower_band_projection_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.turn.turnId,
    input.turn.threadId,
    input.trigger.triggerId,
    input.turn.turnOrder,
    input.turn.lifecycleStatus,
    input.turn.processingStatus,
    input.startEventId,
    input.endEventId,
    input.turn.sourceEventRange.start,
    input.turn.sourceEventRange.end,
    JSON.stringify(input.turn.sourceMessageIds),
    JSON.stringify(input.turn.smooth ?? {}),
    JSON.stringify(input.turn.lowerBandProjection ?? {}),
  );

  return input.turn;
}

export async function readTurnRecords(runtime: StoreRuntime, clientThreadId?: string): Promise<CanonicalTurn[]> {
  const rows = clientThreadId === undefined
    ? runtime.db.db.prepare(`SELECT * FROM turn ORDER BY thread_id ASC, turn_order ASC`).all() as unknown as TurnRow[]
    : runtime.db.db.prepare(`
        SELECT turn.*
        FROM turn
        JOIN thread ON thread.thread_id = turn.thread_id
        WHERE thread.client_thread_id = ?
        ORDER BY turn.turn_order ASC
      `).all(clientThreadId) as unknown as TurnRow[];
  return rows.map(rowToTurn);
}

export function readTurnByTriggerId(runtime: StoreRuntime, triggerId: string): CanonicalTurn | undefined {
  const row = runtime.db.db.prepare(`SELECT * FROM turn WHERE trigger_id = ?`).get(triggerId) as TurnRow | undefined;
  return row === undefined ? undefined : rowToTurn(row);
}

function rowToTurn(row: TurnRow): CanonicalTurn {
  return {
    turnId: row.turn_id,
    threadId: row.thread_id,
    turnOrder: row.turn_order,
    lifecycleStatus: row.lifecycle_status as CanonicalTurn["lifecycleStatus"],
    processingStatus: row.processing_status as CanonicalTurn["processingStatus"],
    sourceEventRange: { start: row.start_event_order, end: row.end_event_order },
    sourceMessageIds: JSON.parse(row.source_message_ids_json) as string[],
    smooth: JSON.parse(row.smooth_json) as JsonObject,
    lowerBandProjection: JSON.parse(row.lower_band_projection_json) as JsonObject,
  };
}
