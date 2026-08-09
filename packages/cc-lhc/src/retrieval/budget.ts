/**
 * Whole-stdout byte ceiling and analytic envelope proof.
 *
 * Worst reachable SDK shape for n unique ids (fromToken walk):
 * - one body-consuming partial (full remaining byteBudget body),
 * - plus n-1 empty/end served slices (each with tags for messages + footer),
 * - framing, separators, final newline.
 * Also compare all-unserved and take the max for the reserve/proof.
 */

import { retrieval } from "lhc";

import type { RetrievalOp } from "./parse.js";
import {
  assembleEnvelope,
  messageSection,
  recallClose,
  recallOpen,
  sliceFooter,
  turnSection,
  unservedLine,
  type UnservedLike,
} from "./format.js";

const MAX_RETRIEVAL_IDS_PER_CALL = retrieval.MAX_RETRIEVAL_IDS_PER_CALL;

export const CERTIFIED_STDOUT_CEILING_BYTES = 24_000;
export const FINAL_NEWLINE_BYTES = 1;
export const MAX_TOKEN_DIGITS = String(Number.MAX_SAFE_INTEGER).length;

export function framingOverheadBytes(op: RetrievalOp): number {
  return Buffer.byteLength(recallOpen(op), "utf8") + Buffer.byteLength(recallClose(op), "utf8");
}

export function maxId(op: RetrievalOp, index = 0): string {
  // 12 digits after prefix — max RETRIEVAL_ID_PATTERN width
  const digits = String(index + 1).padStart(12, "0");
  return op === "get-turns" ? `t${digits}` : `m${digits}`;
}

export function worstCaseSliceFooterBytes(op: RetrievalOp): number {
  const id = maxId(op, 0);
  const n = "9".repeat(MAX_TOKEN_DIGITS);
  const footer =
    `[${id}: served tok ${n}–${n} of ${n} — ${n} tok remain. ` +
    `Next slice: cc-lhc ${op} --from ${n} ${id}]`;
  const end = `[${id}: served tok ${n}–${n} of ${n} — end of content]`;
  return Math.max(Buffer.byteLength(footer, "utf8"), Buffer.byteLength(end, "utf8"));
}

export function worstCaseUnservedBytes(op: RetrievalOp): number {
  const id = maxId(op, 0);
  const n = "9".repeat(MAX_TOKEN_DIGITS);
  const budget =
    `not served: ${id} (${n} tok — call budget spent). Pull it separately: cc-lhc ${op} ${id}`;
  const others = ["not_found", "deleted", "invalid"].map(
    (r) => `not served: ${id} (${r}, ${n} tok)`,
  );
  return Math.max(Buffer.byteLength(budget, "utf8"), ...others.map((s) => Buffer.byteLength(s, "utf8")));
}

export function maxMessageTagOverheadBytes(uniqueIdCount: number): number {
  let total = 0;
  for (let i = 0; i < uniqueIdCount; i += 1) {
    const id = maxId("get-messages", i);
    total += Buffer.byteLength(`<${id}>\n`, "utf8") + Buffer.byteLength(`\n</${id}>`, "utf8");
  }
  return total;
}

/**
 * Non-body reserve for n ids assuming all n are served (one partial + n-1 empty
 * ends): framing + seps + n max footers + final newline (+ message tags separate).
 */
export function maxServedShapeOverheadBytes(op: RetrievalOp, uniqueIdCount: number): number {
  const n = Math.max(0, Math.min(MAX_RETRIEVAL_IDS_PER_CALL, uniqueIdCount));
  const framing = framingOverheadBytes(op);
  // open + n sections + close → (n+1) * "\n\n" when n>0
  const envelopeSeps = n > 0 ? (n + 1) * 2 : 0;
  const footers = n * worstCaseSliceFooterBytes(op);
  // outside: n footers after envelope block → n separators of "\n\n"
  const outsideSeps = n > 0 ? n * 2 : 0;
  const tags = op === "get-messages" ? maxMessageTagOverheadBytes(n) : 0;
  return framing + envelopeSeps + footers + outsideSeps + tags + FINAL_NEWLINE_BYTES;
}

/** All-unserved shape overhead (no body, n unserved lines). */
export function maxUnservedShapeOverheadBytes(op: RetrievalOp, uniqueIdCount: number): number {
  const n = Math.max(0, Math.min(MAX_RETRIEVAL_IDS_PER_CALL, uniqueIdCount));
  const lines = n * worstCaseUnservedBytes(op);
  const seps = n > 1 ? (n - 1) * 2 : 0;
  return lines + seps + FINAL_NEWLINE_BYTES;
}

export interface BudgetPlan {
  stdoutCeiling: number;
  reservedOverhead: number;
  sdkByteBudget: number | null;
  uniqueIdCount: number;
}

export function planByteBudget(
  op: RetrievalOp,
  uniqueIdCount: number,
  envCeiling?: number | undefined,
): BudgetPlan {
  const n = Math.max(0, Math.min(MAX_RETRIEVAL_IDS_PER_CALL, uniqueIdCount));
  let ceiling = CERTIFIED_STDOUT_CEILING_BYTES;
  if (envCeiling !== undefined && Number.isFinite(envCeiling) && envCeiling > 0) {
    ceiling = Math.min(ceiling, Math.floor(envCeiling));
  }
  // Reserve the worse of served-max vs unserved-max non-body costs.
  const reserved = Math.max(
    maxServedShapeOverheadBytes(op, n),
    maxUnservedShapeOverheadBytes(op, n),
  );
  const remain = ceiling - reserved;
  return {
    stdoutCeiling: ceiling,
    reservedOverhead: reserved,
    sdkByteBudget: remain > 0 ? remain : null,
    uniqueIdCount: n,
  };
}

