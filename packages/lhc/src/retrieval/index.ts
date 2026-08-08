// Retrieval: deterministic drill-down from band labels to full content.
// `getTurns` serves rendered turns by turn id (`t…`); `getMessages` serves
// verbatim message content by message id (`m…`). Both enforce a per-call token
// budget with in-order serving. Oversized content is not refused: the item
// that crosses the budget is served as an exact token slice with a receipt
// (`slice`) naming the window and total, so the caller can continue via
// `fromToken`. Later ids past a spent budget get explicit "budget" receipts.
// Every requested id writes one impression row — the durable usage log that
// later ranking work reads. Retrieval never mutates record content; the only
// write is the impression log.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { OpResult } from "../shared-tech/errors.js";
import { createDbReadTransaction, createDbWriteTransaction, storageFailure } from "../shared-tech/index.js";
import { estimateTokens, sliceTokens, type TokenSlice } from "../shared-tech/token-counting/index.js";
import type { ThreadRef } from "../threads/index.js";
import { composeRenderingInput, composeStructuredTurnText } from "../turns/internal/compose.js";
import { readMemberMessages, readMessageDerivationRows, readTurnSource } from "../turns/internal/derivations.js";

/** Whole-item budget for one retrieval call. Callers may override per call. */
export const DEFAULT_RETRIEVAL_TOKEN_BUDGET = 8_000;

/** A partial serve only starts when at least this much budget remains — a
 *  smaller sliver teaches nothing. Explicit `fromToken` continuations are
 *  exempt: the caller asked for exactly that window. */
export const RETRIEVAL_SLICE_FLOOR = 256;

/** Hard cap on deduped ids per retrieval call. Bodies are token-budgeted,
 *  but per-id receipts are not — this bounds the whole model-visible
 *  result (validator P0, 2026-08-08). */
export const MAX_RETRIEVAL_IDS_PER_CALL = 32;

export interface RetrievalOptions {
  /** Per-call token budget over served item text (estimateTokens). */
  tokenBudget?: number;
  /** Token offset into each requested item's text — continues a previous
   *  slice. Intended for single-id continuation calls. */
  fromToken?: number;
  /** Impression provenance: which surface asked (e.g. "get_turns" tool, "board"). */
  surface?: string;
}

export type UnservedReason = "not_found" | "deleted" | "budget" | "invalid";

/** Valid retrieval id shape: `t` or `m` followed by 1–12 digits. Anything
 *  else is refused per-id as "invalid" — ids are echoed into receipts and
 *  impression rows, so shape validation is also a length bound (validator
 *  P0, 2026-08-08). */
export const RETRIEVAL_ID_PATTERN = /^[tm]\d{1,12}$/;

/** Echo bound for invalid ids in receipts/impressions. */
function clampIdEcho(id: string): string {
  return id.length <= 32 ? id : `${id.slice(0, 32)}…`;
}

/** Window receipt on a partially served item: `[fromToken, toToken)` of
 *  `totalTokens` was served. Absent when the full text was served. */
export interface SliceReceipt {
  fromToken: number;
  toToken: number;
  totalTokens: number;
}

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
  slice?: SliceReceipt;
}

