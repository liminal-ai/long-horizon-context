/**
 * LIM-133: live, WAL-aware thread-file validation.
 *
 * TypeScript is the canonical reference the Rust port must match exactly:
 * validation opens the live file read-only (so uncheckpointed WAL frames are
 * visible), never copies or hashes the database, and classifies every invalid
 * candidate as caller-vs-storage in one fixed taxonomy.
 */

import { closeSync, mkdirSync, openSync, readdirSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDeterministicInferenceCallbacks, initLhc } from "../src/index.js";
import { openDatabase } from "../src/shared-tech/storage.js";
import { createThreadFile, generateThreadId, openThreadDatabase } from "../src/threads/internal/create.js";
import { type TempStore, tempStore, validEvent } from "./fixtures/index.js";

// SQLite's user_version lives at byte offset 60 of the main database file
// header (4 bytes, big endian). Reading it straight off disk proves what the
// main file alone says, with no SQLite connection involved.
function mainFileUserVersion(filePath: string): number {
  const fd = openSync(filePath, "r");
  try {
    const header = Buffer.alloc(64);
    readSync(fd, header, 0, 64, 0);
    return header.readUInt32BE(60);
  } finally {
    closeSync(fd);
  }
}

let store: TempStore;

beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
});

describe("thread file validation is WAL-aware", () => {
  it("accepts a thread whose schema marker exists only in the WAL", () => {
    const filePath = store.threadPath("wal-only");
    createThreadFile(filePath, generateThreadId(), new Date().toISOString());

    // Push the main file back to "not an lhc thread file" and checkpoint that
    // state into the main database.
    const reset = openDatabase(filePath);
    reset.exec("PRAGMA user_version = 0;");
    reset.close();
    expect(mainFileUserVersion(filePath)).toBe(0);

    // Restore the marker on a connection that never checkpoints, and hold it
    // open so the change stays in the WAL only.
    const walOnly = openDatabase(filePath);
    walOnly.exec("PRAGMA wal_autocheckpoint = 0;");
    walOnly.exec("PRAGMA user_version = 12;");
    try {
      // The main file still says "no lhc schema version" ...
      expect(mainFileUserVersion(filePath)).toBe(0);
      // ... but validation reads the live database, WAL included.
      const opened = openThreadDatabase(filePath);
      expect(opened.ok).toBe(true);
      if (opened.ok) opened.value.close();
    } finally {
      walOnly.close();
    }
  });

  // Node runs node:sqlite synchronously on one thread, so the append below
  // cannot execute its SQLite work while the checkpoint and validation run in
  // the same turn: the append is initiated and left in flight, the WAL is
  // truncated, and validation reads the file in that state. This is sequence
  // and interleaving coverage; the genuine simultaneous-overlap proof lives in
  // the Rust suite, where separate OS threads can be forced to overlap.
  it("validates after a truncating checkpoint with an append in flight, without a torn or false identity", async () => {
    const filePath = store.threadPath("checkpoint-race");
    const sdk = initLhc({ mode: "manual", inferenceCallbacks: createDeterministicInferenceCallbacks() });
    const created = await sdk.threads.newThread({ filePath, registryPath: store.registryPath });
    expect(created.ok).toBe(true);

    const checkpointer = openDatabase(filePath);
    try {
      for (let round = 0; round < 25; round += 1) {
        const appended = sdk.intakeStream.messageEvents({ filePath }, [
          validEvent("runtime_note", { payload: { text: `round-${round}` } }),
        ]);
        checkpointer.exec("PRAGMA wal_checkpoint(TRUNCATE);");
        const opened = openThreadDatabase(filePath);
        expect(opened.ok, `round ${round}: ${opened.ok ? "" : opened.error.reason}`).toBe(true);
        if (opened.ok) opened.value.close();
        const result = await appended;
        expect(result.ok).toBe(true);
      }
    } finally {
      checkpointer.close();
    }
  });

  it("leaves the thread a normal WAL database — no snapshot copies beside it", () => {
    const filePath = store.threadPath("no-copies");
    createThreadFile(filePath, generateThreadId(), new Date().toISOString());
    const opened = openThreadDatabase(filePath);
    expect(opened.ok).toBe(true);
    if (opened.ok) opened.value.close();

    const entries = readdirSync(store.dir);
    // Only the database and its sanctioned SQLite sidecars.
    for (const entry of entries) {
      expect(entry).toMatch(/^(no-copies\.sqlite(-wal|-shm)?|registry\.sqlite(-wal|-shm)?)$/);
    }
  });
});

