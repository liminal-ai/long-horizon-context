import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { OpResult } from "../shared-tech/errors.js";
import {
  createDbReadTransaction,
  createDbWriteTransaction,
  resolveInstanceTokenEstimator,
  storageFailure,
} from "../shared-tech/index.js";
import type { TokenEstimator } from "../shared-tech/token-counting/index.js";
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

/** Documented worst case for one call's whole model-visible result:
 *  bodies ≤ 8,000 (budget ceiling) + ≤32 sections/footers/receipts with
 *  clamped echoes. Conservative analytic derivation (2026-08-08, rs R6):
 *  8,000 + 85 + 97 + 960 + 4,704 + 7,680 = 21,526. Constant matches the
 *  rs port (`MAX_RETRIEVAL_OUTPUT_TOKENS`); the static proof lives in
 *  lhc-rs retrieval::format tests. Documentation, not runtime enforcement. */
export const MAX_RETRIEVAL_OUTPUT_TOKENS = 22_000;

export interface RetrievalOptions {
  tokenBudget?: number;
  byteBudget?: number;
  fromToken?: number;
  surface?: string;
}

export type UnservedReason = "not_found" | "deleted" | "budget" | "invalid";

/** Valid retrieval id shape: `t` or `m` followed by 1–12 digits. Anything
 *  else is refused per-id as "invalid" — ids are echoed into receipts and
 *  impression rows, so shape validation is also a length bound (validator
 *  P0, 2026-08-08). */
export const RETRIEVAL_ID_PATTERN = /^[tm]\d{1,12}$/;

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
  tokens?: number;
}

export interface RetrievedTurn {
  turnId: string;
  text: string;
  tokens: number;
  source: "stored" | "composed";
  slice?: SliceReceipt;
}

export interface RetrievedMessage {
  messageId: string;
  turnId: string;
  kind: string;
  text: string;
  tokens: number;
  slice?: SliceReceipt;
}

