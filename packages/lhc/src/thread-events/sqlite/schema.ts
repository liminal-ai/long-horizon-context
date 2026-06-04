import type { LhcSqliteHandle } from "./open.js";

export const LHC_THREAD_EVENTS_SCHEMA_VERSION = 1;

export function ensureLhcThreadEventsSchema(handle: LhcSqliteHandle): void {
  const { db } = handle;
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS thread (
      thread_id TEXT PRIMARY KEY,
      client_thread_id TEXT NOT NULL UNIQUE,
      title TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS event (
      thread_event_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES thread(thread_id) ON DELETE CASCADE,
      event_order INTEGER NOT NULL,
      schema_version TEXT NOT NULL,
      event_kind TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      actor_json TEXT NOT NULL,
      harness_json TEXT NOT NULL,
      origin_json TEXT,
      recorded_at TEXT NOT NULL,
      occurred_at TEXT,
      payload_json TEXT NOT NULL,
      UNIQUE(thread_id, event_order),
      UNIQUE(thread_id, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS message (
      message_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES thread(thread_id) ON DELETE CASCADE,
      message_order INTEGER NOT NULL,
      message_kind TEXT NOT NULL,
      actor_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      source_event_id TEXT NOT NULL REFERENCES event(thread_event_id) ON DELETE CASCADE,
      source_event_order INTEGER NOT NULL,
      UNIQUE(thread_id, message_order),
      UNIQUE(source_event_id)
    );

    CREATE TABLE IF NOT EXISTS message_block (
      block_id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES message(message_id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL REFERENCES thread(thread_id) ON DELETE CASCADE,
      block_order INTEGER NOT NULL,
      block_kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      source_event_id TEXT NOT NULL REFERENCES event(thread_event_id) ON DELETE CASCADE,
      source_event_order INTEGER NOT NULL,
      UNIQUE(message_id, block_order)
    );

    CREATE TABLE IF NOT EXISTS turn_trigger (
      trigger_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES thread(thread_id) ON DELETE CASCADE,
      turn_end_event_id TEXT NOT NULL REFERENCES event(thread_event_id) ON DELETE CASCADE,
      turn_end_event_order INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      claimed_at TEXT,
      completed_at TEXT,
      last_error TEXT,
      UNIQUE(thread_id, turn_end_event_order)
    );

    CREATE TABLE IF NOT EXISTS turn (
      turn_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES thread(thread_id) ON DELETE CASCADE,
      trigger_id TEXT NOT NULL UNIQUE REFERENCES turn_trigger(trigger_id) ON DELETE CASCADE,
      turn_order INTEGER NOT NULL,
      lifecycle_status TEXT NOT NULL,
      processing_status TEXT NOT NULL,
      start_event_id TEXT NOT NULL REFERENCES event(thread_event_id) ON DELETE CASCADE,
      end_event_id TEXT NOT NULL REFERENCES event(thread_event_id) ON DELETE CASCADE,
      start_event_order INTEGER NOT NULL,
      end_event_order INTEGER NOT NULL,
      source_message_ids_json TEXT NOT NULL,
      smooth_json TEXT NOT NULL,
      lower_band_projection_json TEXT NOT NULL,
      UNIQUE(thread_id, turn_order),
      UNIQUE(thread_id, end_event_order)
    );

    CREATE TABLE IF NOT EXISTS chunk (
      chunk_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES thread(thread_id) ON DELETE CASCADE,
      chunk_order INTEGER NOT NULL,
      lifecycle_status TEXT NOT NULL,
      source_turn_ids_json TEXT NOT NULL,
      smooth_text TEXT NOT NULL,
      lower_band_json TEXT,
      UNIQUE(thread_id, chunk_order)
    );

    PRAGMA user_version = ${LHC_THREAD_EVENTS_SCHEMA_VERSION};
  `);
}
