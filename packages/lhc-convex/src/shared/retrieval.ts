// Retrieval walk: deterministic drill-down from band labels to full content.
// Pure over candidates by design — the Convex component supplies candidates
// from its tables and writes the impression rows; this module owns budgets,
// slicing, receipts, and id validation. Mirrors packages/lhc
// src/retrieval/index.ts at the contract pin (TS 32468e0 / 575de9c / 10cc482 /
// f2e6e47 / 5b2c25d).

import { sliceTokens, sliceTokensByteCapped, utf8ByteLength } from "./token_counting/index.js";

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

/** Documented worst case for one call's whole model-visible result. Matches
 *  the TS/rs constant; documentation, not runtime enforcement. */
export const MAX_RETRIEVAL_OUTPUT_TOKENS = 22_000;

export interface RetrievalOptions {
  tokenBudget?: number;
  byteBudget?: number;
  fromToken?: number;
  /** Impression provenance: which surface asked (e.g. "get_turns" tool). */
  surface?: string;
}

export type UnservedReason = "not_found" | "deleted" | "budget" | "invalid";

/** Valid retrieval id shape: `t` or `m` followed by 1–12 digits. Anything
 *  else is refused per-id as "invalid" — ids are echoed into receipts and
 *  impression rows, so shape validation is also a length bound. */
export const RETRIEVAL_ID_PATTERN = /^[tm]\d{1,12}$/;

/** Echo bound for invalid ids in receipts/impressions. */
export function clampIdEcho(id: string): string {
  return id.length <= 32 ? id : `${id.slice(0, 32)}…`;
}

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

export interface ImpressionRow {
  entityKind: "turn" | "message";
  entityId: string;
  requestIdx: number;
  served: boolean;
  reason?: UnservedReason;
  tokens?: number;
}

/** First occurrence wins; duplicate requests collapse to one serve/impression. */
export function dedupe(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

export interface Candidate<T> {
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
export function budgetWalk<T extends { text: string; tokens: number; slice?: SliceReceipt }>(
  candidates: readonly Candidate<T>[],
  entityKind: "turn" | "message",
  tokenBudget: number,
  byteBudget: number,
  fromToken: number,
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

    // Whole serve: no offset requested and the full text fits what's left
    // in BOTH budgets.
    if (fromToken === 0 && tokens <= remaining && utf8ByteLength(item.text) <= remainingBytes) {
      served.push(item);
      totalTokens += tokens;
      totalBytes += utf8ByteLength(item.text);
      impressions.push({ ...base, entityKind, served: true, tokens });
      return;
    }

    // Partial serve: explicit continuation always slices; a budget-crossing
    // item slices only when enough budget remains to be worth reading.
    if (fromToken > 0 || remaining >= RETRIEVAL_SLICE_FLOOR) {
      const window = Number.isFinite(byteBudget)
        ? sliceTokensByteCapped(item.text, fromToken, remaining, remainingBytes)
        : sliceTokens(item.text, fromToken, remaining);
      const servedTokens = window.toToken - window.fromToken;
      // Sub-floor serves under TOKEN pressure teach nothing — report
      // "budget" so the model re-pulls alone. But when the BYTE budget is
      // what bound the window, re-pulling alone cannot yield more: serve
      // the byte-fit slice, however small — it is the only way through
      // byte-dense content. Explicit continuations serve whatever fits,
      // including the empty past-the-end slice (its receipt IS the answer).
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
      totalBytes += utf8ByteLength(window.text);
      impressions.push({ ...base, entityKind, served: true, tokens: servedTokens });
      return;
    }

    unserved.push({ id: candidate.id, reason: "budget", tokens });
    impressions.push({ ...base, entityKind, served: false, reason: "budget", tokens });
  });
  return { served, unserved, totalTokens, impressions };
}

export function resolveBudget(options: RetrievalOptions | undefined): number {
  const budget = options?.tokenBudget ?? DEFAULT_RETRIEVAL_TOKEN_BUDGET;
  if (!Number.isFinite(budget) || budget <= 0) {
    throw new Error(`retrieval tokenBudget must be a positive number, got ${String(budget)}`);
  }
  // The default is also the ceiling: callers cannot raise the model-visible
  // bound above what the serving contract promises (validator P0).
  return Math.min(budget, DEFAULT_RETRIEVAL_TOKEN_BUDGET);
}

export function resolveByteBudget(options: RetrievalOptions | undefined): number {
  const budget = options?.byteBudget ?? Number.POSITIVE_INFINITY;
  if (Number.isNaN(budget) || budget <= 0) {
    throw new Error(`retrieval byteBudget must be a positive number, got ${String(budget)}`);
  }
  return budget;
}

export function resolveFromToken(options: RetrievalOptions | undefined): number {
  const from = options?.fromToken ?? 0;
  if (!Number.isInteger(from) || from < 0) {
    throw new Error(`retrieval fromToken must be a non-negative integer, got ${String(from)}`);
  }
  return from;
}

/** Verbatim text of one message from its stored blocks — the historical
 *  artifact as recorded, not a summary. Tool blocks carry their pairing ids so
 *  calls and results stay matchable. */
export function verbatimText(blocks: ReadonlyArray<{ blockType: string; content: Record<string, unknown> }>): string {
  const parts: string[] = [];
  for (const block of blocks) {
    const content = block.content;
    switch (block.blockType) {
      case "text": {
        parts.push(typeof content["text"] === "string" ? content["text"] : JSON.stringify(content));
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
        parts.push(`[${block.blockType}]\n${JSON.stringify(content, null, 2)}`);
        break;
      }
    }
  }
  return parts.join("\n");
}

/** Impression read-back row (inspection/test seam; ranking work reads this later). */
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
