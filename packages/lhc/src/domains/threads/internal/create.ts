import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { openDatabase, runMigrations } from "../../../shared/storage.js";
import { TOKEN_ESTIMATOR_ID } from "../../../tech-utils/token-counting/index.js";

// The one random id: its uniqueness scope is global across files and
// registries (design decision 7).
export function generateThreadId(): string {
  return `th_${randomBytes(8).toString("hex")}`;
}

// Schema v1 plus the metadata row land in one migration transaction, so the
// file either has its full schema and metadata row or creation fails whole.
// The interpolated values are all generated here (hex id, ISO timestamp,
// estimator constant) — never caller input.
export function createThreadFile(
  filePath: string,
  threadId: string,
  createdAt: string,
): void {
  const db = openDatabase(filePath);
  try {
    runMigrations(db, [
      {
        version: 1,
        statements: [
          `CREATE TABLE thread_metadata (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            thread_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            token_estimator TEXT NOT NULL
          );`,
          `INSERT INTO thread_metadata (id, thread_id, created_at, token_estimator)
           VALUES (1, '${threadId}', '${createdAt}', '${TOKEN_ESTIMATOR_ID}');`,
          `CREATE TABLE event (
            event_order INTEGER PRIMARY KEY,
            event_kind TEXT NOT NULL,
            idempotency_key TEXT NOT NULL UNIQUE,
            actor TEXT NOT NULL,
            harness TEXT NOT NULL,
            payload TEXT NOT NULL,
            recorded_at TEXT NOT NULL
          );`,
        ],
      },
    ]);
  } finally {
    db.close();
  }
}

// Compensation: removes the thread file and its WAL companions. Used when the
// registry insert fails after file creation (no registry row without its
// file) and when file creation itself fails partway.
export function deleteThreadFile(filePath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${filePath}${suffix}`, { force: true });
  }
}
