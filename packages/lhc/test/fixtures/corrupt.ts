import { DatabaseSync } from "node:sqlite";

export function corruptTwoOpenTurns(path: string): void {
  const db = new DatabaseSync(path);
  try {
    const row = db.prepare("SELECT MAX(turn_order) AS max_order FROM turns").get() as
      | { max_order: number | bigint | null }
      | undefined;
    const nextOrder = Number(row?.max_order ?? 0) + 1;
    db.prepare("INSERT INTO turns (turn_id, turn_order, status, opened_at_event_order) VALUES (?, ?, 'open', ?)").run(
      `t${nextOrder}`,
      nextOrder,
      0,
    );
  } finally {
    db.close();
  }
}

const NOT_JSON = "{'unreadable': true,}";

export function poisonMessageBlockJson(path: string, messageId: string): void {
  const db = new DatabaseSync(path);
  try {
    db.prepare(`UPDATE message_block SET content = ? WHERE message_id = ?`).run(NOT_JSON, messageId);
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
