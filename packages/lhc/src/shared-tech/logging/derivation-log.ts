// Append-only execution history for inference-backed derivations. State stays
// compact (pending | ready | failed | blocked); this table carries the story.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { SubjectKind } from "../derivation.js";
import type { DbReadTransaction, DbWriteTransaction } from "../persist.js";
import { databasePathFor, openDatabase } from "../storage.js";

export type DerivationLogEventKind =
  | "inference_failed"
  | "inference_succeeded"
  | "fallback_applied"
  | "retry_scheduled"
  | "terminal_failed";

export interface DerivationLogTarget {
  subjectKind: SubjectKind;
  subjectId: string;
  derivationType: string;
}

export interface DerivationLogPayload {
  reason?: string;
  attempts?: number;
  fallbackFloor?: string;
  provenance?: { provider: string; model: string; prompt: string };
  [key: string]: unknown;
}

export interface DerivationLogEntry {
  target: DerivationLogTarget;
  eventKind: DerivationLogEventKind;
  payload: DerivationLogPayload;
}

export interface StoredDerivationLogEntry {
  logId: number;
  subjectKind: SubjectKind;
  subjectId: string;
  derivationType: string;
  eventKind: DerivationLogEventKind;
  payload: DerivationLogPayload;
  recordedAt: string;
}

export interface DerivationLogQuery {
  subjectKind?: SubjectKind;
  subjectId?: string;
  derivationType?: string;
  eventKind?: DerivationLogEventKind;
}

function insertDerivationLog(path: string, entry: DerivationLogEntry): void {
  let db: DatabaseSync | undefined;
  try {
    db = openDatabase(path);
    db.prepare(
      `INSERT INTO derivation_log (subject_kind, subject_id, derivation_type, event_kind, payload)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      entry.target.subjectKind,
      entry.target.subjectId,
      entry.target.derivationType,
      entry.eventKind,
      JSON.stringify(entry.payload),
    );
  } catch {
    // Fail-soft: logging must not affect derivation execution.
  } finally {
    db?.close();
  }
}

export function appendDerivationLog(
  transaction: DbReadTransaction | DbWriteTransaction,
  entry: DerivationLogEntry,
): void {
  const path = databasePathFor(transaction.db);
  if (path === undefined) return;
  if ("postCommitHook" in transaction) {
    transaction.postCommitHook.add(() => insertDerivationLog(path, entry));
    return;
  }
  insertDerivationLog(path, entry);
}

export function queryDerivationLog(db: DatabaseSync, q: DerivationLogQuery): StoredDerivationLogEntry[] {
  const conditions: string[] = [];
  const params: SQLInputValue[] = [];

  if (q.subjectKind !== undefined) {
    conditions.push("subject_kind = ?");
    params.push(q.subjectKind);
  }
  if (q.subjectId !== undefined) {
    conditions.push("subject_id = ?");
    params.push(q.subjectId);
  }
  if (q.derivationType !== undefined) {
    conditions.push("derivation_type = ?");
    params.push(q.derivationType);
  }
  if (q.eventKind !== undefined) {
    conditions.push("event_kind = ?");
    params.push(q.eventKind);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `
    SELECT log_id, subject_kind, subject_id, derivation_type, event_kind, payload, recorded_at
    FROM derivation_log
    ${whereClause}
    ORDER BY log_id ASC
  `;

  const rows = db.prepare(sql).all(...params) as unknown as Array<{
    log_id: number;
    subject_kind: string;
    subject_id: string;
    derivation_type: string;
    event_kind: string;
    payload: string;
    recorded_at: string;
  }>;

  return rows.map((row) => ({
    logId: row.log_id,
    subjectKind: row.subject_kind as SubjectKind,
    subjectId: row.subject_id,
    derivationType: row.derivation_type,
    eventKind: row.event_kind as DerivationLogEventKind,
    payload: JSON.parse(row.payload) as DerivationLogPayload,
    recordedAt: row.recorded_at,
  }));
}
