// Builds a thread file with the accepted Story 2 on-disk schema (commit
// 7c8623d): thread_metadata + event tables only, PRAGMA user_version = 1.
// Current code can no longer create this shape — that is the point: the
// fixture stands in for a real file recorded before Story 3 shipped, so the
// lazy upgrade path (F-03-001) is exercised against the true legacy layout.
// Below-SDK writer, sanctioned for the same reason corrupt.ts is: the state
// is unreachable through the current SDK.
import { DatabaseSync } from "node:sqlite";

export interface LegacyRecordedEvent {
  eventOrder: number;
  eventKind: string;
  idempotencyKey: string;
  actor: string;
  harness: string;
  payload: Record<string, unknown>;
  recordedAt: string;
}

export function legacyStory2ThreadFile(
  filePath: string,
  threadId: string,
  recordedEvents: readonly LegacyRecordedEvent[] = [],
): void {
  const db = new DatabaseSync(filePath);
  try {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("BEGIN IMMEDIATE;");
    db.exec(`CREATE TABLE thread_metadata (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      thread_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      token_estimator TEXT NOT NULL
    );`);
    db.prepare(
      `INSERT INTO thread_metadata (id, thread_id, created_at, token_estimator)
       VALUES (1, ?, ?, 'js-tiktoken:o200k_base')`,
    ).run(threadId, "2026-06-01T00:00:00.000Z");
    db.exec(`CREATE TABLE event (
      event_order INTEGER PRIMARY KEY,
      event_kind TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      actor TEXT NOT NULL,
      harness TEXT NOT NULL,
      payload TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    );`);
    const insert = db.prepare(
      `INSERT INTO event (event_order, event_kind, idempotency_key, actor, harness, payload, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const event of recordedEvents) {
      insert.run(
        event.eventOrder,
        event.eventKind,
        event.idempotencyKey,
        event.actor,
        event.harness,
        JSON.stringify(event.payload),
        event.recordedAt,
      );
    }
    db.exec("PRAGMA user_version = 1;");
    db.exec("COMMIT;");
  } finally {
    db.close();
  }
}

export function schemaVersionOf(filePath: string): number {
  const db = new DatabaseSync(filePath);
  try {
    const row = db.prepare("PRAGMA user_version").get() as
      | { user_version: number | bigint }
      | undefined;
    return Number(row?.user_version ?? 0);
  } finally {
    db.close();
  }
}
