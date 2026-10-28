import type { DatabaseSync } from "node:sqlite";
import { resolveInstanceTokenEstimator } from "../../shared-tech/index.js";
import { readBoundaryPosition } from "./boundary.js";
import { ABBREVIATION_LIMIT, deterministicTruncation } from "./render.js";
import { readViewSnapshot } from "./snapshot.js";

export type ProtectedBoundaryPreview = {
  previousBoundary: number;
  proposedBoundary: number;
  compactPoint: number;
  effectiveStart: number;
  earliestProtectedResultOrder: number | null;
  maxLegalBoundary: number;
  protectedToolCallIds: string[];
  fullProtectedTokenEstimate: number;
  eligibleUnprotectedTokenEstimate: number;
  prunedUnprotectedTokenEstimate: number;
  remainingUnprotectedFullTokenEstimate: number;
  zoneTokensAfterEstimate: number;
  maximalPruneInsufficient: boolean;
  noOp: boolean;
  notes: string[];
};

type ToolResultRow = {
  sourceEventOrder: number;
  toolCallId: string;
  tokenEstimate: number;
  content: string;
};

function readLiveToolResultsAfter(db: DatabaseSync, effectiveStart: number): ToolResultRow[] {
  const rows = db
    .prepare(
      `SELECT m.source_event_order, m.token_estimate, b.content
       FROM message m
       JOIN message_block b ON b.message_id = m.message_id AND b.block_type = 'tool_result'
       WHERE m.kind = 'tool_result' AND m.deleted_at IS NULL AND m.source_event_order > ?
       ORDER BY m.source_event_order ASC`,
    )
    .all(effectiveStart) as unknown as Array<{
    source_event_order: number | bigint;
    token_estimate: number | bigint;
    content: string;
  }>;
  return rows.map((row) => {
    let toolCallId = "";
    let content = "";
    try {
      const parsed = JSON.parse(row.content) as { toolCallId?: unknown; content?: unknown };
      if (typeof parsed.toolCallId === "string") toolCallId = parsed.toolCallId;
      if (typeof parsed.content === "string") content = parsed.content;
    } catch {}
    return {
      sourceEventOrder: Number(row.source_event_order),
      toolCallId,
      tokenEstimate: resolveInstanceTokenEstimator("threadView.previewProtectedBoundary").weigh(
        Number(row.token_estimate),
      ),
      content,
    };
  });
}

function abridgedTokenEstimate(content: string): number {
  return resolveInstanceTokenEstimator("threadView.previewProtectedBoundary").estimate(
    deterministicTruncation(content),
  );
}

