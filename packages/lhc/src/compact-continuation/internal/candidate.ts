/**
 * Candidate serving-view material facts for compact-continuation.
 * Uses the same tail/band renderers as model-serving assembly.
 */

import type { DatabaseSync } from "node:sqlite";
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
import { readTailMessages, type TailMessageRow } from "../../thread-view/internal/snapshot.js";

export type CandidateAssembly = {
  /** Same string-role entries getLlmRequestContext serves. */
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  candidateTokens: number;
  currentServedTokens: number;
  structuralIssues: string[];
  material: {
    derivationsMissingOrFailed: boolean;
    lowerTargetMet: boolean;
    compactStructurallyValid: boolean;
    usefulReduction: boolean;
    canProduceValidProviderRequest: boolean;
  };
};

/**
 * Assemble a candidate LHC request from prepared bands + current eligible tail
 * using the same renderers as assembleView / getLlmRequestContext.
 */
export function assembleCandidateFromPrepared(
  db: DatabaseSync,
  prepared: PreparedCompact,
  lowerTargetTokens: number,
  opts: { boundaryPositionOverride?: number } = {},
): CandidateAssembly {
  const compactPoint = prepared.selection.compactPoint;
  const boundaryPosition =
    opts.boundaryPositionOverride !== undefined ? opts.boundaryPositionOverride : readBoundaryPosition(db);
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

  const structuralIssues = validateSettledTailStructure(tailRows);
  if (messages.length === 0) structuralIssues.push("candidate has no messages");

  const candidateTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  const current = assembleView(db);
  const currentServedTokens = current.entries.reduce((sum, e) => sum + estimateTokens(e.message.content), 0);

  const degraded = prepared.degraded.length > 0 || prepared.gaps.length > 0 || prepared.warnings.length > 0;
  const usefulReduction = candidateTokens < currentServedTokens;
  const structurallyValid = structuralIssues.length === 0;
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

/**
 * At a settled seam the open tail must not leave orphaned tool calls or results.
 * Validates call→result and result→call multiplicity/order/readable payloads.
 */
export function validateSettledTailStructure(tailRows: readonly TailMessageRow[]): string[] {
  const issues: string[] = [];
  const calls = new Map<string, { order: number; count: number }>();
  const results = new Map<string, { order: number; count: number; contentOk: boolean }>();

  for (const row of tailRows) {
    if (row.kind === "tool_call") {
      const id = row.blocks[0]?.content["toolCallId"];
      if (typeof id !== "string" || id.length === 0) {
        issues.push("tool_call missing toolCallId");
        continue;
      }
      const prev = calls.get(id);
      calls.set(id, { order: row.sourceEventOrder, count: (prev?.count ?? 0) + 1 });
      const args = row.blocks[0]?.content["arguments"];
      if (args === undefined || typeof args !== "object") {
        issues.push(`tool_call ${id} unreadable arguments`);
      }
    }
    if (row.kind === "tool_result") {
      const id = row.blocks[0]?.content["toolCallId"];
      if (typeof id !== "string" || id.length === 0) {
        issues.push("tool_result missing toolCallId");
        continue;
      }
      const content = row.blocks[0]?.content["content"];
      const contentOk = typeof content === "string";
      const prev = results.get(id);
      results.set(id, {
        order: row.sourceEventOrder,
        count: (prev?.count ?? 0) + 1,
        contentOk,
      });
      if (!contentOk) issues.push(`tool_result ${id} unreadable content`);
    }
  }

  for (const [id, call] of calls) {
    if (call.count > 1) issues.push(`duplicate tool_call ${id}`);
    const result = results.get(id);
    if (result === undefined) {
      // Settled seam must not leave open tool calls without results.
      issues.push(`unresolved tool_call ${id} at settled seam`);
    } else if (call.order >= result.order) {
      issues.push(`tool_call ${id} does not precede its result`);
    }
  }
  for (const [id, result] of results) {
    if (result.count > 1) issues.push(`duplicate tool_result ${id}`);
    if (!calls.has(id)) issues.push(`orphaned tool_result ${id}`);
  }
  return issues;
}
