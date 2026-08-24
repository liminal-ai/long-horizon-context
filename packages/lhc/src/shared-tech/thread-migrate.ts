import type { DatabaseSync } from "node:sqlite";
import { CURRENT_THREAD_SCHEMA_VERSION, getSchemaVersion } from "./storage.js";

export const THREAD_SCHEMA_VERSION_1 = 1;
export const THREAD_SCHEMA_VERSION_2 = 2;
export const THREAD_SCHEMA_VERSION_3 = 3;
export const THREAD_SCHEMA_VERSION_4 = 4;
export const THREAD_SCHEMA_VERSION_5 = 5;
export const THREAD_SCHEMA_VERSION_6 = 6;
export const THREAD_SCHEMA_VERSION_7 = 7;
export const THREAD_SCHEMA_VERSION_8 = 8;
export const THREAD_SCHEMA_VERSION_9 = 9;
export const THREAD_SCHEMA_VERSION_10 = 10;
export const THREAD_SCHEMA_VERSION_11 = 11;
export const THREAD_SCHEMA_VERSION_12 = 12;

const OLD_DERIVATION_TYPE = "smooth_turn_compression";
const NEW_DERIVATION_TYPE = "detailed_turn_compression";
const OLD_PROMPT_NAME = "smooth-turn-compression-v1";
const NEW_PROMPT_NAME = "detailed-turn-compression-v1";

/** Schema v6: retrieval impression log — one row per requested entity per
 *  retrieval call (get_turns / get_messages). Idempotent statements shared by
 *  fresh create and the 5→6 migration. */
export function retrievalImpressionSchemaStatements(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS retrieval_impression (
      impression_id INTEGER PRIMARY KEY AUTOINCREMENT,
      call_id TEXT NOT NULL,
      surface TEXT NOT NULL,
      entity_kind TEXT NOT NULL CHECK (entity_kind IN ('turn','message')),
      entity_id TEXT NOT NULL,
      request_idx INTEGER NOT NULL,
      served INTEGER NOT NULL CHECK (served IN (0,1)),
      reason TEXT,
      tokens INTEGER,
      recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );`,
    `CREATE INDEX IF NOT EXISTS idx_retrieval_impression_entity ON retrieval_impression (entity_kind, entity_id);`,
    `CREATE INDEX IF NOT EXISTS idx_retrieval_impression_call ON retrieval_impression (call_id);`,
  ];
}

export function derivationLogSchemaStatements(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS derivation_log (
      log_id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_kind TEXT NOT NULL CHECK (subject_kind IN ('message','turn','chunk')),
      subject_id TEXT NOT NULL,
      derivation_type TEXT NOT NULL,
      event_kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );`,
    `CREATE INDEX IF NOT EXISTS idx_derivation_log_subject ON derivation_log (subject_kind, subject_id, derivation_type);`,
    `CREATE INDEX IF NOT EXISTS idx_derivation_log_event ON derivation_log (event_kind);`,
  ];
}

/**
 * Schema v7: compact-continuation writer claim + durable transition receipts.
 * Receipts are inspectable and not ordinary conversation history.
 * Used by 6→7 migration only (v7 receipt shape lacks terminal flag).
 */