export function previewProtectedVisibilityBoundary(
  db: DatabaseSync,
  protectedToolCallIds: readonly string[],
  opts: { targetZoneTokens?: number; compactPointOverride?: number } = {},
): ProtectedBoundaryPreview {
  const protectedSet = new Set(protectedToolCallIds.filter((id) => typeof id === "string" && id.length > 0));
  const sortedProtected = [...protectedSet].sort();
  const snapshot = readViewSnapshot(db);
  const compactPoint = opts.compactPointOverride ?? snapshot?.compactPoint ?? 0;
  const previousBoundary = readBoundaryPosition(db);
  const effectiveStart = Math.max(previousBoundary, compactPoint);
  const notes: string[] = [];

  const rows = readLiveToolResultsAfter(db, effectiveStart);
  const protectedRows = rows.filter((r) => protectedSet.has(r.toolCallId));
  const unprotectedRows = rows.filter((r) => !protectedSet.has(r.toolCallId));

  const fullProtectedTokenEstimate = protectedRows.reduce((s, r) => s + r.tokenEstimate, 0);
  const eligibleUnprotectedTokenEstimate = unprotectedRows.reduce((s, r) => s + r.tokenEstimate, 0);

  let earliestProtectedResultOrder: number | null = null;
  for (const r of protectedRows) {
    if (earliestProtectedResultOrder === null || r.sourceEventOrder < earliestProtectedResultOrder) {
      earliestProtectedResultOrder = r.sourceEventOrder;
    }
  }

  const maxLegalBoundary =
    earliestProtectedResultOrder === null ? Number.MAX_SAFE_INTEGER : earliestProtectedResultOrder - 1;

  if (earliestProtectedResultOrder !== null && earliestProtectedResultOrder <= effectiveStart) {
    notes.push("earliest protected result is at or behind effective start; no eligible older unprotected rows");
  }

  const eligible = unprotectedRows.filter((r) => r.sourceEventOrder <= maxLegalBoundary);

  let maximalBoundary = previousBoundary;
  for (const r of eligible) {
    if (r.sourceEventOrder > maximalBoundary && r.sourceEventOrder <= maxLegalBoundary) {
      maximalBoundary = r.sourceEventOrder;
    }
  }
  if (maximalBoundary < previousBoundary) maximalBoundary = previousBoundary;
  if (maximalBoundary > maxLegalBoundary && maxLegalBoundary >= previousBoundary) {
    maximalBoundary = Math.max(previousBoundary, Math.min(maximalBoundary, maxLegalBoundary));
  }
  if (earliestProtectedResultOrder !== null && maximalBoundary >= earliestProtectedResultOrder) {
    maximalBoundary = Math.max(previousBoundary, earliestProtectedResultOrder - 1);
  }

  function zoneFullAfter(boundary: number): number {
    const start = Math.max(boundary, compactPoint);
    let sum = 0;
    for (const r of rows) {
      if (r.sourceEventOrder > start) sum += r.tokenEstimate;
    }
    return sum;
  }

  function prunedSavingsIfBoundary(boundary: number): number {
    let savings = 0;
    for (const r of unprotectedRows) {
      if (r.sourceEventOrder > compactPoint && r.sourceEventOrder <= boundary) {
        const full = r.tokenEstimate;
        const short = abridgedTokenEstimate(r.content);
        savings += Math.max(0, full - short);
      }
    }
    return savings;
  }

  let proposedBoundary = previousBoundary;
  const target = opts.targetZoneTokens;

  if (target === undefined) {
    proposedBoundary = maximalBoundary;
  } else if (zoneFullAfter(previousBoundary) <= target) {
    proposedBoundary = previousBoundary;
  } else {
    proposedBoundary = previousBoundary;
    for (const r of eligible) {
      if (r.sourceEventOrder <= proposedBoundary) continue;
      if (r.sourceEventOrder > maxLegalBoundary) break;
      const candidate = r.sourceEventOrder;
      if (earliestProtectedResultOrder !== null && candidate >= earliestProtectedResultOrder) break;
      proposedBoundary = candidate;
      if (zoneFullAfter(proposedBoundary) <= target) break;
    }
  }

  if (proposedBoundary < previousBoundary) proposedBoundary = previousBoundary;
  if (earliestProtectedResultOrder !== null && proposedBoundary >= earliestProtectedResultOrder) {
    proposedBoundary = Math.max(previousBoundary, earliestProtectedResultOrder - 1);
    notes.push("clamped proposed boundary strictly before earliest protected result");
  }

  let prunedUnprotectedTokenEstimate = 0;
  let remainingUnprotectedFullTokenEstimate = 0;
  for (const r of unprotectedRows) {
    if (r.sourceEventOrder > Math.max(proposedBoundary, compactPoint)) {
      remainingUnprotectedFullTokenEstimate += r.tokenEstimate;
    } else if (r.sourceEventOrder > compactPoint && r.sourceEventOrder <= proposedBoundary) {
      prunedUnprotectedTokenEstimate += r.tokenEstimate;
    }
  }

  const zoneTokensAfterEstimate = zoneFullAfter(proposedBoundary);
  const maximalZone = zoneFullAfter(maximalBoundary);
  const maximalPruneInsufficient =
    target !== undefined ? maximalZone > target : fullProtectedTokenEstimate > 0 && eligible.length === 0;

  if (earliestProtectedResultOrder !== null && proposedBoundary >= earliestProtectedResultOrder) {
    proposedBoundary = Math.max(previousBoundary, earliestProtectedResultOrder - 1);
  }

  const noOp = proposedBoundary === previousBoundary;
  void prunedSavingsIfBoundary;
  void ABBREVIATION_LIMIT;

  return {
    previousBoundary,
    proposedBoundary,
    compactPoint,
    effectiveStart,
    earliestProtectedResultOrder,
    maxLegalBoundary: earliestProtectedResultOrder === null ? maximalBoundary : earliestProtectedResultOrder - 1,
    protectedToolCallIds: sortedProtected,
    fullProtectedTokenEstimate,
    eligibleUnprotectedTokenEstimate,
    prunedUnprotectedTokenEstimate,
    remainingUnprotectedFullTokenEstimate,
    zoneTokensAfterEstimate,
    maximalPruneInsufficient,
    noOp,
    notes,
  };
}