export interface RetrievalReceipt<TServed> {
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

function dedupe(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

interface Candidate<T> {
  id: string;
  outcome: { kind: "servable"; item: T; tokens: number } | { kind: "unservable"; reason: UnservedReason };
}

function budgetWalk<T extends { text: string; tokens: number; slice?: SliceReceipt }>(
  candidates: readonly Candidate<T>[],
  entityKind: "turn" | "message",
  tokenBudget: number,
  byteBudget: number,
  fromToken: number,
  estimator: TokenEstimator,
): { served: T[]; unserved: UnservedEntity[]; totalTokens: number; impressions: ImpressionRow[] } {
  const served: T[] = [];
  const unserved: UnservedEntity[] = [];
  const impressions: ImpressionRow[] = [];
  let totalTokens = 0;
  let totalBytes = 0;
  candidates.forEach((candidate, requestIdx) => {
    const base = { entityId: candidate.id, requestIdx } as const;
    if (candidate.outcome.kind === "unservable") {
      unserved.push({ id: candidate.id, reason: candidate.outcome.reason });
      impressions.push({ ...base, entityKind, served: false, reason: candidate.outcome.reason });
      return;
    }
    const { item, tokens } = candidate.outcome;
    const remaining = tokenBudget - totalTokens;
    const remainingBytes = byteBudget - totalBytes;

    if (fromToken === 0 && tokens <= remaining && utf8Bytes(item.text) <= remainingBytes) {
      served.push(item);
      totalTokens += tokens;
      totalBytes += utf8Bytes(item.text);
      impressions.push({ ...base, entityKind, served: true, tokens });
      return;
    }

    if (fromToken > 0 || remaining >= RETRIEVAL_SLICE_FLOOR) {
      const window = Number.isFinite(byteBudget)
        ? estimator.sliceTokensByteCapped(item.text, fromToken, remaining, remainingBytes)
        : estimator.sliceTokens(item.text, fromToken, remaining);
      const servedTokens = window.toToken - window.fromToken;
      const tokenWindow = Math.min(remaining, Math.max(0, window.totalTokens - window.fromToken));
      const byteBound = Number.isFinite(byteBudget) && servedTokens < tokenWindow;
      const sliver = !byteBound && fromToken === 0 && servedTokens < Math.min(RETRIEVAL_SLICE_FLOOR, tokens);
      if (sliver) {
        unserved.push({ id: candidate.id, reason: "budget", tokens });
        impressions.push({ ...base, entityKind, served: false, reason: "budget", tokens });
        return;
      }
      const sliced: T = {
        ...item,
        text: window.text,
        tokens: servedTokens,
        slice: { fromToken: window.fromToken, toToken: window.toToken, totalTokens: window.totalTokens },
      };
      served.push(sliced);
      totalTokens += servedTokens;
      totalBytes += utf8Bytes(window.text);
      impressions.push({ ...base, entityKind, served: true, tokens: servedTokens });
      return;
    }

    unserved.push({ id: candidate.id, reason: "budget", tokens });
    impressions.push({ ...base, entityKind, served: false, reason: "budget", tokens });
  });
  return { served, unserved, totalTokens, impressions };
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function resolveBudget(options: RetrievalOptions | undefined): number {
  const budget = options?.tokenBudget ?? DEFAULT_RETRIEVAL_TOKEN_BUDGET;
  if (!Number.isFinite(budget) || budget <= 0) {
    throw new Error(`retrieval tokenBudget must be a positive number, got ${String(budget)}`);
  }
  return Math.min(budget, DEFAULT_RETRIEVAL_TOKEN_BUDGET);
}

function resolveByteBudget(options: RetrievalOptions | undefined): number {
  const budget = options?.byteBudget ?? Number.POSITIVE_INFINITY;
  if (Number.isNaN(budget) || budget <= 0) {
    throw new Error(`retrieval byteBudget must be a positive number, got ${String(budget)}`);
  }
  return budget;
}

function resolveFromToken(options: RetrievalOptions | undefined): number {
  const from = options?.fromToken ?? 0;
  if (!Number.isInteger(from) || from < 0) {
    throw new Error(`retrieval fromToken must be a non-negative integer, got ${String(from)}`);
  }
  return from;
}

function turnCandidate(db: DatabaseSync, turnId: string, estimator: TokenEstimator): Candidate<RetrievedTurn> {
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
    const tokens = estimator.estimate(storedContent);
    return {
      id: turnId,
      outcome: { kind: "servable", item: { turnId, text: storedContent, tokens, source: "stored" }, tokens },
    };
  }

  const members = readMemberMessages(db, turnId);
  const derivations = readMessageDerivationRows(
    db,
    members.map((message) => message.messageId),
  );
  const { parts } = composeRenderingInput(members, derivations);
  const text = composeStructuredTurnText(parts, turnId);
  const tokens = estimator.estimate(text);
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

function messageCandidate(db: DatabaseSync, messageId: string, estimator: TokenEstimator): Candidate<RetrievedMessage> {
  const row = db
    .prepare(`SELECT message_id, turn_id, kind, deleted_at FROM message WHERE message_id = ?`)
    .get(messageId) as MessageRow | undefined;
  if (row === undefined) return { id: messageId, outcome: { kind: "unservable", reason: "not_found" } };
  if (row.deleted_at !== null) return { id: messageId, outcome: { kind: "unservable", reason: "deleted" } };

  const blocks = db
    .prepare(`SELECT block_type, content FROM message_block WHERE message_id = ? ORDER BY block_index`)
    .all(messageId) as unknown as BlockRow[];
  const text = verbatimText(blocks);
  const tokens = estimator.estimate(text);
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
  return retrieve(ref, turnIds, options, "get_turns", "turn", (db, id, estimator) => turnCandidate(db, id, estimator));
}

/** Verbatim messages by message id, in request order, under a whole-item budget. */
export async function getMessages(
  ref: ThreadRef,
  messageIds: readonly string[],
  options?: RetrievalOptions,
): Promise<OpResult<RetrievalReceipt<RetrievedMessage>>> {
  return retrieve(ref, messageIds, options, "get_messages", "message", (db, id, estimator) =>
    messageCandidate(db, id, estimator),
  );
}

async function retrieve<T extends { text: string; tokens: number; slice?: SliceReceipt }>(
  ref: ThreadRef,
  ids: readonly string[],
  options: RetrievalOptions | undefined,
  defaultSurface: string,
  entityKind: "turn" | "message",
  candidateOf: (db: DatabaseSync, id: string, estimator: TokenEstimator) => Candidate<T>,
): Promise<OpResult<RetrievalReceipt<T>>> {
  let tokenBudget: number;
  let byteBudget: number;
  let fromToken: number;
  try {
    tokenBudget = resolveBudget(options);
    byteBudget = resolveByteBudget(options);
    fromToken = resolveFromToken(options);
  } catch (cause) {
    return storageFailure(cause instanceof Error ? cause.message : String(cause));
  }
  if (ids.length === 0) {
    return storageFailure(`${defaultSurface}: at least one id is required`);
  }
  if (dedupe(ids).length > MAX_RETRIEVAL_IDS_PER_CALL) {
    return storageFailure(
      `${defaultSurface}: too many ids — ${dedupe(ids).length} requested, cap is ${MAX_RETRIEVAL_IDS_PER_CALL} per call; split the request`,
    );
  }
  const surface = options?.surface ?? defaultSurface;
  const callId = randomUUID();
  try {
    return await createDbWriteTransaction(ref, (transaction) => {
      const estimator = resolveInstanceTokenEstimator("retrieval");
      const candidates = dedupe(ids).map((id) =>
        RETRIEVAL_ID_PATTERN.test(id)
          ? candidateOf(transaction.db, id, estimator)
          : { id: clampIdEcho(id), outcome: { kind: "unservable", reason: "invalid" } as const },
      );
      const walk = budgetWalk(candidates, entityKind, tokenBudget, byteBudget, fromToken, estimator);
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
