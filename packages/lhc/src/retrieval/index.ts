// Retrieval: deterministic drill-down from band labels to full content.
// `getTurns` serves rendered turns by turn id (`t…`); `getMessages` serves
// verbatim message content by message id (`m…`). Both enforce a per-call token
// budget with strict in-order serving (the first entity that does not fit stops
// the serve), return explicit receipts naming every unserved id, and write one
// impression row per requested id — the durable usage log that later ranking
// work reads. Retrieval never mutates record content; the only write is the
// impression log.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { OpResult } from "../shared-tech/errors.js";
import { createDbReadTransaction, createDbWriteTransaction, storageFailure } from "../shared-tech/index.js";
import { estimateTokens } from "../shared-tech/token-counting/index.js";
import type { ThreadRef } from "../threads/index.js";
import { composeRenderingInput, composeStructuredTurnText } from "../turns/internal/compose.js";
import { readMemberMessages, readMessageDerivationRows, readTurnSource } from "../turns/internal/derivations.js";

/** Whole-item budget for one retrieval call. Callers may override per call. */
export const DEFAULT_RETRIEVAL_TOKEN_BUDGET = 8_000;

export interface RetrievalOptions {
  /** Per-call token budget over served item text (estimateTokens). */
  tokenBudget?: number;
  /** Impression provenance: which surface asked (e.g. "get_turns" tool, "board"). */
  surface?: string;
}

export type UnservedReason = "not_found" | "deleted" | "budget" | "exceeds_budget";

export interface UnservedEntity {
  id: string;
  reason: UnservedReason;
  /** Known size when the entity exists but did not fit the budget. */
  tokens?: number;
}

export interface RetrievedTurn {
  turnId: string;
  /** Tagged rendering (`<tN>` wrap, `<mN>` message tags). */
  text: string;
  tokens: number;
  /** "stored" = ready turn_rendering derivation; "composed" = live fallback
   *  composition from current message forms (derivation not ready). */
  source: "stored" | "composed";
}

export interface RetrievedMessage {
  messageId: string;
  turnId: string;
  kind: string;
  /** Verbatim historical content (tool args/results as recorded). */
  text: string;
  tokens: number;
}

export interface RetrievalReceipt<TServed> {
  /** Correlates the impression rows this call wrote. */
  callId: string;
  served: TServed[];
  unserved: UnservedEntity[];
  totalTokens: number;
  tokenBudget: number;
}

interface ImpressionRow {
  entityKind: "turn" | "message";
  entityId: string;
  requestIdx: number;
  served: boolean;
  reason?: UnservedReason;
  tokens?: number;
}

