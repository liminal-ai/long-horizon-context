// Shared compact selection: the execution plan the environment selects, the
// band walk over it, and first-kept message identity. Both previewCompact and
// compact call this path so compactPoint prediction is exact by construction.
//
// Two plans, one walk. The bounded plan is the default; LHC_COMPACT_ALGORITHM
// selects the legacy eager plan (see compact-algorithm.ts). What either plan
// hands back — the arrangement and the source-state provenance the receipt and
// the stored view record — is the same shape, so nothing downstream of here
// knows which one ran.
import type { DatabaseSync } from "node:sqlite";
import type { DbReadTransaction, ErrorResult, OpResult, ViewProfile } from "../../shared-tech/index.js";
import * as turnsDomain from "../../turns/index.js";
import { CompactStoppedError, createBoundedSelection } from "./bounded-source.js";
import { emitLegacyCompactDiagnostic, resolveCompactAlgorithm } from "./compact-algorithm.js";
import type { CompactChunkMaterialSnapshot } from "./render.js";
import {
  type ArrangementSourceState,
  eagerSelectionSource,
  PI_MAPPABLE_MESSAGE_KINDS,
  readSelectionInputs,
  type SelectionInputs,
  type SelectionResult,
} from "./select.js";
import { type SelectionSource, walkArrangement } from "./walk.js";

export interface ArrangementComputeResult {
  selection: SelectionResult;
  sourceState: ArrangementSourceState;
  viewId: string;
  firstKeptMessageId: string | null;
}

export function compactStopped(signal: { aborted: boolean } | undefined): boolean {
  return signal?.aborted === true;
}

function stoppedResult(reason: string): { ok: false; error: ErrorResult } {
  return { ok: false, error: { errorClass: "caller_error", code: "compact_stopped", reason } };
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
): OpResult<Map<string, CompactChunkMaterialSnapshot>> {
  const compactChunkMaterials = new Map<string, CompactChunkMaterialSnapshot>();
  for (const chunk of inputs.chunks) {
    if (chunk.status !== "closed") continue;
    for (const derivationType of ["chunk_summary_detailed", "chunk_summary_brief"] as const) {
      if (compactStopped(signal)) {
        return stoppedResult("compact stopped during fallback assembly");
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

/** The legacy eager plan: read everything, resolve every closed chunk, then walk. */
function eagerPlan(
  db: DatabaseSync,
  transaction: DbReadTransaction,
  opts: { signal?: { aborted: boolean } | undefined; includeChunkMaterials: boolean },
): OpResult<{ source: SelectionSource; sourceState: ArrangementSourceState }> {
  let inputs: SelectionInputs = readSelectionInputs(db);
  if (opts.includeChunkMaterials) {
    const materials = resolveChunkMaterials(transaction, inputs, opts.signal);
    if (!materials.ok) return materials;
    inputs = { ...inputs, compactChunkMaterials: materials.value };
  }
  return { ok: true, value: { source: eagerSelectionSource(inputs), sourceState: inputs } };
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
    return stoppedResult("compact stopped before assembly");
  }

  let plan: { source: SelectionSource; sourceState: ArrangementSourceState };
  if (resolveCompactAlgorithm() === "legacy") {
    emitLegacyCompactDiagnostic();
    const eager = eagerPlan(db, transaction, opts);
    if (!eager.ok) return eager;
    plan = eager.value;
  } else {
    const bounded = createBoundedSelection(db, transaction, {
      includeChunkMaterials: opts.includeChunkMaterials,
      signal: opts.signal,
    });
    plan = { source: bounded.source, sourceState: bounded.sourceState };
  }

  let selection: SelectionResult;
  try {
    selection = walkArrangement(plan.source, {
      lowerBound: merged.lowerBound,
      percentages: merged.percentages,
      newestClosedProtection: merged.newestClosedProtection,
      ...(opts.compactPointUpperBound !== undefined ? { compactPointUpperBound: opts.compactPointUpperBound } : {}),
    });
  } catch (cause) {
    // The bounded plan reaches its material reads from inside the walk, so a
    // signal that trips there unwinds through it. Same outcome as the eager
    // plan's pre-walk check: compact stops, nothing is written.
    if (cause instanceof CompactStoppedError) return stoppedResult(cause.detail);
    throw cause;
  }

  const viewId = `v${plan.sourceState.maxEventOrder}`;
  // At compact point 0 this is the thread's first mappable message (rebuild
  // still needs an anchor). Null only when the thread has no mappable messages.
  const firstKeptMessageId = firstPiMappableMessagePast(db, selection.compactPoint);

  return {
    ok: true,
    value: { selection, sourceState: plan.sourceState, viewId, firstKeptMessageId },
  };
}
