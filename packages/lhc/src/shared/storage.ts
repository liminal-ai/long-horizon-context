import { DatabaseSync } from "node:sqlite";

export interface Migration {
  version: number; // 1-based, strictly increasing
  statements: readonly string[];
}

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA synchronous = NORMAL;");
  return db;
}

// Epic 02's single migration (tech design §Storage): queue mechanical fields
// on the existing work_item table, the derived_form state table, the chunk
// tables, and the projection-level delete stamps. The whole epic's schema
// lands in one version — behavior arrives story by story. Assembled into the
// thread-file migration history by threads/internal/create.ts.
export const MIGRATION_V5_STATEMENTS: readonly string[] = [
  // claim mechanics on the existing table (DD-1: no disposition column —
  // queue rows are live work only; terminal rows are deleted and their
  // outcomes reported in-memory; durable outcome state lives on derived_form)
  `ALTER TABLE work_item ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE work_item ADD COLUMN last_error TEXT;`,
  `ALTER TABLE work_item ADD COLUMN claimed_at TEXT;`,
  `ALTER TABLE work_item ADD COLUMN claim_expires_at TEXT;`,
  `ALTER TABLE work_item ADD COLUMN eligible_at TEXT;`, // backoff gate; NULL = immediately eligible
  `ALTER TABLE work_item ADD COLUMN payload TEXT;`, // JSON: { sourceVersion?, form? }; id format includes sourceVersion
  // Tech design sketches (status, eligible_at, rowid); SQLite forbids rowid
  // inside an index definition, so the index covers the two real columns and
  // claimNext's ORDER BY rowid walks the head as before.
  `CREATE INDEX idx_work_item_queue ON work_item (status, eligible_at);`,
  // Call-id pairing index (Story 2): the tool-activity handlers' paired-read
  // and intake's AC-2.8 late-result lookup are each one indexed query by
  // call id — never a block scan (anti-shim requirement).
  `CREATE INDEX idx_message_block_tool_call_id
     ON message_block (block_type, json_extract(content, '$.toolCallId'));`,
  `CREATE TABLE derived_form (
    subject_kind TEXT NOT NULL CHECK (subject_kind IN ('message','turn','chunk')),
    subject_id   TEXT NOT NULL,
    form         TEXT NOT NULL,
    state        TEXT NOT NULL CHECK (state IN ('pending','ready','failed','blocked')),
    content      TEXT,
    reason       TEXT,
    metadata     TEXT,
    source_version INTEGER NOT NULL DEFAULT 1,
    gaps         TEXT,
    derived_at   TEXT,
    PRIMARY KEY (subject_kind, subject_id, form)
  );`,
  `CREATE TABLE chunk (
    chunk_id     TEXT PRIMARY KEY,
    chunk_order  INTEGER NOT NULL UNIQUE,
    status       TEXT NOT NULL CHECK (status IN ('open','closed')),
    accumulated_projected_tokens INTEGER NOT NULL DEFAULT 0
  );`,
  `CREATE TABLE chunk_member (
    chunk_id   TEXT NOT NULL REFERENCES chunk(chunk_id),
    turn_id    TEXT NOT NULL UNIQUE REFERENCES turns(turn_id),
    member_idx INTEGER NOT NULL,
    PRIMARY KEY (chunk_id, member_idx)
  );`,
  // projection-level delete (the record keeps everything; reads filter)
  `ALTER TABLE message ADD COLUMN deleted_at TEXT;`,
  `ALTER TABLE turns   ADD COLUMN deleted_at TEXT;`,
  // F-02 backfill: pending form rows for work queued before v5 existed, so
  // UPDATE-only completion finds them (row missing must mean deleted).
  `INSERT INTO derived_form (subject_kind, subject_id, form, state, source_version)
    SELECT 'message', json_extract(source_ref, '$.messageId'), 'smoothed_prompt', 'pending', 1
    FROM work_item WHERE status = 'queued' AND kind = 'prompt_smoothing';`,
  `INSERT INTO derived_form (subject_kind, subject_id, form, state, source_version)
    SELECT 'message', json_extract(source_ref, '$.messageId'), 'tool_result_summary', 'pending', 1
    FROM work_item WHERE status = 'queued' AND kind = 'tool_result_summary';`,
  `INSERT INTO derived_form (subject_kind, subject_id, form, state, source_version)
    SELECT 'turn', json_extract(source_ref, '$.turnId'), 'turn_rendering', 'pending', 1
    FROM work_item WHERE status = 'queued' AND kind = 'turn_derivation';`,
  `INSERT INTO derived_form (subject_kind, subject_id, form, state, source_version)
    SELECT 'turn', json_extract(source_ref, '$.turnId'), 'lower_band_projection', 'pending', 1
    FROM work_item WHERE status = 'queued' AND kind = 'turn_derivation';`,
];