function writeImpressions(db: DatabaseSync, callId: string, surface: string, rows: readonly ImpressionRow[]): void {
  const insert = db.prepare(
    `INSERT INTO retrieval_impression
       (call_id, surface, entity_kind, entity_id, request_idx, served, reason, tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    insert.run(
      callId,
      surface,
      row.entityKind,
      row.entityId,
      row.requestIdx,
      row.served ? 1 : 0,
      row.reason ?? null,
      row.tokens ?? null,
    );
  }
}

/** First occurrence wins; duplicate requests collapse to one serve/impression. */
function dedupe(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

interface Candidate<T> {
  id: string;
  outcome: { kind: "servable"; item: T; tokens: number } | { kind: "unservable"; reason: UnservedReason };
}

/** Strict in-order budget walk shared by both ops: not-found/deleted entities
 *  never charge the budget; the first servable item that does not fit stops
 *  the serve (remaining servable items report "budget" with their size). */
function budgetWalk<T>(
  candidates: readonly Candidate<T>[],
  entityKind: "turn" | "message",
  tokenBudget: number,
): { served: T[]; unserved: UnservedEntity[]; totalTokens: number; impressions: ImpressionRow[] } {
  const served: T[] = [];
  const unserved: UnservedEntity[] = [];
  const impressions: ImpressionRow[] = [];
  let totalTokens = 0;
  let stopped = false;
  candidates.forEach((candidate, requestIdx) => {
    const base = { entityId: candidate.id, requestIdx } as const;
    if (candidate.outcome.kind === "unservable") {
      unserved.push({ id: candidate.id, reason: candidate.outcome.reason });
      impressions.push({ ...base, entityKind, served: false, reason: candidate.outcome.reason });
      return;
    }
    const { item, tokens } = candidate.outcome;
    if (!stopped && totalTokens + tokens <= tokenBudget) {
      served.push(item);
      totalTokens += tokens;
      impressions.push({ ...base, entityKind, served: true, tokens });
      return;
    }
    stopped = true;
    const reason: UnservedReason = tokens > tokenBudget ? "exceeds_budget" : "budget";
    unserved.push({ id: candidate.id, reason, tokens });
    impressions.push({ ...base, entityKind, served: false, reason, tokens });
  });
  return { served, unserved, totalTokens, impressions };
}

function resolveBudget(options: RetrievalOptions | undefined): number {
  const budget = options?.tokenBudget ?? DEFAULT_RETRIEVAL_TOKEN_BUDGET;
  if (!Number.isFinite(budget) || budget <= 0) {
    throw new Error(`retrieval tokenBudget must be a positive number, got ${String(budget)}`);
  }
  return budget;
}

function turnCandidate(db: DatabaseSync, turnId: string): Candidate<RetrievedTurn> {
  const source = readTurnSource(db, turnId);
  if (source === undefined) return { id: turnId, outcome: { kind: "unservable", reason: "not_found" } };
  if (source.deleted) return { id: turnId, outcome: { kind: "unservable", reason: "deleted" } };

  const stored = db
    .prepare(
      `SELECT state, content FROM derivation
       WHERE subject_kind = 'turn' AND subject_id = ? AND derivation_type = 'turn_rendering'`,
    )
    .get(turnId) as { state: string; content: string | null } | undefined;

  if (stored?.state === "ready" && typeof stored.content === "string" && stored.content !== "") {
    const tokens = estimateTokens(stored.content);
    return {
      id: turnId,
      outcome: { kind: "servable", item: { turnId, text: stored.content, tokens, source: "stored" }, tokens },
    };
  }

  // Live fallback: compose from current message forms exactly like the
  // turn_derivation handler would (pure composition, no writes, no inference).
  const members = readMemberMessages(db, turnId);
  const derivations = readMessageDerivationRows(
    db,
    members.map((message) => message.messageId),
  );
  const { parts } = composeRenderingInput(members, derivations);
  const text = composeStructuredTurnText(parts, turnId);
  const tokens = estimateTokens(text);
  return { id: turnId, outcome: { kind: "servable", item: { turnId, text, tokens, source: "composed" }, tokens } };
}

interface MessageRow {
  message_id: string;
  turn_id: string;
  kind: string;
  deleted_at: string | null;
}

interface BlockRow {
  block_type: string;
  content: string;
}

/** Verbatim text of one message from its stored blocks — the historical
 *  artifact as recorded, not a summary. Tool blocks carry their pairing ids so
 *  calls and results stay matchable. */
function verbatimText(blocks: readonly BlockRow[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    const content = JSON.parse(block.content) as Record<string, unknown>;
    switch (block.block_type) {
      case "text": {
        parts.push(typeof content["text"] === "string" ? (content["text"] as string) : JSON.stringify(content));
        break;
      }
      case "tool_call": {
        const name = typeof content["toolName"] === "string" ? content["toolName"] : "tool";
        const callId = typeof content["toolCallId"] === "string" ? content["toolCallId"] : "";
        parts.push(
          `[tool_call ${name}${callId === "" ? "" : ` ${callId}`}]\n${JSON.stringify(content["arguments"], null, 2)}`,
        );
        break;
      }
      case "tool_result": {
        const callId = typeof content["toolCallId"] === "string" ? content["toolCallId"] : "";
        const isError = content["isError"] === true;
        const body = typeof content["content"] === "string" ? content["content"] : JSON.stringify(content["content"]);
        parts.push(`[tool_result${callId === "" ? "" : ` ${callId}`}${isError ? " ERROR" : ""}]\n${body}`);
        break;
      }
      default: {
        parts.push(`[${block.block_type}]\n${JSON.stringify(content, null, 2)}`);
        break;
      }
    }
  }
  return parts.join("\n");
}

function messageCandidate(db: DatabaseSync, messageId: string): Candidate<RetrievedMessage> {
  const row = db
    .prepare(`SELECT message_id, turn_id, kind, deleted_at FROM message WHERE message_id = ?`)
    .get(messageId) as MessageRow | undefined;
  if (row === undefined) return { id: messageId, outcome: { kind: "unservable", reason: "not_found" } };
  if (row.deleted_at !== null) return { id: messageId, outcome: { kind: "unservable", reason: "deleted" } };

  const blocks = db
    .prepare(`SELECT block_type, content FROM message_block WHERE message_id = ? ORDER BY block_index`)
    .all(messageId) as unknown as BlockRow[];
  const text = verbatimText(blocks);
  const tokens = estimateTokens(text);
  return {
    id: messageId,
    outcome: {
      kind: "servable",
      item: { messageId, turnId: row.turn_id, kind: row.kind, text, tokens },
      tokens,
    },
  };
}

/** Rendered turns by turn id, in request order, under a whole-item budget. */
export async function getTurns(
  ref: ThreadRef,
  turnIds: readonly string[],
  options?: RetrievalOptions,
): Promise<OpResult<RetrievalReceipt<RetrievedTurn>>> {
  return retrieve(ref, turnIds, options, "get_turns", "turn", turnCandidate);
}

/** Verbatim messages by message id, in request order, under a whole-item budget. */
export async function getMessages(
  ref: ThreadRef,
  messageIds: readonly string[],
  options?: RetrievalOptions,
): Promise<OpResult<RetrievalReceipt<RetrievedMessage>>> {
  return retrieve(ref, messageIds, options, "get_messages", "message", messageCandidate);
}

async function retrieve<T>(
  ref: ThreadRef,
  ids: readonly string[],
  options: RetrievalOptions | undefined,
  defaultSurface: string,
  entityKind: "turn" | "message",
  candidateOf: (db: DatabaseSync, id: string) => Candidate<T>,
): Promise<OpResult<RetrievalReceipt<T>>> {
  let tokenBudget: number;
  try {
    tokenBudget = resolveBudget(options);
  } catch (cause) {
    return storageFailure(cause instanceof Error ? cause.message : String(cause));
  }
  if (ids.length === 0) {
    return storageFailure(`${defaultSurface}: at least one id is required`);
  }
  const surface = options?.surface ?? defaultSurface;
  const callId = randomUUID();
  try {
    // Write transaction: the serve itself is a read, but every call logs
    // impressions — the durable usage record is part of the contract.
    return await createDbWriteTransaction(ref, (transaction) => {
      const candidates = dedupe(ids).map((id) => candidateOf(transaction.db, id));
      const walk = budgetWalk(candidates, entityKind, tokenBudget);
      writeImpressions(transaction.db, callId, surface, walk.impressions);
      return {
        callId,
        served: walk.served,
        unserved: walk.unserved,
        totalTokens: walk.totalTokens,
        tokenBudget,
      };
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return storageFailure(`${defaultSurface} failed: ${reason}`);
  }
}

/** Impression read-back (inspection/test seam; ranking work reads this later). */
export interface ImpressionRecord {
  callId: string;
  surface: string;
  entityKind: "turn" | "message";
  entityId: string;
  requestIdx: number;
  served: boolean;
  reason: string | null;
  tokens: number | null;
  recordedAt: string;
}

export async function listImpressions(ref: ThreadRef): Promise<OpResult<ImpressionRecord[]>> {
  try {
    return await createDbReadTransaction(ref, (transaction) => {
      const rows = transaction.db
        .prepare(
          `SELECT call_id, surface, entity_kind, entity_id, request_idx, served, reason, tokens, recorded_at
           FROM retrieval_impression ORDER BY impression_id`,
        )
        .all() as unknown as Array<{
        call_id: string;
        surface: string;
        entity_kind: "turn" | "message";
        entity_id: string;
        request_idx: number;
        served: number;
        reason: string | null;
        tokens: number | null;
        recorded_at: string;
      }>;
      return rows.map((row) => ({
        callId: row.call_id,
        surface: row.surface,
        entityKind: row.entity_kind,
        entityId: row.entity_id,
        requestIdx: row.request_idx,
        served: row.served === 1,
        reason: row.reason,
        tokens: row.tokens,
        recordedAt: row.recorded_at,
      }));
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return storageFailure(`impression read-back failed: ${reason}`);
  }
}