export function compactContinuationSchemaStatements(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS compact_continuation_writer (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      claim TEXT NOT NULL CHECK (claim IN ('none', 'lhc')),
      attempt_id TEXT,
      claimed_at TEXT
    );`,
    `INSERT OR IGNORE INTO compact_continuation_writer (singleton, claim, attempt_id, claimed_at)
       VALUES (1, 'none', NULL, NULL);`,
    `CREATE TABLE IF NOT EXISTS compact_continuation_receipt (
      attempt_id TEXT PRIMARY KEY,
      recorded_at TEXT NOT NULL,
      outcome TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      refused INTEGER NOT NULL CHECK (refused IN (0, 1)),
      skipped INTEGER NOT NULL CHECK (skipped IN (0, 1)),
      continuation_turn_id TEXT,
      receipt_json TEXT NOT NULL,
      decision_json TEXT NOT NULL
    );`,
    `CREATE INDEX IF NOT EXISTS idx_compact_continuation_receipt_recorded
       ON compact_continuation_receipt (recorded_at DESC);`,
  ];
}

/**
 * Current (v10) compact-continuation tables for fresh create.
 * Writer + boundary + stage log + terminal receipts + attempt identity + force intent.
 * At most one unresolved boundary (partial unique index).
 */
export function compactContinuationCurrentSchemaStatements(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS compact_continuation_writer (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      claim TEXT NOT NULL CHECK (claim IN ('none', 'lhc')),
      attempt_id TEXT,
      claimed_at TEXT
    );`,
    `INSERT OR IGNORE INTO compact_continuation_writer (singleton, claim, attempt_id, claimed_at)
       VALUES (1, 'none', NULL, NULL);`,
    `CREATE TABLE IF NOT EXISTS compact_continuation_boundary (
      continuation_turn_id TEXT PRIMARY KEY,
      attempt_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'complete', 'failed_repairable')),
      marker_persisted INTEGER NOT NULL CHECK (marker_persisted IN (0, 1)),
      last_stage TEXT NOT NULL,
      forced_at TEXT NOT NULL,
      completed_at TEXT
    );`,
    `CREATE INDEX IF NOT EXISTS idx_compact_continuation_boundary_status
       ON compact_continuation_boundary (status);`,
    // At most one pending/failed_repairable boundary per thread.
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_compact_continuation_boundary_one_unresolved
       ON compact_continuation_boundary ((1))
       WHERE status IN ('pending', 'failed_repairable');`,
    `CREATE TABLE IF NOT EXISTS compact_continuation_stage_log (
      log_id INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      detail_json TEXT,
      recorded_at TEXT NOT NULL
    );`,
    `CREATE INDEX IF NOT EXISTS idx_compact_continuation_stage_attempt
       ON compact_continuation_stage_log (attempt_id, log_id);`,
    `CREATE TABLE IF NOT EXISTS compact_continuation_receipt (
      attempt_id TEXT PRIMARY KEY,
      recorded_at TEXT NOT NULL,
      outcome TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      refused INTEGER NOT NULL CHECK (refused IN (0, 1)),
      skipped INTEGER NOT NULL CHECK (skipped IN (0, 1)),
      terminal INTEGER NOT NULL CHECK (terminal IN (0, 1)),
      continuation_turn_id TEXT,
      receipt_json TEXT NOT NULL,
      decision_json TEXT NOT NULL
    );`,
    `CREATE INDEX IF NOT EXISTS idx_compact_continuation_receipt_recorded
       ON compact_continuation_receipt (recorded_at DESC);`,
    // intent_hash/intent_json store immutable operation identity (not retry posture).
    `CREATE TABLE IF NOT EXISTS compact_continuation_attempt (
      attempt_id TEXT PRIMARY KEY,
      intent_hash TEXT NOT NULL,
      intent_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );`,
    `CREATE TABLE IF NOT EXISTS compact_continuation_force_intent (
      attempt_id TEXT PRIMARY KEY,
      turn_end_idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('intent', 'applied', 'reconciled')),
      continuation_turn_id TEXT,
      recorded_at TEXT NOT NULL
    );`,
    // v11: post-core-install host validation (provider-neutral). Core never
    // claims the host body was validated inside LHC.
    `CREATE TABLE IF NOT EXISTS compact_continuation_host_validation (
      attempt_id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('awaiting', 'ok', 'failed')),
      reason TEXT,
      recorded_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`,
  ];
}

function migrateCompactContinuationV9(db: DatabaseSync): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS compact_continuation_attempt (
      attempt_id TEXT PRIMARY KEY,
      intent_hash TEXT NOT NULL,
      intent_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );`,
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS compact_continuation_force_intent (
      attempt_id TEXT PRIMARY KEY,
      turn_end_idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('intent', 'applied', 'reconciled')),
      continuation_turn_id TEXT,
      recorded_at TEXT NOT NULL
    );`,
  );
}

/** v10→v11: host validation status for post-core-install body acknowledgment. */
function migrateCompactContinuationV11(db: DatabaseSync): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS compact_continuation_host_validation (
      attempt_id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('awaiting', 'ok', 'failed')),
      reason TEXT,
      recorded_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`,
  );
}