// Epic 03's single migration (tech design §Storage): the thread-view
// snapshot tables and the visibility boundary, living beside the record they
// render so a thread file stays self-contained and snapshot-portable.
// Singletons are CHECK-enforced structurally: one active view, one boundary
// row per thread. Assembled into the thread-file migration history by
// threads/internal/create.ts, like v5.
export const MIGRATION_V6_STATEMENTS: readonly string[] = [
  `CREATE TABLE thread_view (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),  -- one active view, enforced structurally
    view_id TEXT NOT NULL UNIQUE,        -- v<compact event order>, deterministic; receipts/materialize metadata
    created_at TEXT NOT NULL,            -- clock at compact; metadata source for materialize
    compact_point INTEGER NOT NULL,      -- event_order where the tail begins
    covered_from INTEGER NOT NULL,       -- oldest event_order represented in any band
    profile_name TEXT,                   -- null when explicit params
    config_json TEXT NOT NULL,           -- resolved bound + percentages
    arrangement_json TEXT NOT NULL,      -- ordered entries: {band, subjectKind, subjectId, formUsed, degraded}
    gaps_json TEXT NOT NULL,             -- [{band, subjectId, reason}]
    source_state_json TEXT NOT NULL      -- {maxEventOrder, formCounts} the compact saw — receipt/debug
  );`,
  `CREATE TABLE thread_view_band (
    view_id TEXT NOT NULL REFERENCES thread_view(view_id) ON DELETE CASCADE,
    band TEXT NOT NULL CHECK (band IN ('brief','detailed','smooth')),
    rendered_text TEXT NOT NULL,         -- the snapshot bytes served verbatim
    token_count INTEGER NOT NULL,
    PRIMARY KEY (view_id, band)
  );`,
  `CREATE TABLE view_boundary (
    thread_singleton INTEGER PRIMARY KEY CHECK (thread_singleton = 1),
    position INTEGER NOT NULL,           -- source event order; tool results at-or-behind render short
    updated_at TEXT NOT NULL
  );`,
  // Seed at position 0 (everything full) — the boundary row exists from
  // migration on, so the advance and the compact reset are UPDATE-only.
  `INSERT INTO view_boundary (thread_singleton, position, updated_at)
    VALUES (1, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));`,
];

export function getSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as
    | { user_version: number | bigint }
    | undefined;
  return Number(row?.user_version ?? 0);
}

export function runMigrations(
  db: DatabaseSync,
  migrations: readonly Migration[],
): void {
  let current = getSchemaVersion(db);
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  for (const migration of ordered) {
    if (migration.version <= current) continue;
    db.exec("BEGIN IMMEDIATE;");
    try {
      for (const statement of migration.statements) db.exec(statement);
      db.exec(`PRAGMA user_version = ${migration.version};`);
      db.exec("COMMIT;");
    } catch (cause) {
      db.exec("ROLLBACK;");
      throw cause;
    }
    current = migration.version;
  }
}
