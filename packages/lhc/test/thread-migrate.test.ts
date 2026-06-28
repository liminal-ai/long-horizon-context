import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { threads } from "../src/index.js";
import { getSchemaVersion } from "../src/shared-tech/storage.js";
import { THREAD_SCHEMA_VERSION_1 } from "../src/shared-tech/thread-migrate.js";
import { openThreadDatabase } from "../src/threads/internal/create.js";
import { type TempStore, tempStore } from "./fixtures/index.js";

let store: TempStore;

beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
});

function simulateV1Thread(filePath: string): void {
  const db = new DatabaseSync(filePath);
  try {
    db.exec("DROP TABLE IF EXISTS derivation_log;");
    db.exec(`PRAGMA user_version = ${THREAD_SCHEMA_VERSION_1};`);
  } finally {
    db.close();
  }
}

describe("thread schema migration", () => {
  it("opens a v1 thread file, migrates derivation_log, and preserves existing data", async () => {
    const filePath = store.threadPath();
    const created = await threads.newThread({ filePath, registryPath: store.registryPath });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const threadId = created.value.threadId;
    simulateV1Thread(filePath);

    const before = new DatabaseSync(filePath, { readOnly: true });
    try {
      expect(getSchemaVersion(before)).toBe(THREAD_SCHEMA_VERSION_1);
      expect(
        before.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'derivation_log'").get(),
      ).toBeUndefined();
    } finally {
      before.close();
    }

    const opened = openThreadDatabase(filePath);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const db = opened.value;
    try {
      expect(getSchemaVersion(db)).toBe(2);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'derivation_log'").get(),
      ).toBeDefined();
      const metadata = db.prepare("SELECT thread_id FROM thread_metadata WHERE id = 1").get() as
        | { thread_id: string }
        | undefined;
      expect(metadata?.thread_id).toBe(threadId);
      const turnCount = db.prepare("SELECT COUNT(*) AS count FROM turns").get() as { count: number | bigint };
      expect(Number(turnCount.count)).toBe(1);
    } finally {
      db.close();
    }
  });
});
