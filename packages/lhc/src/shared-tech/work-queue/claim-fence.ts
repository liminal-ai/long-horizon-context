import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { databasePathFor } from "../storage.js";

export interface ClaimAttempt {
  workItemId: string;
  claimAttempt?: number | undefined;
}

export const OWNED_CLAIM_SQL = `work_item_id = ? AND status = 'claimed' AND json_extract(payload, '$.claimAttempt') IS ?`;

export function claimParams(claim: ClaimAttempt): [string, number | null] {
  return [claim.workItemId, claim.claimAttempt ?? null];
}

export const TAKE_CLAIM_SET_SQL = `status = 'claimed', claimed_at = ?, claim_expires_at = ?,
  payload = json_set(payload, '$.claimAttempt', COALESCE(json_extract(payload, '$.claimAttempt'), 0) + 1)`;

const held = new Map<string, { path: string; workItemId: string; claimAttempt: number | null }>();
let exitHookInstalled = false;

function heldKey(path: string, claim: ClaimAttempt): string {
  return `${path}\u0000${claim.workItemId}\u0000${claim.claimAttempt ?? ""}`;
}

export function noteClaimHeld(db: DatabaseSync, claim: ClaimAttempt): void {
  const path = databasePathFor(db);
  if (path === undefined) return;
  held.set(heldKey(path, claim), { path, workItemId: claim.workItemId, claimAttempt: claim.claimAttempt ?? null });
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", releaseHeldClaims);
  }
}

export function noteClaimDone(db: DatabaseSync, claim: ClaimAttempt): void {
  const path = databasePathFor(db);
  if (path !== undefined) held.delete(heldKey(path, claim));
}

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
    } finally {
      try {
        db?.close();
      } catch {}
    }
  }
  return released;
}
