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

// Builds a thread file with the accepted Epic 01 on-disk schema (v4: the
// Story 5 work_item table, pre-Epic-02 column set, unversioned work-item
// ids), populated with a recorded conversation and live queued work. Current
// code can no longer create this shape — migration v5 runs at every open —
// so the fixture stands in for a real Epic 01 file at upgrade time (FC-0.5,
// F-02 backfill). Below-SDK writer, sanctioned like legacyStory2ThreadFile.
export function legacyEpic01ThreadFile(filePath: string, threadId: string): void {
  const db = new DatabaseSync(filePath);
  const recordedAt = "2026-06-09T00:00:00.000Z";
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
    ).run(threadId, recordedAt);
    db.exec(`CREATE TABLE event (
      event_order INTEGER PRIMARY KEY,
      event_kind TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      actor TEXT NOT NULL,
      harness TEXT NOT NULL,
      payload TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    );`);
    db.exec(`CREATE TABLE message (
      message_id TEXT PRIMARY KEY,
      source_event_order INTEGER NOT NULL UNIQUE REFERENCES event(event_order),
      kind TEXT NOT NULL,
      token_estimate INTEGER NOT NULL,
      actor TEXT NOT NULL,
      harness TEXT NOT NULL,
      turn_id TEXT
    );`);
    db.exec(`CREATE TABLE message_block (
      message_id TEXT NOT NULL REFERENCES message(message_id),
      block_index INTEGER NOT NULL,
      block_type TEXT NOT NULL,
      content TEXT NOT NULL,
      PRIMARY KEY (message_id, block_index)
    );`);
    db.exec(`CREATE TABLE turns (
      turn_id TEXT PRIMARY KEY,
      turn_order INTEGER NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
      opened_at_event_order INTEGER NOT NULL,
      closed_at_event_order INTEGER
    );`);
    db.exec(`CREATE TABLE work_item (
      work_item_id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      kind TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      status TEXT NOT NULL,
      queued_at TEXT NOT NULL
    );`);

    const insertEvent = db.prepare(
      `INSERT INTO event (event_order, event_kind, idempotency_key, actor, harness, payload, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const events: Array<[number, string, Record<string, unknown>]> = [
      [1, "user_prompt", { text: "legacy prompt recorded under epic 01" }],
      [2, "tool_call", { toolCallId: "call-legacy-1", toolName: "read_file", arguments: { path: "n.txt" } }],
      [3, "tool_result", { toolCallId: "call-legacy-1", content: "legacy tool output", isError: false }],
      [4, "turn_end", {}],
    ];
    for (const [order, kind, payload] of events) {
      insertEvent.run(
        order,
        kind,
        `legacy-epic01-key-${order}`,
        "legacy-actor",
        "legacy-harness",
        JSON.stringify(payload),
        recordedAt,
      );
    }

    const insertMessage = db.prepare(
      `INSERT INTO message (message_id, source_event_order, kind, token_estimate, actor, harness, turn_id)
       VALUES (?, ?, ?, ?, 'legacy-actor', 'legacy-harness', 't1')`,
    );
    insertMessage.run("m1", 1, "user_prompt", 9);
    insertMessage.run("m2", 2, "tool_call", 12);
    insertMessage.run("m3", 3, "tool_result", 7);
    const insertBlock = db.prepare(
      `INSERT INTO message_block (message_id, block_index, block_type, content)
       VALUES (?, 0, ?, ?)`,
    );
    insertBlock.run("m1", "text", JSON.stringify({ text: "legacy prompt recorded under epic 01" }));
    insertBlock.run(
      "m2",
      "tool_call",
      JSON.stringify({ toolCallId: "call-legacy-1", toolName: "read_file", arguments: { path: "n.txt" } }),
    );
    insertBlock.run(
      "m3",
      "tool_result",
      JSON.stringify({ toolCallId: "call-legacy-1", content: "legacy tool output", isError: false }),
    );

    db.prepare(
      `INSERT INTO turns (turn_id, turn_order, status, opened_at_event_order, closed_at_event_order)
       VALUES ('t1', 1, 'closed', 1, 4)`,
    ).run();

    // Live queued items with Epic 01's unversioned ids — exactly what the
    // F-02 backfill must cover with pending derived_form rows at version 1.
    const insertItem = db.prepare(
      `INSERT INTO work_item (work_item_id, owner, kind, source_ref, status, queued_at)
       VALUES (?, ?, ?, ?, 'queued', ?)`,
    );
    insertItem.run(
      "w-m1-prompt_smoothing",
      "messages",
      "prompt_smoothing",
      JSON.stringify({ messageId: "m1" }),
      recordedAt,
    );
    insertItem.run(
      "w-m3-tool_result_summary",
      "messages",
      "tool_result_summary",
      JSON.stringify({ messageId: "m3" }),
      recordedAt,
    );
    insertItem.run(
      "w-t1-turn_derivation",
      "turns",
      "turn_derivation",
      JSON.stringify({ turnId: "t1" }),
      recordedAt,
    );

    db.exec("PRAGMA user_version = 4;");
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