export interface RetrievedMessage {
  messageId: string;
  turnId: string;
  kind: string;
  /** Verbatim historical content (tool args/results as recorded). */
  text: string;
  tokens: number;
  slice?: SliceReceipt;
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

/** In-order budget walk shared by both ops. Not-found/deleted entities never
 *  charge the budget. A servable item that fits the remaining budget is served
 *  whole. The item that crosses the budget is served as an exact token slice
 *  filling the remainder (if at least RETRIEVAL_SLICE_FLOOR remains), with a
 *  slice receipt for continuation. Items past a spent budget report "budget"
 *  with their size. `fromToken > 0` slices every requested item from that
 *  offset — the single-id continuation contract. */
function budgetWalk<T extends { text: string; tokens: number; slice?: SliceReceipt }>(
  candidates: readonly Candidate<T>[],
  entityKind: "turn" | "message",
  tokenBudget: number,
  fromToken: number,
): { served: T[]; unserved: UnservedEntity[]; totalTokens: number; impressions: ImpressionRow[] } {
  const served: T[] = [];
  const unserved: UnservedEntity[] = [];
  const impressions: ImpressionRow[] = [];
  let totalTokens = 0;
  candidates.forEach((candidate, requestIdx) => {
    const base = { entityId: candidate.id, requestIdx } as const;
    if (candidate.outcome.kind === "unservable") {
      unserved.push({ id: candidate.id, reason: candidate.outcome.reason });
      impressions.push({ ...base, entityKind, served: false, reason: candidate.outcome.reason });
      return;
    }
    const { item, tokens } = candidate.outcome;
    const remaining = tokenBudget - totalTokens;

    // Whole serve: no offset requested and the full text fits what's left.
    if (fromToken === 0 && tokens <= remaining) {
      served.push(item);
      totalTokens += tokens;
      impressions.push({ ...base, entityKind, served: true, tokens });
      return;
    }

    // Partial serve: explicit continuation always slices; a budget-crossing
    // item slices only when enough budget remains to be worth reading.
    if (fromToken > 0 || remaining >= RETRIEVAL_SLICE_FLOOR) {
      const window: TokenSlice = sliceTokens(item.text, fromToken, remaining);
      const servedTokens = window.toToken - window.fromToken;
      const sliced: T = {
        ...item,
        text: window.text,
        tokens: servedTokens,
        slice: { fromToken: window.fromToken, toToken: window.toToken, totalTokens: window.totalTokens },
      };
      served.push(sliced);
      totalTokens += servedTokens;
      impressions.push({ ...base, entityKind, served: true, tokens: servedTokens });
      return;
    }

    unserved.push({ id: candidate.id, reason: "budget", tokens });
    impressions.push({ ...base, entityKind, served: false, reason: "budget", tokens });
  });
  return { served, unserved, totalTokens, impressions };
}

function resolveBudget(options: RetrievalOptions | undefined): number {
  const budget = options?.tokenBudget ?? DEFAULT_RETRIEVAL_TOKEN_BUDGET;
  if (!Number.isFinite(budget) || budget <= 0) {
    throw new Error(`retrieval tokenBudget must be a positive number, got ${String(budget)}`);
  }
  // The default is also the ceiling: callers cannot raise the model-visible
  // bound above what the serving contract promises (validator P0).
  return Math.min(budget, DEFAULT_RETRIEVAL_TOKEN_BUDGET);
}

function resolveFromToken(options: RetrievalOptions | undefined): number {
  const from = options?.fromToken ?? 0;
  if (!Number.isInteger(from) || from < 0) {
    throw new Error(`retrieval fromToken must be a non-negative integer, got ${String(from)}`);
  }
  return from;
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

  const storedContent = stored?.state === "ready" ? stored.content : null;
  const storedHasTurnLabel =
    typeof storedContent === "string" &&
    storedContent.startsWith(`<${turnId}>\n`) &&
    storedContent.endsWith(`\n</${turnId}>`);
  if (storedHasTurnLabel) {
    const tokens = estimateTokens(storedContent);
    return {
      id: turnId,
      outcome: { kind: "servable", item: { turnId, text: storedContent, tokens, source: "stored" }, tokens },
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

async function retrieve<T extends { text: string; tokens: number; slice?: SliceReceipt }>(
  ref: ThreadRef,
  ids: readonly string[],
  options: RetrievalOptions | undefined,
  defaultSurface: string,
  entityKind: "turn" | "message",
  candidateOf: (db: DatabaseSync, id: string) => Candidate<T>,
): Promise<OpResult<RetrievalReceipt<T>>> {
  let tokenBudget: number;
  let fromToken: number;
  try {
    tokenBudget = resolveBudget(options);
    fromToken = resolveFromToken(options);
  } catch (cause) {
    return storageFailure(cause instanceof Error ? cause.message : String(cause));
  }
  if (ids.length === 0) {
    return storageFailure(`${defaultSurface}: at least one id is required`);
  }
  // Hard bound on the whole model-visible result: bodies are budgeted, but
  // receipts/footers scale with id count — unbounded ids means unbounded
  // output. Refuse over-cap calls whole with a receipt naming the cap.
  if (dedupe(ids).length > MAX_RETRIEVAL_IDS_PER_CALL) {
    return storageFailure(
      `${defaultSurface}: too many ids — ${dedupe(ids).length} requested, cap is ${MAX_RETRIEVAL_IDS_PER_CALL} per call; split the request`,
    );
  }
  const surface = options?.surface ?? defaultSurface;
  const callId = randomUUID();
  try {
    // Write transaction: the serve itself is a read, but every call logs
    // impressions — the durable usage record is part of the contract.
    return await createDbWriteTransaction(ref, (transaction) => {
      const candidates = dedupe(ids).map((id) =>
        RETRIEVAL_ID_PATTERN.test(id)
          ? candidateOf(transaction.db, id)
          : { id: clampIdEcho(id), outcome: { kind: "unservable", reason: "invalid" } as const },
      );
      const walk = budgetWalk(candidates, entityKind, tokenBudget, fromToken);
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
