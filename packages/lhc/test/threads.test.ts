// Flow 1: thread creation, registry, resolution (TC-1.1, 1.2, 1.3, 1.5, 1.6
// plus lazy-init and read-path-equivalence supplementals). TC-1.4 is owned by
// Story 2 and lives in test/intake.test.ts.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TOKEN_ESTIMATOR_ID, threads } from "../src/index.js";
import { openRaw, type TempStore, tempStore } from "./fixtures/index.js";

interface MetadataRow {
  thread_id: string;
  created_at: string;
  token_estimator: string;
}

interface RegistryRow {
  thread_id: string;
  file_path: string;
  title: string | null;
  created_at: string;
}

function readMetadata(threadPath: string): MetadataRow {
  const db = openRaw(threadPath);
  try {
    return db
      .prepare("SELECT thread_id, created_at, token_estimator FROM thread_metadata")
      .get() as unknown as MetadataRow;
  } finally {
    db.close();
  }
}

function registryRows(registryPath: string): RegistryRow[] {
  const db = openRaw(registryPath);
  try {
    return db
      .prepare("SELECT thread_id, file_path, title, created_at FROM threads ORDER BY created_at, thread_id")
      .all() as unknown as RegistryRow[];
  } finally {
    db.close();
  }
}

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
});

describe("Flow 1 (SDK): thread creation, registry, resolution", () => {
  it("TC-1.1: create at a fresh path — file, metadata row, registry row", async () => {
    const threadPath = store.threadPath();
    const result = await threads.newThread({
      filePath: threadPath,
      title: "first thread",
      registryPath: store.registryPath,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.filePath).toBe(threadPath);
    expect(result.value.threadId).toMatch(/^th_[a-z0-9]+$/);
    expect(existsSync(threadPath)).toBe(true);

    // AC-1.3: the id reads back from the file alone, no registry involved.
    const metadata = readMetadata(threadPath);
    expect(metadata.thread_id).toBe(result.value.threadId);
    expect(metadata.token_estimator).toBe(TOKEN_ESTIMATOR_ID);
    expect(new Date(metadata.created_at).toISOString()).toBe(metadata.created_at);

    const rows = registryRows(store.registryPath);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      thread_id: result.value.threadId,
      file_path: threadPath,
      title: "first thread",
      created_at: metadata.created_at,
    });
  });

  it("TC-1.2: occupied path refused, file untouched, registry unchanged", async () => {
    const first = await threads.newThread({
      filePath: store.threadPath(),
      registryPath: store.registryPath,
    });
    expect(first.ok).toBe(true);

    const occupied = join(store.dir, "occupied.bin");
    const originalBytes = "pre-existing content that must survive";
    writeFileSync(occupied, originalBytes);

    const result = await threads.newThread({
      filePath: occupied,
      registryPath: store.registryPath,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("path_exists");
    expect(result.error.errorClass).toBe("caller_error");

    expect(readFileSync(occupied, "utf8")).toBe(originalBytes);
    expect(registryRows(store.registryPath)).toHaveLength(1);
  });

  it("TC-1.3: resolve known id returns path and metadata; unknown id fails thread_not_found", async () => {
    const threadPath = store.threadPath();
    const created = await threads.newThread({
      filePath: threadPath,
      title: "resolvable",
      registryPath: store.registryPath,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const known = await threads.resolve({
      threadId: created.value.threadId,
      registryPath: store.registryPath,
    });
    expect(known.ok).toBe(true);
    if (!known.ok) return;
    expect(known.value.threadId).toBe(created.value.threadId);
    expect(known.value.filePath).toBe(threadPath);
    expect(known.value.title).toBe("resolvable");
    expect(known.value.createdAt).toBe(readMetadata(threadPath).created_at);

    const unknown = await threads.resolve({
      threadId: "th_does_not_exist",
      registryPath: store.registryPath,
    });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.error.code).toBe("thread_not_found");
    expect(unknown.error.errorClass).toBe("caller_error");
  });

  it("TC-1.5: listing returns all rows; absent registry lists empty without creating a file", async () => {
    const created: Array<{ threadId: string; filePath: string }> = [];
    for (const title of ["one", "two", "three"]) {
      const result = await threads.newThread({
        filePath: store.threadPath(title),
        title,
        registryPath: store.registryPath,
      });
      expect(result.ok).toBe(true);
      if (result.ok) created.push(result.value);
    }

    const listed = await threads.listThreads({ registryPath: store.registryPath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value).toHaveLength(3);
    const byId = new Map(listed.value.map((info) => [info.threadId, info]));
    for (const [index, title] of ["one", "two", "three"].entries()) {
      const info = byId.get(created[index]!.threadId);
      expect(info).toBeDefined();
      expect(info?.filePath).toBe(created[index]!.filePath);
      expect(info?.title).toBe(title);
      expect(info?.createdAt).toBeTruthy();
    }

    const absentPath = join(store.dir, "never-written.sqlite");
    const empty = await threads.listThreads({ registryPath: absentPath });
    expect(empty.ok).toBe(true);
    if (!empty.ok) return;
    expect(empty.value).toEqual([]);
    expect(existsSync(absentPath)).toBe(false);
  });

  it("TC-1.6: registry insert failure compensates — thread file deleted, no registry, no orphan row", async () => {
    const blocker = join(store.dir, "blocker");
    writeFileSync(blocker, "a regular file where a directory must be");
    const badRegistry = join(blocker, "registry.sqlite");

    const threadPath = store.threadPath();
    const result = await threads.newThread({
      filePath: threadPath,
      registryPath: badRegistry,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorClass).toBe("system_error");
    expect(result.error.code).toBe("storage_failure");

    expect(existsSync(threadPath)).toBe(false);
    expect(existsSync(badRegistry)).toBe(false);
    expect(readFileSync(blocker, "utf8")).toBe("a regular file where a directory must be");
  });

  it("lazy-init supplemental: resolve against an absent registry returns thread_not_found and creates nothing", async () => {
    const absentPath = join(store.dir, "absent-registry.sqlite");
    const result = await threads.resolve({
      threadId: "th_anything",
      registryPath: absentPath,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("thread_not_found");
    expect(existsSync(absentPath)).toBe(false);
  });

  it("read-path equivalence: resolveThreadRef lands id and path references on the same file", async () => {
    const threadPath = store.threadPath();
    const created = await threads.newThread({
      filePath: threadPath,
      registryPath: store.registryPath,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const byId = await threads.resolveThreadRef({
      threadId: created.value.threadId,
      registryPath: store.registryPath,
    });
    const byPath = await threads.resolveThreadRef({ filePath: threadPath });
    expect(byId.ok).toBe(true);
    expect(byPath.ok).toBe(true);
    if (!byId.ok || !byPath.ok) return;
    expect(byId.value.filePath).toBe(threadPath);
    expect(byPath.value.filePath).toBe(threadPath);

    // Both reads reach the same thread: identical metadata through either ref.
    expect(readMetadata(byId.value.filePath).thread_id).toBe(created.value.threadId);
    expect(readMetadata(byPath.value.filePath).thread_id).toBe(created.value.threadId);

    const unknown = await threads.resolveThreadRef({
      threadId: "th_unknown",
      registryPath: store.registryPath,
    });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.error.code).toBe("thread_not_found");
  });

  // TC-1.4 (full id/path equivalence under message-events): Story 1's named
  // deferral, closed by Story 2 — the test lives in test/intake.test.ts.
});
