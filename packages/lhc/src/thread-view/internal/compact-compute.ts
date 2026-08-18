// Shared compact selection: readSelectionInputs, optional chunk-material
// resolution, selectArrangement, and first-kept message identity. Both
// previewCompact and compact call this path so compactPoint prediction is
// exact by construction.
import type { DatabaseSync } from "node:sqlite";
import type { DbReadTransaction, OpResult, ViewProfile } from "../../shared-tech/index.js";
import * as turnsDomain from "../../turns/index.js";
import {
  PI_MAPPABLE_MESSAGE_KINDS,
  readSelectionInputs,
  type SelectionInputs,
  type SelectionResult,
  selectArrangement,
} from "./select.js";

export interface ArrangementComputeResult {
  selection: SelectionResult;
  inputs: SelectionInputs;
  viewId: string;
  firstKeptMessageId: string | null;
}

export function compactStopped(signal: { aborted: boolean } | undefined): boolean {
  return signal?.aborted === true;
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
      // Stored members that cannot be read are not a reason to stop: leaving
      // the material out drops the entry to the band ladder's gap, which the
      // receipt names.
      if (material.kind === "blocked") continue;
      compactChunkMaterials.set(`${chunk.chunkId}/${derivationType}`, material);
    }
  }
  return { ok: true, value: compactChunkMaterials };
}

export function computeArrangement(
  db: DatabaseSync,
  transaction: DbReadTransaction,
  merged: ViewProfile,
  opts: {
    signal?: { aborted: boolean } | undefined;
    includeChunkMaterials: boolean;
    compactPointUpperBound?: number;
  },
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

  let inputs: SelectionInputs = readSelectionInputs(db);

  if (opts.includeChunkMaterials) {
    const materials = resolveChunkMaterials(transaction, inputs, opts.signal);
    if (!materials.ok) return materials;
    inputs = { ...inputs, compactChunkMaterials: materials.value };
  }

  const selection = selectArrangement(inputs, {
    lowerBound: merged.lowerBound,
    percentages: merged.percentages,
    ...(opts.compactPointUpperBound !== undefined ? { compactPointUpperBound: opts.compactPointUpperBound } : {}),
  });
  const viewId = `v${inputs.maxEventOrder}`;
  // At compact point 0 this is the thread's first mappable message (rebuild
  // still needs an anchor). Null only when the thread has no mappable messages.
  const firstKeptMessageId = firstPiMappableMessagePast(db, selection.compactPoint);

  return {
    ok: true,
    value: { selection, inputs, viewId, firstKeptMessageId },
  };
}
