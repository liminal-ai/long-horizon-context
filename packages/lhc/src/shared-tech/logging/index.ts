// The logging surface: a domain-blind tech-util for recording fallback
// events and diagnostics. LHC internals and the host extension both write
// through this surface. Writes are fail-soft and never share the caller's
// transaction. Queries return entries by actionable fields.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { DbReadTransaction, DbWriteTransaction } from "../persist.js";
import { databasePathFor, openDatabase } from "../storage.js";

export type LogLevel = "info" | "warning" | "error";

export interface LogEntry {
  level: LogLevel;
  message: string;
  derivationType?: string;
  subjectId?: string;
  reason?: string; // e.g. "not_ready" | "failed_floor"
  floorUsed?: string; // for fallback events
}

// Stored log entry as read from the database
export interface StoredLogEntry {
  logId: number;
  level: LogLevel;
  message: string;
  derivationType: string | null;
  subjectId: string | null;
  reason: string | null;
  floorUsed: string | null;
  recordedAt: string;
}

export interface LogQuery {
  level?: LogLevel;
  derivationType?: string;
  subjectId?: string;
  reason?: string;
}

function insertLog(path: string, entry: LogEntry): void {
  let db: DatabaseSync | undefined;
  try {
    db = openDatabase(path);
    db.prepare(
      `INSERT INTO log (level, message, derivation_type, subject_id, reason, floor_used)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      entry.level,
      entry.message,
      entry.derivationType ?? null,
      entry.subjectId ?? null,
      entry.reason ?? null,
      entry.floorUsed ?? null,
    );
  } catch {
    // Fail-soft: drop the log entry but do not propagate the error to the caller
    // The operation that produced this log entry continues unchanged.
  } finally {
    db?.close();
  }
}

// Write a log entry. Fail-soft: never throws to the caller, never shares
// the caller's transaction. A logging failure is contained and does not
// affect the operation that produced the log entry.
export function writeLog(transaction: DbReadTransaction | DbWriteTransaction, entry: LogEntry): void {
  const path = databasePathFor(transaction.db);
  if (path === undefined) return;
  if ("postCommitHook" in transaction) {
    transaction.postCommitHook.add(() => insertLog(path, entry));
    return;
  }
  insertLog(path, entry);
}

// Query log entries by actionable fields. Returns all matching entries in
// descending order of recorded_at (newest first).
export function queryLog(db: DatabaseSync, q: LogQuery): StoredLogEntry[] {
  const conditions: string[] = [];
  const params: SQLInputValue[] = [];

  if (q.level !== undefined) {
    conditions.push("level = ?");
    params.push(q.level);
  }
  if (q.derivationType !== undefined) {
    conditions.push("derivation_type = ?");
    params.push(q.derivationType);
  }
  if (q.subjectId !== undefined) {
    conditions.push("subject_id = ?");
    params.push(q.subjectId);
  }
  if (q.reason !== undefined) {
    conditions.push("reason = ?");
    params.push(q.reason);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `
    SELECT log_id, level, message, derivation_type, subject_id, reason, floor_used, recorded_at
    FROM log
    ${whereClause}
    ORDER BY recorded_at DESC
  `;

  const rows = db.prepare(sql).all(...params) as unknown as Array<{
    log_id: number;
    level: string;
    message: string;
    derivation_type: string | null;
    subject_id: string | null;
    reason: string | null;
    floor_used: string | null;
    recorded_at: string;
  }>;

  return rows.map((row) => ({
    logId: row.log_id,
    level: row.level as LogLevel,
    message: row.message,
    derivationType: row.derivation_type,
    subjectId: row.subject_id,
    reason: row.reason,
    floorUsed: row.floor_used,
    recordedAt: row.recorded_at,
  }));
}
