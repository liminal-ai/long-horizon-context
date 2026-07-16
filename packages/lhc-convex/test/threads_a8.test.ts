import { beforeEach, describe, expect, test } from "vitest";
import type { ServiceFixture } from "./fixtures/index.js";
import { serviceFixture } from "./fixtures/index.js";

let fixture: ServiceFixture;
let alias = 0;

beforeEach(() => {
  fixture = serviceFixture();
  alias = 0;
});

async function create(options: { title?: string; cwd?: string } = {}): Promise<string> {
  alias += 1;
  const created = await fixture.sdk.threads.newThread({ filePath: `a8-thread-${alias}`, ...options });
  if (!created.ok) throw new Error(`create failed: ${created.error.reason}`);
  return created.value.threadId;
}

describe("A-8: cwd", () => {
  test("newThread stores cwd; resolve and listThreads carry it back", async () => {
    const id = await create({ cwd: "/work/project-a", title: "a" });

    const resolved = await fixture.sdk.threads.resolve({ threadId: id });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.value.cwd).toBe("/work/project-a");

    const listed = await fixture.sdk.threads.listThreads();
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.value[0]?.cwd).toBe("/work/project-a");
  });

  test("a thread created with no cwd reports cwd undefined", async () => {
    const id = await create({ title: "no-cwd" });
    const resolved = await fixture.sdk.threads.resolve({ threadId: id });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.value.cwd).toBeUndefined();
  });
});

describe("A-8: partial-id resolve", () => {
  test("resolves a unique prefix to the one matching thread", async () => {
    const id = await create({ title: "only" });
    const prefix = id.slice(0, 8);
    expect(prefix.length).toBeLessThan(id.length);

    const resolved = await fixture.sdk.threads.resolve({ threadId: prefix });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.value.threadId).toBe(id);
  });

  test("a full id still resolves exactly", async () => {
    const id = await create();
    const resolved = await fixture.sdk.threads.resolve({ threadId: id });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.value.threadId).toBe(id);
  });

  test("an ambiguous prefix fails ambiguous_thread_id and creates nothing", async () => {
    const first = await create();
    const second = await create();
    const ambiguous = await fixture.sdk.threads.resolve({ threadId: "th_" });
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) {
      expect(ambiguous.error.code).toBe("ambiguous_thread_id");
      expect(ambiguous.error.errorClass).toBe("caller_error");
      expect(ambiguous.error.reason).toContain(first);
      expect(ambiguous.error.reason).toContain(second);
    }

    const listed = await fixture.sdk.threads.listThreads();
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.value).toHaveLength(2);
  });

  test("an unresolvable id fails thread_not_found", async () => {
    await create();
    const missing = await fixture.sdk.threads.resolve({ threadId: "th_zzzzzzzzzzzzzzzz" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("thread_not_found");
  });

  test("LIKE metacharacters in a partial id match literally, not as wildcards", async () => {
    await create();
    await create();
    const percent = await fixture.sdk.threads.resolve({ threadId: "th%" });
    expect(percent.ok).toBe(false);
    if (!percent.ok) expect(percent.error.code).toBe("thread_not_found");
  });
});

describe("A-8: cwd-scoped listing and most-recent ordering", () => {
  test("listThreads({cwd}) returns only that cwd's threads", async () => {
    const first = await create({ cwd: "/work/a" });
    const second = await create({ cwd: "/work/a" });
    await create({ cwd: "/work/b" });

    const scoped = await fixture.sdk.threads.listThreads({ cwd: "/work/a" });
    expect(scoped.ok).toBe(true);
    if (scoped.ok) {
      expect(scoped.value).toHaveLength(2);
      expect(new Set(scoped.value.map((thread) => thread.threadId))).toEqual(new Set([first, second]));
      for (const thread of scoped.value) expect(thread.cwd).toBe("/work/a");
    }

    const all = await fixture.sdk.threads.listThreads();
    expect(all.ok).toBe(true);
    if (all.ok) expect(all.value).toHaveLength(3);
  });

  test("an empty cwd lists nothing without failing", async () => {
    await create({ cwd: "/work/a" });
    const empty = await fixture.sdk.threads.listThreads({ cwd: "/elsewhere" });
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.value).toEqual([]);
  });

  test("the last listed thread is the most recently created", async () => {
    await create({ title: "first" });
    await create({ title: "second" });
    const last = await create({ title: "third" });

    const listed = await fixture.sdk.threads.listThreads();
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.value).toHaveLength(3);
      expect(listed.value.at(-1)?.threadId).toBe(last);
    }
  });
});