const TOK = Number.MAX_SAFE_INTEGER;

/**
 * Reachable maximum-width non-terminal slice: from/to/total/remain/--from all
 * carry the digit width of Number.MAX_SAFE_INTEGER (not one-digit from=0/remain=1).
 * Arithmetic: from is the smallest MAX-digit positive integer, to = from+1,
 * total = MAX_SAFE_INTEGER ⇒ remaining is still MAX-digit.
 */
export function maxWidthNonTerminalSlice(): {
  fromToken: number;
  toToken: number;
  totalTokens: number;
} {
  const digits = MAX_TOKEN_DIGITS;
  const fromToken = 10 ** (digits - 1); // e.g. 1_000_000_000_000_000 (16 digits)
  const toToken = fromToken + 1;
  return { fromToken, toToken, totalTokens: TOK };
}

/**
 * Worst reachable served shape: 1 body-consuming partial + (n-1) empty/end slices.
 */
export function assembleMaxServedShape(
  op: RetrievalOp,
  uniqueIdCount: number,
  bodyBudgetBytes: number,
): { envelope: string; bytes: number } {
  const n = Math.max(1, Math.min(MAX_RETRIEVAL_IDS_PER_CALL, uniqueIdCount));
  const body = "A".repeat(Math.max(0, bodyBudgetBytes));
  const sections: string[] = [];
  const footers: string[] = [];
  const maxPartial = maxWidthNonTerminalSlice();
  for (let i = 0; i < n; i += 1) {
    const id = maxId(op, i);
    if (i === 0) {
      sections.push(op === "get-turns" ? turnSection(body) : messageSection(id, body));
      // Body-consuming partial must use the longer reachable "Next slice" footer
      // with max-width from/to/total/remain/--from fields.
      footers.push(sliceFooter(op, id, maxPartial));
    } else {
      // Empty/end served slice (SDK can still return a section with end footer)
      sections.push(op === "get-turns" ? turnSection("") : messageSection(id, ""));
      footers.push(
        sliceFooter(op, id, { fromToken: TOK, toToken: TOK, totalTokens: TOK }),
      );
    }
  }
  const envelope = assembleEnvelope(op, sections, footers, []);
  return { envelope, bytes: Buffer.byteLength(envelope, "utf8") + FINAL_NEWLINE_BYTES };
}

/** All-unserved alternative shape. */
export function assembleMaxUnservedShape(
  op: RetrievalOp,
  uniqueIdCount: number,
): { envelope: string; bytes: number } {
  const n = Math.max(1, Math.min(MAX_RETRIEVAL_IDS_PER_CALL, uniqueIdCount));
  const reasons = ["budget", "not_found", "deleted", "invalid"] as const;
  const unserved: UnservedLike[] = [];
  for (let i = 0; i < n; i += 1) {
    unserved.push({
      id: maxId(op, i),
      reason: reasons[i % reasons.length]!,
      tokens: TOK,
    });
  }
  const envelope = assembleEnvelope(op, [], [], unserved);
  return { envelope, bytes: Buffer.byteLength(envelope, "utf8") + FINAL_NEWLINE_BYTES };
}

/** Mixed: 1 partial served + rest unserved. */
export function assembleMixedShape(
  op: RetrievalOp,
  uniqueIdCount: number,
  bodyBudgetBytes: number,
): { envelope: string; bytes: number } {
  const n = Math.max(1, Math.min(MAX_RETRIEVAL_IDS_PER_CALL, uniqueIdCount));
  const body = "A".repeat(Math.max(0, bodyBudgetBytes));
  const id0 = maxId(op, 0);
  const sections =
    op === "get-turns" ? [turnSection(body)] : [messageSection(id0, body)];
  const footers = [sliceFooter(op, id0, maxWidthNonTerminalSlice())];
  const unserved: UnservedLike[] = [];
  for (let i = 1; i < n; i += 1) {
    unserved.push({ id: maxId(op, i), reason: "budget", tokens: TOK });
  }
  const envelope = assembleEnvelope(op, sections, footers, unserved);
  return { envelope, bytes: Buffer.byteLength(envelope, "utf8") + FINAL_NEWLINE_BYTES };
}

export function assembleMaximumShapeEnvelope(
  op: RetrievalOp,
  uniqueIdCount: number,
  bodyBudgetBytes: number,
): { envelope: string; bytes: number; shape: string } {
  const served = assembleMaxServedShape(op, uniqueIdCount, bodyBudgetBytes);
  const unserved = assembleMaxUnservedShape(op, uniqueIdCount);
  const mixed = assembleMixedShape(op, uniqueIdCount, bodyBudgetBytes);
  const best = [served, unserved, mixed].reduce((a, b) => (b.bytes > a.bytes ? b : a));
  const shape =
    best === served ? "all-served-empty-ends" : best === unserved ? "all-unserved" : "mixed";
  return { envelope: best.envelope, bytes: best.bytes, shape };
}

export function proveEnvelopeFits(
  op: RetrievalOp,
  uniqueIdCount: number,
  envCeiling?: number,
): boolean {
  const plan = planByteBudget(op, uniqueIdCount, envCeiling);
  if (plan.sdkByteBudget === null) return true;
  const { bytes } = assembleMaximumShapeEnvelope(
    op,
    Math.max(1, uniqueIdCount),
    plan.sdkByteBudget,
  );
  return bytes <= plan.stdoutCeiling;
}

export function envStdoutCeiling(env: NodeJS.ProcessEnv = process.env): number | undefined {
  // Canonical Claude/Bash ceiling only — no undocumented host aliases.
  const raw = env.BASH_MAX_OUTPUT_LENGTH;
  if (raw === undefined || raw === "") return undefined;
  if (!/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return undefined;
  return n;
}
