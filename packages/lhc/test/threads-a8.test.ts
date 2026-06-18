// A-8 registry additions (pi-lhc Epic 02 Story 1 prerequisite): the cwd column,
// partial-id (prefix) resolve with ambiguity failure, the cwd-scoped listing,
// deterministic most-recent ordering, and lazy upgrade of a pre-cwd registry.
// These are the registry operations the connector's launch-driven thread
// resolution depends on; they are proven here at the registry boundary, not
// only through the connector (anti-shim: the scope is the query, not a filter
// over an unscoped list).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { threads } from "../src/index.js";
import { openRaw, type TempStore, tempStore } from "./fixtures/index.js";

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
});

async function create(opts: { title?: string; cwd?: string } = {}): Promise<string> {
  const input: { filePath: string; registryPath: string; title?: string; cwd?: string } = {
    filePath: store.threadPath(),
    registryPath: store.registryPath,
  };
  if (opts.title !== undefined) input.title = opts.title;
  if (opts.cwd !== undefined) input.cwd = opts.cwd;
  const result = await threads.newThread(input);
  if (!result.ok) throw new Error(`create failed: ${result.error.reason}`);
  return result.value.threadId;
}

describe("A-8: cwd column", () => {
  it("newThread stores cwd; resolve and listThreads carry it back", async () => {
    const id = await create({ cwd: "/work/project-a", title: "a" });

    const resolved = await threads.resolve({ threadId: id, registryPath: store.registryPath });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.value.cwd).toBe("/work/project-a");

    const listed = await threads.listThreads({ registryPath: store.registryPath });
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.value[0]?.cwd).toBe("/work/project-a");
  });

  it("a thread created with no cwd reports cwd undefined", async () => {
    const id = await create({ title: "no-cwd" });
    const resolved = await threads.resolve({ threadId: id, registryPath: store.registryPath });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.value.cwd).toBeUndefined();
  });
});

describe("A-8: partial-id resolve", () => {
  it("resolves a unique prefix to the one matching thread", async () => {
    const id = await create({ title: "only" });
    const prefix = id.slice(0, 8); // a true partial: shorter than the full id
    expect(prefix.length).toBeLessThan(id.length);

    const resolved = await threads.resolve({ threadId: prefix, registryPath: store.registryPath });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.value.threadId).toBe(id);
  });

  it("a full id still resolves exactly (exact match path)", async () => {
    const id = await create();
    const resolved = await threads.resolve({ threadId: id, registryPath: store.registryPath });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.value.threadId).toBe(id);
  });

  it("an ambiguous prefix fails ambiguous_thread_id and creates nothing", async () => {
    const a = await create();
    const b = await create();
    // Every id shares the "th_" scheme prefix, so it matches both threads.
    const ambiguous = await threads.resolve({ threadId: "th_", registryPath: store.registryPath });
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) {
      expect(ambiguous.error.code).toBe("ambiguous_thread_id");
      expect(ambiguous.error.errorClass).toBe("caller_error");
      expect(ambiguous.error.reason).toContain(a);
      expect(ambiguous.error.reason).toContain(b);
    }

    // No thread was created by the failed resolution.
    const listed = await threads.listThreads({ registryPath: store.registryPath });
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.value).toHaveLength(2);
  });

  it("an unresolvable id fails thread_not_found, never a silent match", async () => {
    await create();
    const missing = await threads.resolve({
      threadId: "th_zzzzzzzzzzzzzzzz", // 'z' is not in the hex id alphabet
      registryPath: store.registryPath,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("thread_not_found");
  });

  it("LIKE metacharacters in a partial id match literally, not as wildcards", async () => {
    await create();
    await create();
    // "_" is a LIKE single-char wildcard; unescaped it would match every id
    // (all begin "th_..."). Escaped, "th%" / "_" must be treated literally and
    // match nothing, since no id literally contains "%" or begins "th_%".
    const pct = await threads.resolve({ threadId: "th%", registryPath: store.registryPath });
    expect(pct.ok).toBe(false);
    if (!pct.ok) expect(pct.error.code).toBe("thread_not_found");
  });
});

describe("A-8: cwd-scoped listing and most-recent ordering", () => {
  it("listThreads({cwd}) returns only that cwd's threads", async () => {
    const a1 = await create({ cwd: "/work/a" });
    const a2 = await create({ cwd: "/work/a" });
    await create({ cwd: "/work/b" });

    const scoped = await threads.listThreads({ cwd: "/work/a", registryPath: store.registryPath });
    expect(scoped.ok).toBe(true);
    if (scoped.ok) {
      expect(scoped.value).toHaveLength(2);
      expect(new Set(scoped.value.map((t) => t.threadId))).toEqual(new Set([a1, a2]));
      for (const t of scoped.value) expect(t.cwd).toBe("/work/a");
    }

    const all = await threads.listThreads({ registryPath: store.registryPath });
    expect(all.ok).toBe(true);
    if (all.ok) expect(all.value).toHaveLength(3);
  });

  it("an empty cwd lists nothing without failing", async () => {
    await create({ cwd: "/work/a" });
    const empty = await threads.listThreads({ cwd: "/elsewhere", registryPath: store.registryPath });
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.value).toEqual([]);
  });

  it("the last listed thread is the most recently created (insertion-order tie-break)", async () => {
    await create({ title: "first" });
    await create({ title: "second" });
    const last = await create({ title: "third" });

    const listed = await threads.listThreads({ registryPath: store.registryPath });
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.value).toHaveLength(3);
      expect(listed.value.at(-1)?.threadId).toBe(last);
    }
  });
});

describe("A-8: lazy upgrade of a pre-cwd registry (migrate-on-read)", () => {
  it("reads a v1 registry, upgrading it to carry the cwd column", async () => {
    // Build a registry at the pre-A-8 v1 schema by hand (no cwd column).
    const db = openRaw(store.registryPath);
    db.exec(
      `CREATE TABLE threads (
        thread_id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        title TEXT,
        created_at TEXT NOT NULL
      );`,
    );
    db.exec(`PRAGMA user_version = 1;`);
    db.prepare("INSERT INTO threads (thread_id, file_path, title, created_at) VALUES (?, ?, ?, ?)").run(
      "th_legacy0000",
      "/tmp/legacy.sqlite",
      "legacy",
      "2026-01-01T00:00:00.000Z",
    );
    db.close();

    // A read through the domain upgrades the schema and succeeds; the legacy
    // row reports cwd undefined.
    const resolved = await threads.resolve({ threadId: "th_legacy0000", registryPath: store.registryPath });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.value.title).toBe("legacy");
      expect(resolved.value.cwd).toBeUndefined();
    }

    // The registry now carries the cwd column at the current version.
    const after = openRaw(store.registryPath);
    const columns = (after.prepare("PRAGMA table_info(threads)").all() as unknown as Array<{ name: string }>).map(
      (c) => c.name,
    );
    const version = after.prepare("PRAGMA user_version").get() as unknown as { user_version: number };
    after.close();
    expect(columns).toContain("cwd");
    expect(Number(version.user_version)).toBe(2);
  });
});
