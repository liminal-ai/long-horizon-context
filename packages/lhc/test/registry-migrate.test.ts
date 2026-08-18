/**
 * Registry schema migration (R15 / LIM-93): the alias map has to reach the
 * registry a host already has, not only a registry created after this build.
 * The pre-alias registry is the one in the field — schema created lazily on
 * first write, user_version never stamped.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { threads } from "../src/index.js";
import { getSchemaVersion } from "../src/shared-tech/storage.js";
import { openRegistryForWrite } from "../src/threads/internal/registry.js";
import {
  CURRENT_REGISTRY_SCHEMA_VERSION,
  REGISTRY_SCHEMA_VERSION_1,
} from "../src/threads/internal/registry-migrate.js";
import { type TempStore, tempStore } from "./fixtures/index.js";

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
});

interface ThreadListingRow {
  thread_id: string;
  file_path: string;
  title: string | null;
  created_at: string;
}

// A registry as builds before the alias map wrote it: the threads listing
// alone, created outside any transaction, with user_version left at 0.
function simulatePreAliasRegistry(registryPath: string, rows: ThreadListingRow[]): void {
  const db = new DatabaseSync(registryPath);
  try {
    db.exec(`CREATE TABLE threads (
      thread_id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      title TEXT,
      cwd TEXT,
      created_at TEXT NOT NULL
    );`);
    const insert = db.prepare("INSERT INTO threads (thread_id, file_path, title, cwd, created_at) VALUES (?,?,?,?,?)");
    for (const row of rows) insert.run(row.thread_id, row.file_path, row.title, null, row.created_at);
  } finally {
    db.close();
  }
}

function tableNames(registryPath: string): string[] {
  const db = new DatabaseSync(registryPath, { readOnly: true });
  try {
    const raws = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as unknown as {
      name: string;
    }[];
    return raws.map((raw) => raw.name);
  } finally {
    db.close();
  }
}

function readSchemaVersion(registryPath: string): number {
  const db = new DatabaseSync(registryPath, { readOnly: true });
  try {
    return getSchemaVersion(db);
  } finally {
    db.close();
  }
}

function readThreadListing(registryPath: string): ThreadListingRow[] {
  const db = new DatabaseSync(registryPath, { readOnly: true });
  try {
    return db
      .prepare("SELECT thread_id, file_path, title, created_at FROM threads ORDER BY thread_id")
      .all() as unknown as ThreadListingRow[];
  } finally {
    db.close();
  }
}

describe("registry schema migration", () => {
  it("a registry created fresh carries the alias map at the current version", async () => {
    const created = await threads.newThread({ filePath: store.threadPath(), registryPath: store.registryPath });
    expect(created.ok).toBe(true);

    expect(tableNames(store.registryPath)).toEqual(
      expect.arrayContaining(["threads", "thread_alias", "thread_current_alias"]),
    );
    expect(readSchemaVersion(store.registryPath)).toBe(CURRENT_REGISTRY_SCHEMA_VERSION);
  });

  it("an empty pre-alias registry migrates in place", async () => {
    simulatePreAliasRegistry(store.registryPath, []);
    expect(readSchemaVersion(store.registryPath)).toBe(0);
    expect(tableNames(store.registryPath)).toEqual(["threads"]);

    const resolved = await threads.resolveAlias({ alias: "claude-code:absent", registryPath: store.registryPath });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error.code).toBe("alias_not_found");

    expect(tableNames(store.registryPath)).toEqual(["thread_alias", "thread_current_alias", "threads"]);
    expect(readSchemaVersion(store.registryPath)).toBe(CURRENT_REGISTRY_SCHEMA_VERSION);
  });

  it("a populated pre-alias registry migrates in place, keeping every thread row", async () => {
    const existing: ThreadListingRow[] = [
      { thread_id: "th_0000000000000001", file_path: "/threads/one.sqlite", title: "one", created_at: "2026-08-01" },
      { thread_id: "th_0000000000000002", file_path: "/threads/two.sqlite", title: null, created_at: "2026-08-02" },
      {
        thread_id: "th_0000000000000003",
        file_path: "/threads/three.sqlite",
        title: "three",
        created_at: "2026-08-03",
      },
    ];
    simulatePreAliasRegistry(store.registryPath, existing);

    const registered = await threads.registerCurrentAlias({
      alias: "claude-code:11111111-1111-4111-8111-111111111111",
      threadId: "th_0000000000000002",
      registryPath: store.registryPath,
    });
    expect(registered.ok).toBe(true);

    expect(readSchemaVersion(store.registryPath)).toBe(CURRENT_REGISTRY_SCHEMA_VERSION);
    expect(readThreadListing(store.registryPath)).toEqual(existing);

    // The pre-existing threads are still resolvable through the paths that
    // never touch aliases.
    const listed = await threads.listThreads({ registryPath: store.registryPath });
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.value.map((info) => info.threadId)).toEqual(existing.map((row) => row.thread_id));

    const resolved = await threads.resolveAlias({
      alias: "claude-code:11111111-1111-4111-8111-111111111111",
      registryPath: store.registryPath,
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.value.threadId).toBe("th_0000000000000002");
  });

  it("migration is idempotent across repeated opens", () => {
    simulatePreAliasRegistry(store.registryPath, []);
    for (let i = 0; i < 3; i += 1) {
      const db = openRegistryForWrite(store.registryPath);
      db.close();
    }
    expect(readSchemaVersion(store.registryPath)).toBe(CURRENT_REGISTRY_SCHEMA_VERSION);
    expect(tableNames(store.registryPath)).toEqual(["thread_alias", "thread_current_alias", "threads"]);
  });

  it("a registry stamped past the current version opens untouched rather than refusing", async () => {
    simulatePreAliasRegistry(store.registryPath, []);
    const raw = new DatabaseSync(store.registryPath);
    raw.exec(`PRAGMA user_version = ${CURRENT_REGISTRY_SCHEMA_VERSION + 1};`);
    raw.close();

    const listed = await threads.listThreads({ registryPath: store.registryPath });
    expect(listed.ok).toBe(true);
    expect(readSchemaVersion(store.registryPath)).toBe(CURRENT_REGISTRY_SCHEMA_VERSION + 1);
  });

  it("version 1 is the listing-only registry the alias map is added to", () => {
    expect(REGISTRY_SCHEMA_VERSION_1).toBeLessThan(CURRENT_REGISTRY_SCHEMA_VERSION);
  });
});
