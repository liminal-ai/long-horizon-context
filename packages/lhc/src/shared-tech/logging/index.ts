import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { DbReadTransaction, DbWriteTransaction } from "../persist.js";
import { databasePathFor, openDatabase } from "../storage.js";

export type LogLevel = "info" | "warning" | "error";

export interface LogEntry {
  level: LogLevel;
  message: string;
  derivationType?: string;
  subjectId?: string;
  reason?: string;
  floorUsed?: string;
}

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
  } finally {
    db?.close();
  }
}

export function writeLog(transaction: DbReadTransaction | DbWriteTransaction, entry: LogEntry): void {
  const path = databasePathFor(transaction.db);
  if (path === undefined) return;
  if ("postCommitHook" in transaction) {
    transaction.postCommitHook.add(() => insertLog(path, entry));
    return;
  }
  insertLog(path, entry);
}

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

export {
  appendDerivationLog,
  type DerivationLogEntry,
  type DerivationLogEventKind,
  type DerivationLogPayload,
  type DerivationLogQuery,
  type DerivationLogTarget,
  queryDerivationLog,
  type StoredDerivationLogEntry,
} from "./derivation-log.js";
