// Shared compact selection: readSelectionInputs, optional chunk-material
// resolution, selectArrangement, and first-kept message identity. Both
// previewCompact and compact call this path so compactPoint prediction is
// exact by construction.
import type { DatabaseSync } from "node:sqlite";
import type { DbReadTransaction, OpResult, ViewProfile } from "../../shared-tech/index.js";
import * as turnsDomain from "../../turns/index.js";
import { countTurnMembers, selectOpenTurnIds } from "../../turns/internal/store.js";
import {
  CanonicalCorruptionError,
  readSelectionInputs,
  type SelectionInputs,
  type SelectionResult,
  selectArrangement,
} from "./select.js";

const PI_MAPPABLE_MESSAGE_KINDS = [
  "user_prompt",
  "assistant_text",
  "assistant_thinking",
  "tool_call",
  "tool_result",
  "model_change",
  "thinking_level_change",
] as const;

export interface ArrangementComputeResult {
  selection: SelectionResult;
  inputs: SelectionInputs;
  viewId: string;
  firstKeptMessageId: string | null;
}

export function compactStopped(signal: { aborted: boolean } | undefined): boolean {
  return signal?.aborted === true;
}

export function openTurnHasMembers(db: DatabaseSync): boolean {
  const openTurnIds = selectOpenTurnIds(db);
  if (openTurnIds.length !== 1) return false;
  return countTurnMembers(db, openTurnIds[0]!) > 0;
}

/** messageId of the first PI-mappable live message past the compact point. */
export function firstPiMappableMessagePast(db: DatabaseSync, compactPoint: number): string | null {
  const placeholders = PI_MAPPABLE_MESSAGE_KINDS.map(() => "?").join(", ");
  const row = db
    .prepare(
      `SELECT m.message_id
       FROM message m
       WHERE m.deleted_at IS NULL
         AND m.source_event_order > ?
         AND m.kind IN (${placeholders})
       ORDER BY m.source_event_order
       LIMIT 1`,
    )
    .get(compactPoint, ...PI_MAPPABLE_MESSAGE_KINDS) as { message_id: string } | undefined;
  return row?.message_id ?? null;
}

function resolveChunkMaterials(
  transaction: DbReadTransaction,
  inputs: SelectionInputs,
  signal: { aborted: boolean } | undefined,
): OpResult<Map<string, { kind: "ready"; content: string } | { kind: "concat"; content: string; reason: string }>> {
  const compactChunkMaterials = new Map<
    string,
    { kind: "ready"; content: string } | { kind: "concat"; content: string; reason: string }
  >();
  for (const chunk of inputs.chunks) {
    if (chunk.status !== "closed") continue;
    for (const derivationType of ["chunk_summary_detailed", "chunk_summary_brief"] as const) {
      if (compactStopped(signal)) {
        return {
          ok: false,
          error: {
            errorClass: "caller_error",
            code: "compact_stopped",
            reason: "compact stopped during fallback assembly",
          },
        };
      }
      const material = turnsDomain.getChunkText(transaction, chunk.chunkId, derivationType);
      if (material.kind === "blocked") {
        return {
          ok: false,
          error: {
            errorClass: "state_corruption",
            code: "source_damaged",
            reason: material.reason,
          },
        };
      }
      compactChunkMaterials.set(`${chunk.chunkId}/${derivationType}`, material);
    }
  }
  return { ok: true, value: compactChunkMaterials };
}

export function computeArrangement(
  db: DatabaseSync,
  transaction: DbReadTransaction,
  merged: ViewProfile,
  opts: { signal?: { aborted: boolean } | undefined; includeChunkMaterials: boolean },
): OpResult<ArrangementComputeResult> {
  if (compactStopped(opts.signal)) {
    return {
      ok: false,
      error: {
        errorClass: "caller_error",
        code: "compact_stopped",
        reason: "compact stopped before assembly",
      },
    };
  }

  let inputs: SelectionInputs;
  try {
    inputs = readSelectionInputs(db);
  } catch (cause) {
    if (cause instanceof CanonicalCorruptionError) {
      return {
        ok: false,
        error: { errorClass: "state_corruption", code: cause.code, reason: cause.message },
      };
    }
    throw cause;
  }

  if (opts.includeChunkMaterials) {
    const materials = resolveChunkMaterials(transaction, inputs, opts.signal);
    if (!materials.ok) return materials;
    inputs = { ...inputs, compactChunkMaterials: materials.value };
  }

  const selection = selectArrangement(inputs, {
    lowerBound: merged.lowerBound,
    percentages: merged.percentages,
  });
  const viewId = `v${inputs.maxEventOrder}`;
  const firstKeptMessageId = selection.compactPoint > 0 ? firstPiMappableMessagePast(db, selection.compactPoint) : null;

  return {
    ok: true,
    value: { selection, inputs, viewId, firstKeptMessageId },
  };
}