/** v9→v10: enforce at most one unresolved compact-continuation boundary. */
function migrateCompactContinuationV10(db: DatabaseSync): void {
  const unresolved = db
    .prepare(
      `SELECT COUNT(*) AS n FROM compact_continuation_boundary
       WHERE status IN ('pending', 'failed_repairable')`,
    )
    .get() as { n: number | bigint };
  if (Number(unresolved.n) > 1) {
    throw new Error(
      `compact-continuation migration v10 refused: ${Number(unresolved.n)} unresolved boundaries (at most one allowed)`,
    );
  }
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_compact_continuation_boundary_one_unresolved
       ON compact_continuation_boundary ((1))
       WHERE status IN ('pending', 'failed_repairable');`,
  );
}

function migrateCompactContinuationV8(db: DatabaseSync): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS compact_continuation_boundary (
      continuation_turn_id TEXT PRIMARY KEY,
      attempt_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'complete', 'failed_repairable')),
      marker_persisted INTEGER NOT NULL CHECK (marker_persisted IN (0, 1)),
      last_stage TEXT NOT NULL,
      forced_at TEXT NOT NULL,
      completed_at TEXT
    );`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_compact_continuation_boundary_status
       ON compact_continuation_boundary (status);`,
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS compact_continuation_stage_log (
      log_id INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      detail_json TEXT,
      recorded_at TEXT NOT NULL
    );`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_compact_continuation_stage_attempt
       ON compact_continuation_stage_log (attempt_id, log_id);`,
  );
  // Rebuild receipt table with terminal column.
  db.exec(
    `CREATE TABLE compact_continuation_receipt_v8 (
      attempt_id TEXT PRIMARY KEY,
      recorded_at TEXT NOT NULL,
      outcome TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      refused INTEGER NOT NULL CHECK (refused IN (0, 1)),
      skipped INTEGER NOT NULL CHECK (skipped IN (0, 1)),
      terminal INTEGER NOT NULL CHECK (terminal IN (0, 1)),
      continuation_turn_id TEXT,
      receipt_json TEXT NOT NULL,
      decision_json TEXT NOT NULL
    );`,
  );
  db.exec(
    `INSERT INTO compact_continuation_receipt_v8 (
       attempt_id, recorded_at, outcome, reason_code, refused, skipped, terminal,
       continuation_turn_id, receipt_json, decision_json
     )
     SELECT attempt_id, recorded_at, outcome, reason_code, refused, skipped, 1,
            continuation_turn_id, receipt_json, decision_json
     FROM compact_continuation_receipt`,
  );
  db.exec(`DROP TABLE compact_continuation_receipt;`);
  db.exec(`ALTER TABLE compact_continuation_receipt_v8 RENAME TO compact_continuation_receipt;`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_compact_continuation_receipt_recorded
       ON compact_continuation_receipt (recorded_at DESC);`,
  );
}

const OLD_PROMPT_JSON = `"prompt":"${OLD_PROMPT_NAME}"`;
const NEW_PROMPT_JSON = `"prompt":"${NEW_PROMPT_NAME}"`;

function migrateDetailedTurnCompressionRename(db: DatabaseSync): void {
  db.prepare(`UPDATE derivation SET derivation_type = ? WHERE derivation_type = ?`).run(
    NEW_DERIVATION_TYPE,
    OLD_DERIVATION_TYPE,
  );
  db.prepare(`UPDATE derivation_log SET derivation_type = ? WHERE derivation_type = ?`).run(
    NEW_DERIVATION_TYPE,
    OLD_DERIVATION_TYPE,
  );
  db.prepare(`UPDATE log SET derivation_type = ? WHERE derivation_type = ?`).run(
    NEW_DERIVATION_TYPE,
    OLD_DERIVATION_TYPE,
  );
  db.prepare(`UPDATE derivation SET metadata = REPLACE(metadata, ?, ?) WHERE metadata LIKE ?`).run(
    OLD_PROMPT_JSON,
    NEW_PROMPT_JSON,
    `%${OLD_PROMPT_JSON}%`,
  );
  db.prepare(`UPDATE derivation_log SET payload = REPLACE(payload, ?, ?) WHERE payload LIKE ?`).run(
    OLD_PROMPT_JSON,
    NEW_PROMPT_JSON,
    `%${OLD_PROMPT_JSON}%`,
  );
  db.prepare(`UPDATE log SET message = REPLACE(message, ?, ?) WHERE message LIKE ?`).run(
    OLD_DERIVATION_TYPE,
    NEW_DERIVATION_TYPE,
    `%${OLD_DERIVATION_TYPE}%`,
  );
  db.prepare(
    `UPDATE thread_view SET
       arrangement_json = REPLACE(arrangement_json, ?, ?),
       gaps_json = REPLACE(gaps_json, ?, ?),
       source_state_json = REPLACE(source_state_json, ?, ?)
     WHERE arrangement_json LIKE ?
        OR gaps_json LIKE ?
        OR source_state_json LIKE ?`,
  ).run(
    OLD_DERIVATION_TYPE,
    NEW_DERIVATION_TYPE,
    OLD_DERIVATION_TYPE,
    NEW_DERIVATION_TYPE,
    OLD_DERIVATION_TYPE,
    NEW_DERIVATION_TYPE,
    `%${OLD_DERIVATION_TYPE}%`,
    `%${OLD_DERIVATION_TYPE}%`,
    `%${OLD_DERIVATION_TYPE}%`,
  );
}

