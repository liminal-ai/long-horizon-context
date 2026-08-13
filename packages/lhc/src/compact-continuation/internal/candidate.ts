/**
 * Candidate serving-view material facts for compact-continuation.
 * Builds the same request structure hosts consume from prepared bands + live tail.
 */

import type { DatabaseSync } from "node:sqlite";
import type { CompactMaterialFacts } from "../../shared-tech/compact-continuation/index.js";
import { estimateTokens } from "../../shared-tech/token-counting/index.js";
import type { PreparedCompact } from "../../thread-view/index.js";
import { assembleView } from "../../thread-view/internal/assemble.js";
import { readBoundaryPosition } from "../../thread-view/internal/boundary.js";
import {
  hasThinkingText,
  isEmptyThinkingHusk,
  renderBandMessage,
  renderTailMessage,
  toolNamesByCallId,
} from "../../thread-view/internal/render.js";
import { readTailMessages, readViewSnapshot } from "../../thread-view/internal/snapshot.js";

export type CandidateAssembly = {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  candidateTokens: number;
  currentServedTokens: number;
  structuralIssues: string[];
  material: Omit<CompactMaterialFacts, "installSucceeds">;
};

/**
 * Assemble a candidate LHC request from prepared bands + current eligible tail
 * (after the prepared compact point), including any marker already in the tail.
 */
export function assembleCandidateFromPrepared(
  db: DatabaseSync,
  prepared: PreparedCompact,
  lowerTargetTokens: number,
): CandidateAssembly {
  const compactPoint = prepared.selection.compactPoint;
  const boundaryPosition = readBoundaryPosition(db);
  const tailRows = readTailMessages(db, compactPoint);
  const renderCtx = {
    boundaryPosition,
    toolNameByCallId: toolNamesByCallId(tailRows),
  };

  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const band of prepared.bands) {
    const msg = renderBandMessage(band.band, band.renderedText);
    messages.push({ role: msg.role, content: msg.content });
  }
  for (const row of tailRows) {
    if (isEmptyThinkingHusk(row)) continue;
    if (row.kind === "assistant_thinking" && !hasThinkingText(row)) continue;
    const msg = renderTailMessage(row, renderCtx);
    messages.push({ role: msg.role, content: msg.content });
  }

  const structuralIssues = validateRequestStructure(messages, tailRows);
  const candidateTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);

  // Current served view tokens in the same domain (assembled live).
  const current = assembleView(db);
  const currentServedTokens = current.entries.reduce((sum, e) => sum + estimateTokens(e.message.content), 0);

  const degraded = prepared.degraded.length > 0 || prepared.gaps.length > 0 || prepared.warnings.length > 0;
  const usefulReduction = candidateTokens < currentServedTokens;
  const structurallyValid = structuralIssues.length === 0 && messages.length > 0;
  const canProduce = structurallyValid;

  return {
    messages,
    candidateTokens,
    currentServedTokens,
    structuralIssues,
    material: {
      derivationsMissingOrFailed: degraded,
      lowerTargetMet: candidateTokens <= lowerTargetTokens,
      compactStructurallyValid: structurallyValid,
      usefulReduction,
      canProduceValidProviderRequest: canProduce,
    },
  };
}

function validateRequestStructure(
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  tailRows: ReturnType<typeof readTailMessages>,
): string[] {
  const issues: string[] = [];
  if (messages.length === 0) {
    issues.push("candidate has no messages");
  }
  // Tool call/result ordering in the open tail: every result's call must precede it.
  const callOrders = new Map<string, number>();
  for (const row of tailRows) {
    if (row.kind === "tool_call") {
      const id = row.blocks[0]?.content["toolCallId"];
      if (typeof id === "string") callOrders.set(id, row.sourceEventOrder);
    }
  }
  for (const row of tailRows) {
    if (row.kind !== "tool_result") continue;
    const id = row.blocks[0]?.content["toolCallId"];
    if (typeof id !== "string") {
      issues.push("tool_result missing toolCallId");
      continue;
    }
    const callOrder = callOrders.get(id);
    if (callOrder === undefined) {
      issues.push(`orphaned tool_result ${id} in candidate tail`);
    } else if (callOrder >= row.sourceEventOrder) {
      issues.push(`tool_call ${id} does not precede its result in candidate tail`);
    }
  }
  return issues;
}

/** Current served LHC token total (for reduction baselines without prepare). */
export function currentServedTokenTotal(db: DatabaseSync): number {
  const current = assembleView(db);
  return current.entries.reduce((sum, e) => sum + estimateTokens(e.message.content), 0);
}

export function readCurrentCompactPoint(db: DatabaseSync): number {
  const snapshot = readViewSnapshot(db);
  return snapshot?.compactPoint ?? 0;
}
