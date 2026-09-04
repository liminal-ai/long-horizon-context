// Per-thread queue shared by every injector process on this host. One sqlite
// file, WAL, the same primitive the relay uses for relay.sqlite: a crashed
// process leaves a readable row, and "who dispatches" is one BEGIN IMMEDIATE.
//
// Rows are messages. The dispatcher for a thread is whichever process holds
// the dispatchers row; it takes the earliest queued sender's rows as a bundle,
// sends them as one turn, and writes the same reply into each row. It steps
// down as soon as its own row is settled, so a sender's reply never waits on
// later senders' turns; the remaining waiters re-elect.
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export type MessageState = "queued" | "sending" | "done" | "failed";

export interface MessageRow {
  id: string;
  server: string;
  thread_id: string;
  sender: string;
  body: string;
  arrived_at: string;
  state: MessageState;
  pid: number | null;
  reply: string | null;
  error: string | null;
  turn_id: string | null;
  dispatched_at: string | null;
  settled_at: string | null;
}

export interface QueueKey {
  readonly server: string;
  readonly threadId: string;
}

export class InjectQueue {
  readonly #db: DatabaseSync;
  readonly #isAlive: (pid: number) => boolean;

  constructor(dbPath: string, isAlive: (pid: number) => boolean = processIsAlive) {
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    closeSync(openSync(dbPath, "a", 0o600));
    chmodSync(dbPath, 0o600);
    this.#db = new DatabaseSync(dbPath);
    this.#isAlive = isAlive;
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, server TEXT NOT NULL, thread_id TEXT NOT NULL,
        sender TEXT NOT NULL, body TEXT NOT NULL, arrived_at TEXT NOT NULL,
        state TEXT NOT NULL, pid INTEGER, reply TEXT, error TEXT, turn_id TEXT,
        dispatched_at TEXT, settled_at TEXT
      );
      CREATE INDEX IF NOT EXISTS messages_thread ON messages(server, thread_id, state);
      CREATE TABLE IF NOT EXISTS dispatchers (
        server TEXT NOT NULL, thread_id TEXT NOT NULL, pid INTEGER NOT NULL,
        since TEXT NOT NULL, PRIMARY KEY (server, thread_id)
      );
    `);
  }

  enqueue(input: QueueKey & { sender: string; body: string; arrivedAt: string; pid: number }): string {
    const id = randomUUID();
    this.#db
      .prepare(
        `INSERT INTO messages (id, server, thread_id, sender, body, arrived_at, state, pid)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
      )
      .run(id, input.server, input.threadId, input.sender, input.body, input.arrivedAt, input.pid);
    return id;
  }

  get(id: string): MessageRow | null {
    return (this.#db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow | undefined) ?? null;
  }

  hasQueued(key: QueueKey): boolean {
    return (
      this.#db
        .prepare("SELECT 1 FROM messages WHERE server = ? AND thread_id = ? AND state = 'queued' LIMIT 1")
        .get(key.server, key.threadId) !== undefined
    );
  }

  /** Become the thread's dispatcher: no row, our row, or a dead holder's row. */
  claimDispatcher(key: QueueKey, pid: number, now: string): boolean {
    let claimed = false;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const holder = this.#db
        .prepare("SELECT pid FROM dispatchers WHERE server = ? AND thread_id = ?")
        .get(key.server, key.threadId) as { pid: number } | undefined;
      if (!holder || holder.pid === pid || !this.#isAlive(holder.pid)) {
        this.#db
          .prepare(
            `INSERT INTO dispatchers (server, thread_id, pid, since) VALUES (?, ?, ?, ?)
             ON CONFLICT(server, thread_id) DO UPDATE SET pid = excluded.pid, since = excluded.since`,
          )
          .run(key.server, key.threadId, pid, now);
        claimed = true;
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    return claimed;
  }

  releaseDispatcher(key: QueueKey, pid: number): void {
    this.#db
      .prepare("DELETE FROM dispatchers WHERE server = ? AND thread_id = ? AND pid = ?")
      .run(key.server, key.threadId, pid);
  }

  /**
   * Rows a dead dispatcher left in `sending`: the turn may or may not have
   * gone out, so they fail rather than resend. Returns the ids failed.
   */
  failOrphans(key: QueueKey, now: string): string[] {
    const rows = this.#db
      .prepare("SELECT id, pid FROM messages WHERE server = ? AND thread_id = ? AND state = 'sending'")
      .all(key.server, key.threadId) as Array<{ id: string; pid: number | null }>;
    const failed: string[] = [];
    for (const row of rows) {
      if (row.pid !== null && this.#isAlive(row.pid)) continue;
      this.#db
        .prepare("UPDATE messages SET state = 'failed', error = ?, settled_at = ? WHERE id = ? AND state = 'sending'")
        .run("dispatcher died while this message was being sent; the turn may have gone out", now, row.id);
      failed.push(row.id);
    }
    return failed;
  }

  /**
   * The next bundle: every queued row of the sender whose earliest queued row
   * arrived first. Marked `sending` under our pid in the same transaction.
   */
  takeBundle(key: QueueKey, pid: number, now: string): MessageRow[] {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const first = this.#db
        .prepare(
          `SELECT sender FROM messages WHERE server = ? AND thread_id = ? AND state = 'queued'
           ORDER BY arrived_at, rowid LIMIT 1`,
        )
        .get(key.server, key.threadId) as { sender: string } | undefined;
      if (!first) {
        this.#db.exec("COMMIT");
        return [];
      }
      const rows = this.#db
        .prepare(
          `SELECT * FROM messages WHERE server = ? AND thread_id = ? AND state = 'queued' AND sender = ?
           ORDER BY arrived_at, rowid`,
        )
        .all(key.server, key.threadId, first.sender) as unknown as MessageRow[];
      const mark = this.#db.prepare(
        "UPDATE messages SET state = 'sending', pid = ?, dispatched_at = ? WHERE id = ? AND state = 'queued'",
      );
      for (const row of rows) mark.run(pid, now, row.id);
      this.#db.exec("COMMIT");
      return rows;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  settle(ids: readonly string[], outcome: { reply: string; turnId: string | null } | { error: string }, now: string): void {
    const done = this.#db.prepare(
      "UPDATE messages SET state = 'done', reply = ?, turn_id = ?, settled_at = ? WHERE id = ? AND state = 'sending'",
    );
    const failed = this.#db.prepare(
      "UPDATE messages SET state = 'failed', error = ?, settled_at = ? WHERE id = ? AND state = 'sending'",
    );
    for (const id of ids) {
      if ("reply" in outcome) done.run(outcome.reply, outcome.turnId, now, id);
      else failed.run(outcome.error, now, id);
    }
  }

  close(): void {
    this.#db.close();
  }
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
