/**
 * Durable proof of a pending correlated tool call/result pair in the open tail.
 * Host correlationValid is necessary but not sufficient.
 */

import type { DatabaseSync } from "node:sqlite";
import { readOpenTurnIds } from "./store.js";

export type ToolPairProof =
  | {
      ok: true;
      toolCallId: string;
      callMessageId: string;
      resultMessageId: string;
      callEventOrder: number;
      resultEventOrder: number;
      turnId: string;
      resultContent: string;
    }
  | {
      ok: false;
      reason:
        | "no_single_open_turn"
        | "call_missing"
        | "result_missing"
        | "orphaned_call"
        | "orphaned_result"
        | "duplicate_call"
        | "duplicate_result"
        | "call_after_result"
        | "wrong_turn"
        | "not_in_open_tail"
        | "unreadable_payload";
      detail: string;
    };

/**
 * Prove exactly one live tool_call and one matching live tool_result for
 * toolCallId in the current open turn's uncompacted tail (after compact point).
 */
export function provePendingToolPair(db: DatabaseSync, toolCallId: string): ToolPairProof {
  const openIds = readOpenTurnIds(db);
  if (openIds.length !== 1) {
    return {
      ok: false,
      reason: "no_single_open_turn",
      detail: `expected exactly one open turn, found ${openIds.length}`,
    };
  }
  const turnId = openIds[0]!;

  const compactPointRow = db.prepare(`SELECT compact_point FROM thread_view WHERE singleton = 1`).get() as
    | { compact_point: number | bigint }
    | undefined;
  const compactPoint = compactPointRow === undefined ? 0 : Number(compactPointRow.compact_point);

  const callRows = db
    .prepare(
      `SELECT m.message_id, m.source_event_order, m.turn_id, b.content
       FROM message m
       JOIN message_block b ON b.message_id = m.message_id AND b.block_type = 'tool_call'
       WHERE m.deleted_at IS NULL
         AND m.kind = 'tool_call'
         AND json_extract(b.content, '$.toolCallId') = ?
       ORDER BY m.source_event_order`,
    )
    .all(toolCallId) as unknown as Array<{
    message_id: string;
    source_event_order: number | bigint;
    turn_id: string;
    content: string;
  }>;

  const resultRows = db
    .prepare(
      `SELECT m.message_id, m.source_event_order, m.turn_id, b.content
       FROM message m
       JOIN message_block b ON b.message_id = m.message_id AND b.block_type = 'tool_result'
       WHERE m.deleted_at IS NULL
         AND m.kind = 'tool_result'
         AND json_extract(b.content, '$.toolCallId') = ?
       ORDER BY m.source_event_order`,
    )
    .all(toolCallId) as unknown as Array<{
    message_id: string;
    source_event_order: number | bigint;
    turn_id: string;
    content: string;
  }>;

  if (callRows.length === 0 && resultRows.length === 0) {
    return { ok: false, reason: "call_missing", detail: `no live tool_call or tool_result for ${toolCallId}` };
  }
  if (callRows.length === 0) {
    return { ok: false, reason: "orphaned_result", detail: `tool_result without tool_call for ${toolCallId}` };
  }
  if (resultRows.length === 0) {
    return { ok: false, reason: "orphaned_call", detail: `tool_call without tool_result for ${toolCallId}` };
  }
  if (callRows.length > 1) {
    return { ok: false, reason: "duplicate_call", detail: `${callRows.length} live tool_call rows for ${toolCallId}` };
  }
  if (resultRows.length > 1) {
    return {
      ok: false,
      reason: "duplicate_result",
      detail: `${resultRows.length} live tool_result rows for ${toolCallId}`,
    };
  }

  const call = callRows[0]!;
  const result = resultRows[0]!;
  const callOrder = Number(call.source_event_order);
  const resultOrder = Number(result.source_event_order);

  if (call.turn_id !== turnId || result.turn_id !== turnId) {
    return {
      ok: false,
      reason: "wrong_turn",
      detail: `pair not both on open turn ${turnId} (call=${call.turn_id}, result=${result.turn_id})`,
    };
  }
  if (callOrder <= compactPoint || resultOrder <= compactPoint) {
    return {
      ok: false,
      reason: "not_in_open_tail",
      detail: `pair not both after compact point ${compactPoint} (call=${callOrder}, result=${resultOrder})`,
    };
  }
  if (callOrder >= resultOrder) {
    return {
      ok: false,
      reason: "call_after_result",
      detail: `tool_call event ${callOrder} must precede tool_result event ${resultOrder}`,
    };
  }

  let resultContent: string;
  try {
    const parsed = JSON.parse(result.content) as { content?: unknown };
    if (typeof parsed.content !== "string") {
      return { ok: false, reason: "unreadable_payload", detail: "tool_result content is not a string" };
    }
    resultContent = parsed.content;
    const callParsed = JSON.parse(call.content) as { toolCallId?: unknown };
    if (callParsed.toolCallId !== toolCallId) {
      return { ok: false, reason: "unreadable_payload", detail: "tool_call payload toolCallId mismatch" };
    }
  } catch {
    return { ok: false, reason: "unreadable_payload", detail: "failed to parse tool pair block JSON" };
  }

  return {
    ok: true,
    toolCallId,
    callMessageId: call.message_id,
    resultMessageId: result.message_id,
    callEventOrder: callOrder,
    resultEventOrder: resultOrder,
    turnId,
    resultContent,
  };
}
