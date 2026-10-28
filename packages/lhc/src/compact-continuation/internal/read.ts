import { compactContinuationMarkerIdempotencyKey } from "../../shared-tech/compact-continuation/index.js";
import { storageFailure } from "../../shared-tech/errors.js";
import type { OpResult } from "../../shared-tech/index.js";
import { createDbReadTransaction, createDbWriteTransaction } from "../../shared-tech/persist.js";
import type { ThreadRef } from "../../threads/index.js";
import { parseStoredOperationIdentity, type StoredOperationIdentity } from "./identity.js";
import {
  appendStageLog,
  type BoundaryRow,
  listBoundaries,
  listReceipts,
  listStageLog,
  markerExistsByIdempotencyKey,
  readAttemptIntent,
  readHostValidation,
  readPendingBoundary,
  readReceiptByAttemptId,
  readWriterClaim,
  recordHostValidationResult,
  type StoredCompactContinuationReceipt,
} from "./store.js";

export function errorDetail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export async function getCompactContinuationAttemptIntent(
  ref: ThreadRef,
  attemptId: string,
): Promise<OpResult<StoredOperationIdentity | null>> {
  if (typeof attemptId !== "string" || attemptId.length === 0) {
    return storageFailure("compact-continuation attempt intent requires a non-empty attemptId");
  }
  try {
    return await createDbReadTransaction(ref, (tx) => {
      const row = readAttemptIntent(tx.db, attemptId);
      if (row === null) return null;
      return parseStoredOperationIdentity(row);
    });
  } catch (cause) {
    return storageFailure(`compact-continuation attempt intent read failed: ${errorDetail(cause)}`);
  }
}

export async function getCompactContinuationReceipt(
  ref: ThreadRef,
  attemptId: string,
): Promise<OpResult<StoredCompactContinuationReceipt | null>> {
  try {
    return await createDbReadTransaction(ref, (tx) => readReceiptByAttemptId(tx.db, attemptId));
  } catch (cause) {
    return storageFailure(`compact-continuation receipt read failed: ${errorDetail(cause)}`);
  }
}

export async function listCompactContinuationReceipts(
  ref: ThreadRef,
  opts?: { limit?: number },
): Promise<OpResult<StoredCompactContinuationReceipt[]>> {
  try {
    return await createDbReadTransaction(ref, (tx) => listReceipts(tx.db, opts?.limit ?? 50));
  } catch (cause) {
    return storageFailure(`compact-continuation receipt list failed: ${errorDetail(cause)}`);
  }
}

export async function getCompactContinuationWriterClaim(
  ref: ThreadRef,
): Promise<OpResult<{ claim: "none" | "lhc"; attemptId: string | null; claimedAt: string | null }>> {
  try {
    return await createDbReadTransaction(ref, (tx) => readWriterClaim(tx.db));
  } catch (cause) {
    return storageFailure(`compact-continuation writer read failed: ${errorDetail(cause)}`);
  }
}

export async function hasCompactContinuationMarker(
  ref: ThreadRef,
  continuationTurnId: string,
): Promise<OpResult<boolean>> {
  try {
    return await createDbReadTransaction(ref, (tx) =>
      markerExistsByIdempotencyKey(tx.db, compactContinuationMarkerIdempotencyKey(continuationTurnId)),
    );
  } catch (cause) {
    return storageFailure(`compact-continuation marker probe failed: ${errorDetail(cause)}`);
  }
}

export async function getPendingCompactContinuationBoundary(ref: ThreadRef): Promise<OpResult<BoundaryRow | null>> {
  try {
    return await createDbReadTransaction(ref, (tx) => readPendingBoundary(tx.db));
  } catch (cause) {
    return storageFailure(`compact-continuation boundary read failed: ${errorDetail(cause)}`);
  }
}

export async function listCompactContinuationBoundaries(ref: ThreadRef): Promise<OpResult<BoundaryRow[]>> {
  try {
    return await createDbReadTransaction(ref, (tx) => listBoundaries(tx.db));
  } catch (cause) {
    return storageFailure(`compact-continuation boundary list failed: ${errorDetail(cause)}`);
  }
}

export async function listCompactContinuationStages(
  ref: ThreadRef,
  attemptId: string,
): Promise<OpResult<Array<{ stage: string; detail: Record<string, unknown> | null; recordedAt: string }>>> {
  try {
    return await createDbReadTransaction(ref, (tx) => listStageLog(tx.db, attemptId));
  } catch (cause) {
    return storageFailure(`compact-continuation stage log read failed: ${errorDetail(cause)}`);
  }
}

export async function recordCompactContinuationHostValidation(
  ref: ThreadRef,
  attemptId: string,
  result: "ok" | "failed",
  opts: { reason?: string; clock?: () => Date } = {},
): Promise<OpResult<{ attemptId: string; status: "ok" | "failed"; reason: string | null }>> {
  if (typeof attemptId !== "string" || attemptId.length === 0) {
    return storageFailure("host validation requires non-empty attemptId");
  }
  if (result !== "ok" && result !== "failed") {
    return storageFailure("host validation result must be ok|failed");
  }
  const clock = opts.clock ?? (() => new Date());
  try {
    return await createDbWriteTransaction(
      ref,
      (tx) => {
        const row = recordHostValidationResult(tx.db, attemptId, result, clock().toISOString(), opts.reason);
        appendStageLog(tx.db, attemptId, "receipt_recorded", clock().toISOString(), {
          hostValidation: result,
          reason: opts.reason ?? null,
        });
        return {
          attemptId,
          status: row.status === "ok" || row.status === "failed" ? row.status : result,
          reason: row.reason,
        };
      },
      clock,
    );
  } catch (cause) {
    return storageFailure(`host validation record failed: ${errorDetail(cause)}`);
  }
}

export async function getCompactContinuationHostValidation(
  ref: ThreadRef,
  attemptId: string,
): Promise<OpResult<{ attemptId: string; status: "awaiting" | "ok" | "failed"; reason: string | null } | null>> {
  try {
    return await createDbReadTransaction(ref, (tx) => {
      const row = readHostValidation(tx.db, attemptId);
      if (row === null) return null;
      return { attemptId: row.attemptId, status: row.status, reason: row.reason };
    });
  } catch (cause) {
    return storageFailure(`host validation read failed: ${errorDetail(cause)}`);
  }
}
