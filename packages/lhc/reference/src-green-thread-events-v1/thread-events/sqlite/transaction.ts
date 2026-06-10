import type { LhcSqliteHandle } from "./open.js";

export function withImmediateTransaction<T>(handle: LhcSqliteHandle, fn: () => T): T {
  const { db } = handle;
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