interface QueuedWorkItemPayload {
  sourceVersion?: number;
  operation?: string;
  derivations?: Array<{ subjectKind: string; subjectId: string; derivationType: string }>;
}

const LEGACY_TURN_DERIVATION_COMPRESSION_TYPES = new Set([OLD_DERIVATION_TYPE, NEW_DERIVATION_TYPE]);

function turnDerivationPayloadNeedsPreDetailedAssembly(payload: QueuedWorkItemPayload): boolean {
  const derivations = payload.derivations ?? [];
  if (!derivations.some((target) => target.derivationType === "turn_rendering")) return false;
  if (derivations.some((target) => target.derivationType === "pre_detailed_assembly")) return false;
  return derivations.some((target) => LEGACY_TURN_DERIVATION_COMPRESSION_TYPES.has(target.derivationType));
}

function migratedTurnDerivationTargets(turnId: string): Array<{
  subjectKind: "turn";
  subjectId: string;
  derivationType: "turn_rendering" | "pre_detailed_assembly";
}> {
  return [
    { subjectKind: "turn", subjectId: turnId, derivationType: "turn_rendering" },
    { subjectKind: "turn", subjectId: turnId, derivationType: "pre_detailed_assembly" },
  ];
}

// Pre-rewire turn_derivation items scheduled compression inside the same handler;
// rewrite their derivations payload and seed pre_detailed_assembly so item 1 can
// complete and enqueue compression. Idempotent — safe on every open.
function migrateQueuedTurnDerivationWorkItems(db: DatabaseSync): void {
  const rows = db
    .prepare(
      `SELECT work_item_id, source_ref, payload
       FROM work_item
       WHERE kind = 'turn_derivation' AND status IN ('queued', 'claimed')`,
    )
    .all() as Array<{ work_item_id: string; source_ref: string; payload: string }>;

  const updatePayload = db.prepare(`UPDATE work_item SET payload = ? WHERE work_item_id = ?`);
  const seedAssembly = db.prepare(
    `INSERT OR IGNORE INTO derivation (subject_kind, subject_id, derivation_type, state, source_version)
     VALUES ('turn', ?, 'pre_detailed_assembly', 'pending', ?)`,
  );
  const assemblyRowExists = db.prepare(
    `SELECT 1 AS present FROM derivation
     WHERE subject_kind = 'turn' AND subject_id = ? AND derivation_type = 'pre_detailed_assembly'`,
  );

  for (const row of rows) {
    const sourceRef = JSON.parse(row.source_ref) as { turnId?: string };
    const turnId = sourceRef.turnId;
    if (turnId === undefined) continue;

    const payload = JSON.parse(row.payload) as QueuedWorkItemPayload;
    const sourceVersion = payload.sourceVersion ?? 1;
    const needsPayloadMigration = turnDerivationPayloadNeedsPreDetailedAssembly(payload);
    const targetsPreDetailedAssembly = (payload.derivations ?? []).some(
      (target) => target.derivationType === "pre_detailed_assembly",
    );
    const needsAssemblySeed =
      needsPayloadMigration || (targetsPreDetailedAssembly && assemblyRowExists.get(turnId) === undefined);
    if (!needsPayloadMigration && !needsAssemblySeed) continue;

    if (needsAssemblySeed) {
      seedAssembly.run(turnId, sourceVersion);
    }
    if (needsPayloadMigration) {
      const nextPayload: QueuedWorkItemPayload = {
        ...payload,
        derivations: migratedTurnDerivationTargets(turnId),
      };
      updatePayload.run(JSON.stringify(nextPayload), row.work_item_id);
    }
  }
}

function runQueuedTurnDerivationMigration(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE;");
  try {
    migrateQueuedTurnDerivationWorkItems(db);
    db.exec("COMMIT;");
  } catch (cause) {
    db.exec("ROLLBACK;");
    throw cause;
  }
}

function migrateOneShotWorkQueue(db: DatabaseSync): void {
  db.exec("DROP INDEX idx_work_item_queue;");
  db.exec("ALTER TABLE work_item DROP COLUMN attempts;");
  db.exec("ALTER TABLE work_item DROP COLUMN last_error;");
  db.exec("ALTER TABLE work_item DROP COLUMN eligible_at;");
  db.exec("ALTER TABLE work_item DROP COLUMN claim_epoch;");
  db.exec("CREATE INDEX idx_work_item_queue ON work_item (status);");
}

