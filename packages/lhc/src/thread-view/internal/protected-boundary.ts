/**
 * Read-only protected visibility-boundary preview (LIM-67).
 *
 * Accounts every protected tool_result at full size first, then considers only
 * older unprotected tool_result rows after the effective compact/boundary start.
 * Never moves the boundary backward. Boundary is strictly before the earliest
 * protected result event. Calls, assistant text, and reasoning are never targets.
 */

import type { DatabaseSync } from "node:sqlite";
import { estimateTokens } from "../../shared-tech/token-counting/index.js";
import { readBoundaryPosition } from "./boundary.js";
import { ABBREVIATION_LIMIT, deterministicTruncation } from "./render.js";
import { readViewSnapshot } from "./snapshot.js";

export type ProtectedBoundaryPreview = {
  previousBoundary: number;
  proposedBoundary: number;
  compactPoint: number;
  effectiveStart: number;
  /** Earliest protected tool_result source_event_order; null when none. */
  earliestProtectedResultOrder: number | null;
  /** Max legal boundary is earliestProtectedResultOrder - 1 (or previous when none). */
  maxLegalBoundary: number;
  protectedToolCallIds: string[];
  fullProtectedTokenEstimate: number;
  eligibleUnprotectedTokenEstimate: number;
  prunedUnprotectedTokenEstimate: number;
  remainingUnprotectedFullTokenEstimate: number;
  /** Estimated zone tokens after proposed boundary (protected full + remaining full unprotected). */
  zoneTokensAfterEstimate: number;
  /** True when even maximal eligible pruning cannot reduce zone under target (if any). */
  maximalPruneInsufficient: boolean;
  noOp: boolean;
  /** Human-readable reasons (empty when ok). */
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
    } catch {
      // leave empty; caller may still count token_estimate
    }
    return {
      sourceEventOrder: Number(row.source_event_order),
      toolCallId,
      tokenEstimate: Number(row.token_estimate),
      content,
    };
  });
}

function abridgedTokenEstimate(content: string): number {
  return estimateTokens(deterministicTruncation(content));
}

/**
 * Compute a monotonic proposed visibility boundary that:
 * - starts at max(previousBoundary, compactPoint)
 * - never moves backward
 * - remains strictly before the earliest protected result event
 * - only advances across older unprotected tool_result rows
 *
 * When `targetZoneTokens` is provided, advances just far enough that the
 * remaining full zone (full protected + full unprotected ahead of boundary)
 * is at or under the target, preferring the smallest advance that meets it.
 * When omitted, computes the maximal legal advance (for insufficiency proofs).
 */
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

  // Strictly before earliest protected result; if none, may advance through all eligible.
  const maxLegalBoundary =
    earliestProtectedResultOrder === null ? Number.MAX_SAFE_INTEGER : earliestProtectedResultOrder - 1;

  if (earliestProtectedResultOrder !== null && earliestProtectedResultOrder <= effectiveStart) {
    notes.push("earliest protected result is at or behind effective start; no eligible older unprotected rows");
  }

  // Eligible unprotected rows that can be crossed (result order <= maxLegalBoundary).
  const eligible = unprotectedRows.filter((r) => r.sourceEventOrder <= maxLegalBoundary);

  // Maximal advance: last eligible unprotected result order (or previous if none).
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
  // Boundary must stay strictly before protected results.
  if (earliestProtectedResultOrder !== null && maximalBoundary >= earliestProtectedResultOrder) {
    maximalBoundary = Math.max(previousBoundary, earliestProtectedResultOrder - 1);
  }

  function zoneFullAfter(boundary: number): number {
    // Full tokens for results with source_event_order > max(boundary, compactPoint)
    const start = Math.max(boundary, compactPoint);
    let sum = 0;
    for (const r of rows) {
      if (r.sourceEventOrder > start) sum += r.tokenEstimate;
    }
    return sum;
  }

  function prunedSavingsIfBoundary(boundary: number): number {
    // Results at-or-behind boundary and after compact point render abridged.
    let savings = 0;
    for (const r of unprotectedRows) {
      if (r.sourceEventOrder > compactPoint && r.sourceEventOrder <= boundary) {
        const full = r.tokenEstimate;
        const short = abridgedTokenEstimate(r.content);
        savings += Math.max(0, full - short);
      }
    }
    // Protected must never be abridged — if boundary would abridge them, illegal.
    return savings;
  }

  let proposedBoundary = previousBoundary;
  const target = opts.targetZoneTokens;

  if (target === undefined) {
    proposedBoundary = maximalBoundary;
  } else if (zoneFullAfter(previousBoundary) <= target) {
    proposedBoundary = previousBoundary;
  } else {
    // Walk eligible rows oldest-first, advancing boundary to each unprotected result
    // until zone is under target or maximal legal boundary is reached.
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

  // Never move backward; clamp to legal.
  if (proposedBoundary < previousBoundary) proposedBoundary = previousBoundary;
  if (earliestProtectedResultOrder !== null && proposedBoundary >= earliestProtectedResultOrder) {
    proposedBoundary = Math.max(previousBoundary, earliestProtectedResultOrder - 1);
    notes.push("clamped proposed boundary strictly before earliest protected result");
  }

  // Pruned estimate: eligible unprotected at-or-behind proposed boundary.
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
    // Should be impossible after clamp; hard guard.
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