describe("invalid thread-file candidates keep their exact classification", () => {
  function candidatePath(name: string): string {
    return join(store.dir, `${name}.sqlite`);
  }

  it("missing file is a storage failure, not a caller error", () => {
    const result = openThreadDatabase(candidatePath("absent"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorClass).toBe("system_error");
    expect(result.error.code).toBe("storage_failure");
    expect(result.error.reason).toBe("could not inspect thread file: unable to open database file");
  });

  const callerCases: Array<[string, (path: string) => void, string]> = [
    [
      "non-database",
      (path) => writeFileSync(path, "this is definitely not a sqlite database file at all"),
      "file is not a database",
    ],
    [
      "schema0",
      (path) => {
        const db = new DatabaseSync(path);
        db.exec("CREATE TABLE unrelated (x);");
        db.close();
      },
      "no lhc schema version",
    ],
    [
      "unsupported-schema",
      (path) => {
        const db = new DatabaseSync(path);
        db.exec("CREATE TABLE unrelated (x); PRAGMA user_version = 99;");
        db.close();
      },
      "schema version 99, expected 1..12",
    ],
    [
      "missing-table",
      (path) => {
        const db = new DatabaseSync(path);
        db.exec("CREATE TABLE unrelated (x); PRAGMA user_version = 12;");
        db.close();
      },
      "no thread_metadata table",
    ],
    [
      "missing-metadata-row",
      (path) => {
        const db = new DatabaseSync(path);
        db.exec("CREATE TABLE thread_metadata (id INTEGER PRIMARY KEY, thread_id TEXT); PRAGMA user_version = 12;");
        db.close();
      },
      "no thread metadata row",
    ],
  ];

  for (const [name, build, detail] of callerCases) {
    it(`${name} is a caller error naming the reason`, () => {
      const path = candidatePath(name);
      build(path);
      const result = openThreadDatabase(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.errorClass).toBe("caller_error");
      expect(result.error.code).toBe("thread_not_found");
      expect(result.error.reason).toBe(`file at ${path} exists but is not an lhc thread file (${detail})`);
    });
  }

  it("a directory in the thread's place is a storage failure", () => {
    const path = candidatePath("a-directory");
    mkdirSync(path);
    const result = openThreadDatabase(path);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorClass).toBe("system_error");
    expect(result.error.code).toBe("storage_failure");
  });
});

describe("journal mode promotion happens once", () => {
  it("promotes a non-WAL file on first open and leaves an already-WAL file alone", () => {
    const filePath = store.threadPath("promote");
    const seed = new DatabaseSync(filePath);
    seed.exec("PRAGMA journal_mode = DELETE;");
    seed.exec("CREATE TABLE probe (x);");
    const seeded = seed.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(seeded.journal_mode.toLowerCase()).toBe("delete");
    seed.close();

    const first = openDatabase(filePath);
    expect((first.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode.toLowerCase()).toBe(
      "wal",
    );
    first.close();

    // Subsequent opens read the mode and skip the write form; the file stays
    // WAL and concurrent openers keep succeeding.
    for (let i = 0; i < 5; i += 1) {
      const again = openDatabase(filePath);
      expect((again.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode.toLowerCase()).toBe(
        "wal",
      );
      again.close();
    }
  });

  it("opens an already-WAL thread while another connection holds the write lock", () => {
    const filePath = store.threadPath("held-write-lock");
    createThreadFile(filePath, generateThreadId(), new Date().toISOString());
    const writer = openDatabase(filePath);
    writer.exec("BEGIN IMMEDIATE;");
    try {
      const opened = openDatabase(filePath);
      expect((opened.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode.toLowerCase()).toBe(
        "wal",
      );
      opened.close();
    } finally {
      writer.exec("ROLLBACK;");
      writer.close();
    }
  });
});