// v4→v5: host-observed turn outcome/timing and per-call provider usage.
// Nullable columns only; no backfill — pre-v5 facts were never recorded.
function migrateTurnHostFacts(db: DatabaseSync): void {
  db.exec(`ALTER TABLE turns ADD COLUMN outcome TEXT CHECK (outcome IN ('completed', 'aborted') OR outcome IS NULL);`);
  db.exec(`ALTER TABLE turns ADD COLUMN outcome_reason TEXT;`);
  db.exec(`ALTER TABLE turns ADD COLUMN started_at TEXT;`);
  db.exec(`ALTER TABLE turns ADD COLUMN ended_at TEXT;`);
  db.exec(`ALTER TABLE message ADD COLUMN provider_usage TEXT;`);
}

// v11→v12: turn parts. Host-supplied step index on messages (F2) — nullable,
// no backfill: NULL means the host never reported a step edge, and a turn with
// any NULL step index is never split — and the per-thread parts-activated
// fact on thread_metadata (AC-7.3 exclusivity). Guarded so a crash-window
// reopen or a simulated-old file that already carries a column migrates
// cleanly.
function migrateTurnParts(db: DatabaseSync): void {
  const columns = (table: string): string[] =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
  if (!columns("message").includes("step_index")) db.exec(`ALTER TABLE message ADD COLUMN step_index INTEGER;`);
  // The durable per-thread mechanism fact: set once, in the transaction that
  // installs the first view serving parts; never cleared (AC-7.3).
  if (!columns("thread_metadata").includes("parts_activated_at")) {
    db.exec(`ALTER TABLE thread_metadata ADD COLUMN parts_activated_at TEXT;`);
  }
}

export function migrateThreadSchema(db: DatabaseSync): void {
  let version = getSchemaVersion(db);
  if (version >= CURRENT_THREAD_SCHEMA_VERSION) {
    runQueuedTurnDerivationMigration(db);
    return;
  }
  if (version < THREAD_SCHEMA_VERSION_1) {
    throw new Error(`unsupported thread schema version ${version}`);
  }

  db.exec("BEGIN IMMEDIATE;");
  try {
    if (version === THREAD_SCHEMA_VERSION_1) {
      for (const statement of derivationLogSchemaStatements()) db.exec(statement);
      version = THREAD_SCHEMA_VERSION_2;
    }
    if (version === THREAD_SCHEMA_VERSION_2) {
      migrateDetailedTurnCompressionRename(db);
      version = THREAD_SCHEMA_VERSION_3;
    }
    if (version === THREAD_SCHEMA_VERSION_3) {
      migrateQueuedTurnDerivationWorkItems(db);
      migrateOneShotWorkQueue(db);
      version = THREAD_SCHEMA_VERSION_4;
    }
    if (version === THREAD_SCHEMA_VERSION_4) {
      migrateTurnHostFacts(db);
      version = THREAD_SCHEMA_VERSION_5;
    }
    if (version === THREAD_SCHEMA_VERSION_5) {
      for (const statement of retrievalImpressionSchemaStatements()) db.exec(statement);
      version = THREAD_SCHEMA_VERSION_6;
    }
    if (version === THREAD_SCHEMA_VERSION_6) {
      for (const statement of compactContinuationSchemaStatements()) db.exec(statement);
      version = THREAD_SCHEMA_VERSION_7;
    }
    if (version === THREAD_SCHEMA_VERSION_7) {
      migrateCompactContinuationV8(db);
      version = THREAD_SCHEMA_VERSION_8;
    }
    if (version === THREAD_SCHEMA_VERSION_8) {
      migrateCompactContinuationV9(db);
      version = THREAD_SCHEMA_VERSION_9;
    }
    if (version === THREAD_SCHEMA_VERSION_9) {
      migrateCompactContinuationV10(db);
      version = THREAD_SCHEMA_VERSION_10;
    }
    if (version === THREAD_SCHEMA_VERSION_10) {
      migrateCompactContinuationV11(db);
      version = THREAD_SCHEMA_VERSION_11;
    }
    if (version === THREAD_SCHEMA_VERSION_11) {
      migrateTurnParts(db);
      version = THREAD_SCHEMA_VERSION_12;
    }
    if (version !== CURRENT_THREAD_SCHEMA_VERSION) {
      throw new Error(`unsupported thread schema version ${version}`);
    }
    db.exec(`PRAGMA user_version = ${CURRENT_THREAD_SCHEMA_VERSION};`);
    db.exec("COMMIT;");
  } catch (cause) {
    db.exec("ROLLBACK;");
    throw cause;
  }
}

export function isSupportedThreadSchemaVersion(version: number): boolean {
  return version >= THREAD_SCHEMA_VERSION_1 && version <= CURRENT_THREAD_SCHEMA_VERSION;
}
