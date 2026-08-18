/**
 * Registry alias map (R15 / LIM-93): one thread accumulates many opaque host
 * session aliases; exactly one of them is current. Any alias resolves to the
 * thread and to the alias that thread currently accepts.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { threads } from "../src/index.js";
import { type TempStore, tempStore } from "./fixtures/index.js";

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
});

const THREAD_A = "th_00000000000000aa";
const THREAD_B = "th_00000000000000bb";

function alias(name: string): string {
  return `claude-code:${name}`;
}

async function createThread(): Promise<string> {
  const created = await threads.newThread({ filePath: store.threadPath(), registryPath: store.registryPath });
  if (!created.ok) throw new Error(created.error.reason);
  return created.value.threadId;
}

describe("registry alias registration", () => {
  it("registers an alias against a thread and resolves it back", async () => {
    const threadId = await createThread();
    const registered = await threads.registerAlias({
      alias: alias("first"),
      threadId,
      registryPath: store.registryPath,
    });
    expect(registered.ok).toBe(true);
    if (registered.ok) expect(registered.value).toMatchObject({ alias: alias("first"), threadId });

    const resolved = await threads.resolveAlias({ alias: alias("first"), registryPath: store.registryPath });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.value.threadId).toBe(threadId);
      // Registration alone never advances the pointer.
      expect(resolved.value.currentAlias).toBeNull();
    }
  });

  it("registering the same alias to the same thread again returns the original binding", async () => {
    const threadId = await createThread();
    const first = await threads.registerAlias({ alias: alias("same"), threadId, registryPath: store.registryPath });
    const second = await threads.registerAlias({ alias: alias("same"), threadId, registryPath: store.registryPath });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.value.registeredAt).toBe(first.value.registeredAt);
  });

  it("an alias never rebinds to another thread", async () => {
    await threads.registerAlias({ alias: alias("owned"), threadId: THREAD_A, registryPath: store.registryPath });
    const rebind = await threads.registerAlias({
      alias: alias("owned"),
      threadId: THREAD_B,
      registryPath: store.registryPath,
    });
    expect(rebind.ok).toBe(false);
    if (!rebind.ok) {
      expect(rebind.error.code).toBe("alias_bound_to_other_thread");
      expect(rebind.error.errorClass).toBe("caller_error");
      expect(rebind.error.reason).toContain(THREAD_A);
    }

    const resolved = await threads.resolveAlias({ alias: alias("owned"), registryPath: store.registryPath });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.value.threadId).toBe(THREAD_A);
  });

  it("register-plus-advance refuses a rebind and leaves the pointer alone", async () => {
    await threads.registerCurrentAlias({ alias: alias("a1"), threadId: THREAD_A, registryPath: store.registryPath });
    const rebind = await threads.registerCurrentAlias({
      alias: alias("a1"),
      threadId: THREAD_B,
      registryPath: store.registryPath,
    });
    expect(rebind.ok).toBe(false);
    if (!rebind.ok) expect(rebind.error.code).toBe("alias_bound_to_other_thread");

    const currentA = await threads.currentAlias({ threadId: THREAD_A, registryPath: store.registryPath });
    const currentB = await threads.currentAlias({ threadId: THREAD_B, registryPath: store.registryPath });
    expect(currentA.ok && currentA.value.currentAlias).toBe(alias("a1"));
    expect(currentB.ok && currentB.value.currentAlias).toBeNull();
  });
});

describe("registry current-alias pointer", () => {
  it("register-plus-advance makes the new alias current and older aliases still resolve", async () => {
    const threadId = await createThread();
    const generations = [alias("gen-0"), alias("gen-1"), alias("gen-2")];
    for (const generation of generations) {
      const advanced = await threads.registerCurrentAlias({
        alias: generation,
        threadId,
        registryPath: store.registryPath,
      });
      expect(advanced.ok).toBe(true);
      if (advanced.ok) expect(advanced.value.currentAlias).toBe(generation);
    }

    // Entry through the oldest alias lands on the thread and its current alias.
    const viaOldest = await threads.resolveAlias({ alias: generations[0]!, registryPath: store.registryPath });
    expect(viaOldest.ok).toBe(true);
    if (viaOldest.ok) {
      expect(viaOldest.value).toEqual({ alias: generations[0], threadId, currentAlias: generations[2] });
    }

    const current = await threads.currentAlias({ threadId, registryPath: store.registryPath });
    expect(current.ok && current.value.currentAlias).toBe(generations[2]);
  });

  it("advancing to an already registered alias moves the pointer without rebinding", async () => {
    const threadId = await createThread();
    await threads.registerAlias({ alias: alias("known"), threadId, registryPath: store.registryPath });
    await threads.registerCurrentAlias({ alias: alias("newer"), threadId, registryPath: store.registryPath });

    const back = await threads.registerCurrentAlias({
      alias: alias("known"),
      threadId,
      registryPath: store.registryPath,
    });
    expect(back.ok).toBe(true);
    const current = await threads.currentAlias({ threadId, registryPath: store.registryPath });
    expect(current.ok && current.value.currentAlias).toBe(alias("known"));
  });

  it("a thread with no accepted alias reports a null current alias rather than failing", async () => {
    const threadId = await createThread();
    const current = await threads.currentAlias({ threadId, registryPath: store.registryPath });
    expect(current.ok).toBe(true);
    if (current.ok) expect(current.value).toEqual({ threadId, currentAlias: null });
  });

  // The pointer invariant is a schema constraint, so it holds against any
  // writer of the registry file — not only against these APIs.
  it("the registry itself refuses a current pointer naming another thread's alias", async () => {
    await threads.registerCurrentAlias({ alias: alias("a-own"), threadId: THREAD_A, registryPath: store.registryPath });
    await threads.registerCurrentAlias({ alias: alias("b-own"), threadId: THREAD_B, registryPath: store.registryPath });

    const db = new DatabaseSync(store.registryPath);
    db.exec("PRAGMA foreign_keys = ON;");
    try {
      expect(() =>
        db
          .prepare("INSERT OR REPLACE INTO thread_current_alias (thread_id, alias, advanced_at) VALUES (?, ?, ?)")
          .run(THREAD_B, alias("a-own"), "2026-08-18T00:00:00.000Z"),
      ).toThrow();
      expect(() =>
        db
          .prepare("INSERT OR REPLACE INTO thread_current_alias (thread_id, alias, advanced_at) VALUES (?, ?, ?)")
          .run(THREAD_B, alias("never-registered"), "2026-08-18T00:00:00.000Z"),
      ).toThrow();
    } finally {
      db.close();
    }

    const currentB = await threads.currentAlias({ threadId: THREAD_B, registryPath: store.registryPath });
    expect(currentB.ok && currentB.value.currentAlias).toBe(alias("b-own"));
  });
});

describe("registry alias lookups without a binding", () => {
  it("an unknown alias is a miss the caller can act on", async () => {
    await createThread();
    const resolved = await threads.resolveAlias({ alias: alias("unknown"), registryPath: store.registryPath });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.error.code).toBe("alias_not_found");
      expect(resolved.error.errorClass).toBe("caller_error");
    }
  });

  it("a registry that does not exist yet is a miss, and the lookup does not create one", async () => {
    const missingPath = store.threadPath("no-registry");
    const resolved = await threads.resolveAlias({ alias: alias("x"), registryPath: missingPath });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error.code).toBe("alias_not_found");

    const current = await threads.currentAlias({ threadId: THREAD_A, registryPath: missingPath });
    expect(current.ok).toBe(true);
    if (current.ok) expect(current.value.currentAlias).toBeNull();

    const listed = await threads.listThreads({ registryPath: missingPath });
    expect(listed.ok && listed.value).toEqual([]);
  });
});

describe("registry alias keys", () => {
  it("rejects an alias that is not host-qualified", async () => {
    for (const bad of ["", "   ", "11111111-1111-4111-8111-111111111111", ":unqualified", "claude-code:"]) {
      const registered = await threads.registerAlias({
        alias: bad,
        threadId: THREAD_A,
        registryPath: store.registryPath,
      });
      expect(registered.ok, `alias ${JSON.stringify(bad)} should be refused`).toBe(false);
      if (!registered.ok) expect(registered.error.code).toBe("invalid_thread_alias");

      const resolved = await threads.resolveAlias({ alias: bad, registryPath: store.registryPath });
      expect(resolved.ok).toBe(false);
      if (!resolved.ok) expect(resolved.error.code).toBe("invalid_thread_alias");
    }
  });

  it("keeps two hosts' identical native ids apart", async () => {
    const nativeId = "11111111-1111-4111-8111-111111111111";
    await threads.registerCurrentAlias({
      alias: `claude-code:${nativeId}`,
      threadId: THREAD_A,
      registryPath: store.registryPath,
    });
    const otherHost = await threads.registerCurrentAlias({
      alias: `pi:${nativeId}`,
      threadId: THREAD_B,
      registryPath: store.registryPath,
    });
    expect(otherHost.ok).toBe(true);

    const viaClaude = await threads.resolveAlias({
      alias: `claude-code:${nativeId}`,
      registryPath: store.registryPath,
    });
    const viaPi = await threads.resolveAlias({ alias: `pi:${nativeId}`, registryPath: store.registryPath });
    expect(viaClaude.ok && viaClaude.value.threadId).toBe(THREAD_A);
    expect(viaPi.ok && viaPi.value.threadId).toBe(THREAD_B);
  });

  it("treats the alias body as opaque", async () => {
    const opaque = "claude-code:not/a uuid:with:colons and spaces";
    const registered = await threads.registerCurrentAlias({
      alias: opaque,
      threadId: THREAD_A,
      registryPath: store.registryPath,
    });
    expect(registered.ok).toBe(true);
    const resolved = await threads.resolveAlias({ alias: opaque, registryPath: store.registryPath });
    expect(resolved.ok && resolved.value.threadId).toBe(THREAD_A);
  });

  it("rejects a blank thread id", async () => {
    const registered = await threads.registerAlias({
      alias: alias("ok"),
      threadId: "  ",
      registryPath: store.registryPath,
    });
    expect(registered.ok).toBe(false);
    if (!registered.ok) expect(registered.error.code).toBe("invalid_thread_ref");
  });
});

describe("existing hosts stay unaffected by the alias map", () => {
  it("thread creation, listing, and id resolution are unchanged when no alias is ever registered", async () => {
    const first = await threads.newThread({
      filePath: store.threadPath(),
      title: "one",
      registryPath: store.registryPath,
    });
    const second = await threads.newThread({ filePath: store.threadPath(), registryPath: store.registryPath });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    const listed = await threads.listThreads({ registryPath: store.registryPath });
    expect(listed.ok && listed.value.map((info) => info.threadId)).toEqual([
      first.value.threadId,
      second.value.threadId,
    ]);

    const resolved = await threads.resolve({
      threadId: first.value.threadId,
      registryPath: store.registryPath,
    });
    expect(resolved.ok && resolved.value.filePath).toBe(first.value.filePath);

    const db = new DatabaseSync(store.registryPath, { readOnly: true });
    try {
      const aliases = db.prepare("SELECT COUNT(*) AS n FROM thread_alias").get() as unknown as { n: number };
      const pointers = db.prepare("SELECT COUNT(*) AS n FROM thread_current_alias").get() as unknown as { n: number };
      expect(Number(aliases.n)).toBe(0);
      expect(Number(pointers.n)).toBe(0);
    } finally {
      db.close();
    }
  });
});
