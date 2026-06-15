import { DatabaseSync } from "node:sqlite";

// The one sanctioned below-SDK write in the test suite: inserts a second
// status='open' turn row, a state no public operation can produce (the state
// machine always closes before opening). Columns match the Story 4 turn
// schema in threads/internal/create.ts.
export function corruptTwoOpenTurns(path: string): void {
  const db = new DatabaseSync(path);
  try {
    const row = db
      .prepare("SELECT MAX(turn_order) AS max_order FROM turns")
      .get() as { max_order: number | bigint | null } | undefined;
    const nextOrder = Number(row?.max_order ?? 0) + 1;
    db.prepare(
      "INSERT INTO turns (turn_id, turn_order, status, opened_at_event_order) VALUES (?, ?, 'open', ?)",
    ).run(`t${nextOrder}`, nextOrder, 0);
  } finally {
    db.close();
  }
}

// Poison pills for the bounded no-load-everything proof (Epic 04 AC-3.1,
// SV-01-002): overwrite one message's block content — or its derived-form
// metadata — with bytes the production read's strict `JSON.parse` rejects, so
// any read that *loads* that row throws on parse. A bounded list that excludes
// the message must still succeed; a window that includes it must fail.
// Together that is positive proof the out-of-window row was never read, not
// merely absent from output.
//
// The value must still *store*: `message_block` carries the v5 expression
// index `json_extract(content, '$.toolCallId')`, re-evaluated on every write,
// and node:sqlite's json_extract refuses malformed JSON — so raw garbage is
// rejected at write time, never reaching the read under test. JSON5 threads
// the needle: json_extract accepts it (the index writes), while strict
// `JSON.parse` rejects single quotes and the trailing comma (the read throws).
const NOT_JSON = "{'unreadable': true,}";

export function poisonMessageBlockJson(path: string, messageId: string): void {
  const db = new DatabaseSync(path);
  try {
    db.prepare(`UPDATE message_block SET content = ? WHERE message_id = ?`).run(
      NOT_JSON,
      messageId,
    );
  } finally {
    db.close();
  }
}

export function poisonMessageFormJson(path: string, messageId: string): void {
  const db = new DatabaseSync(path);
  try {
    db.prepare(
      `UPDATE derivation SET metadata = ?
       WHERE subject_kind = 'message' AND subject_id = ?`,
    ).run(NOT_JSON, messageId);
  } finally {
    db.close();
  }
}
