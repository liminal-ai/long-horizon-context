// Claim-attempt fencing and clean-exit handback.
//
// An expired claim is requeued in place (same work_item_id), so the id and
// status='claimed' no longer name one holder: a slow old holder and its retry
// would both match. Each claim bumps `claimAttempt` in the row's payload and
// the holder carries that number; every consume (success, terminal failure,
// deferral, delete, requeue) matches it too. Rows claimed before the counter
// existed carry none and their holders none, so NULL matches NULL.
//
// A process that exits cleanly hands back the claims it still holds (queued
// again, and any claimExpired mark cleared), so a normal one-shot exit
// mid-derivation never counts as an expiry; only a crash or kill expires.
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { databasePathFor } from "../storage.js";

export interface ClaimAttempt {
  workItemId: string;
  claimAttempt?: number | undefined;
}

/** WHERE clause naming one claim attempt; bind with claimParams(). */
export const OWNED_CLAIM_SQL = `work_item_id = ? AND status = 'claimed' AND json_extract(payload, '$.claimAttempt') IS ?`;

export function claimParams(claim: ClaimAttempt): [string, number | null] {
  return [claim.workItemId, claim.claimAttempt ?? null];
}

/** The claim UPDATE's SET fragment: take the claim and start a new attempt. */
export const TAKE_CLAIM_SET_SQL = `status = 'claimed', claimed_at = ?, claim_expires_at = ?,
  payload = json_set(payload, '$.claimAttempt', COALESCE(json_extract(payload, '$.claimAttempt'), 0) + 1)`;

const held = new Map<string, { path: string; workItemId: string; claimAttempt: number | null }>();
let exitHookInstalled = false;

function heldKey(path: string, claim: ClaimAttempt): string {
  return `${path}\u0000${claim.workItemId}\u0000${claim.claimAttempt ?? ""}`;
}

/** Record a claim this process now holds (no-op for a handle without a known path). */
export function noteClaimHeld(db: DatabaseSync, claim: ClaimAttempt): void {
  const path = databasePathFor(db);
  if (path === undefined) return;
  held.set(heldKey(path, claim), { path, workItemId: claim.workItemId, claimAttempt: claim.claimAttempt ?? null });
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", releaseHeldClaims);
  }
}

/** The claim is consumed or lost; this process no longer holds it. */
export function noteClaimDone(db: DatabaseSync, claim: ClaimAttempt): void {
  const path = databasePathFor(db);
  if (path !== undefined) held.delete(heldKey(path, claim));
}

/**
 * Hand every still-held claim back to the queue. Runs from the process "exit"
 * event (synchronous, like node:sqlite). Fenced to the attempt, so a claim that
 * expired and was taken by another process is left alone. Best effort: a
 * failure leaves the claim to expire as before.
 */
export function releaseHeldClaims(): number {
  const byPath = new Map<string, Array<{ workItemId: string; claimAttempt: number | null }>>();
  for (const claim of held.values()) {
    const list = byPath.get(claim.path) ?? [];
    list.push(claim);
    byPath.set(claim.path, list);
  }
  held.clear();
  let released = 0;
  for (const [path, claims] of byPath) {
    // A removed thread file stays removed: opening it would recreate it empty.
    if (!existsSync(path)) continue;
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path);
      db.exec("PRAGMA busy_timeout = 2000;");
      const release = db.prepare(
        `UPDATE work_item SET status = 'queued', claimed_at = NULL, claim_expires_at = NULL,
           payload = json_remove(payload, '$.claimExpired')
         WHERE ${OWNED_CLAIM_SQL}`,
      );
      for (const claim of claims) {
        released += Number(release.run(claim.workItemId, claim.claimAttempt).changes);
      }
    } catch {
      // best effort: the claim expires as it did before
    } finally {
      try {
        db?.close();
      } catch {
        // best effort
      }
    }
  }
  return released;
}
