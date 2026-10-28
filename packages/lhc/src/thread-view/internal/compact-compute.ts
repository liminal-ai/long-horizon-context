import type { DatabaseSync } from "node:sqlite";
import {
  type DbReadTransaction,
  type ErrorResult,
  type OpResult,
  resolveInstanceTokenEstimator,
  type ViewProfile,
} from "../../shared-tech/index.js";
import type { TokenEstimator } from "../../shared-tech/token-counting/index.js";
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
      if (material.kind === "blocked") continue;
      compactChunkMaterials.set(`${chunk.chunkId}/${derivationType}`, material);
    }
  }
  return { ok: true, value: compactChunkMaterials };
}

function eagerPlan(
  db: DatabaseSync,
  transaction: DbReadTransaction,
  opts: { signal?: { aborted: boolean } | undefined; includeChunkMaterials: boolean },
  estimator: TokenEstimator,
): OpResult<{ source: SelectionSource; sourceState: ArrangementSourceState }> {
  let inputs: SelectionInputs = readSelectionInputs(db, estimator);
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

  const estimator = resolveInstanceTokenEstimator("threadView.compact");
  let plan: { source: SelectionSource; sourceState: ArrangementSourceState };
  if (resolveCompactAlgorithm() === "legacy") {
    emitLegacyCompactDiagnostic();
    const eager = eagerPlan(db, transaction, opts, estimator);
    if (!eager.ok) return eager;
    plan = eager.value;
  } else {
    const bounded = createBoundedSelection(db, transaction, {
      includeChunkMaterials: opts.includeChunkMaterials,
      signal: opts.signal,
      tokenEstimator: estimator,
    });
    plan = { source: bounded.source, sourceState: bounded.sourceState };
  }

  let selection: SelectionResult;
  try {
    selection = walkArrangement(plan.source, {
      lowerBound: merged.lowerBound,
      percentages: merged.percentages,
      newestClosedProtection: merged.newestClosedProtection,
      tokenEstimator: estimator,
      ...(opts.compactPointUpperBound !== undefined ? { compactPointUpperBound: opts.compactPointUpperBound } : {}),
    });
  } catch (cause) {
    if (cause instanceof CompactStoppedError) return stoppedResult(cause.detail);
    throw cause;
  }

  const viewId = `v${plan.sourceState.maxEventOrder}`;
  const firstKeptMessageId = firstPiMappableMessagePast(db, selection.compactPoint);

  return {
    ok: true,
    value: { selection, sourceState: plan.sourceState, viewId, firstKeptMessageId },
  };
}
