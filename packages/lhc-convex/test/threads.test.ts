// Flow 1: thread creation, resolution, listing (TC-1.1, 1.2, 1.3, 1.5 plus the
// lazy-init and read-path-equivalence supplementals).
//
// Substrate-only frozen legs (no Convex analog, documented n/a in the ledger):
//   - TC-1.1's `thread_metadata`/registry raw-row reads and `token_estimator`
//     column — the Convex component stores threads as native `threads`
//     documents; the observable equivalents (resolve/list fields) are asserted
//     instead.
//   - TC-1.5's "absent registry lists empty without creating a file" and
//     TC-1.6's "registry insert failure compensates" — there is no separate
//     SQLite registry file to be absent or to fail a filesystem insert; a fresh
//     component instance simply lists empty.
import { beforeEach, describe, expect, test } from "vitest";
import type { ServiceFixture } from "./fixtures/index.js";
import { serviceFixture } from "./fixtures/index.js";

let fixture: ServiceFixture;

beforeEach(() => {
  fixture = serviceFixture();
});

describe("Flow 1 (SDK): thread creation, resolution, listing", () => {
  test("TC-1.1: create at a fresh alias returns an id and path; resolve/list read them back", async () => {
    const result = await fixture.sdk.threads.newThread({ filePath: "thread-a", title: "first thread" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.filePath).toBe("thread-a");
    expect(result.value.threadId).toMatch(/^th_[a-z0-9]+$/);

    const resolved = await fixture.sdk.threads.resolve({ threadId: result.value.threadId });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.threadId).toBe(result.value.threadId);
    expect(resolved.value.filePath).toBe("thread-a");
    expect(resolved.value.title).toBe("first thread");
    // createdAt is a round-trippable ISO instant.
    expect(new Date(resolved.value.createdAt).toISOString()).toBe(resolved.value.createdAt);

    const listed = await fixture.sdk.threads.listThreads();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value).toHaveLength(1);
    expect(listed.value[0]).toEqual({
      threadId: result.value.threadId,
      filePath: "thread-a",
      title: "first thread",
      createdAt: resolved.value.createdAt,
    });
  });

  test("TC-1.2: an occupied alias is refused with path_exists; the first thread is untouched", async () => {
    const first = await fixture.sdk.threads.newThread({ filePath: "occupied", title: "original" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const result = await fixture.sdk.threads.newThread({ filePath: "occupied", title: "intruder" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("path_exists");
    expect(result.error.errorClass).toBe("caller_error");

    // The original thread survives untouched and no second row was created.
    const listed = await fixture.sdk.threads.listThreads();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value).toHaveLength(1);
    expect(listed.value[0]?.threadId).toBe(first.value.threadId);
    expect(listed.value[0]?.title).toBe("original");
  });

  test("TC-1.3: resolve a known id returns path and metadata; an unknown id fails thread_not_found", async () => {
    const created = await fixture.sdk.threads.newThread({ filePath: "thread-b", title: "resolvable" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const known = await fixture.sdk.threads.resolve({ threadId: created.value.threadId });
    expect(known.ok).toBe(true);
    if (!known.ok) return;
    expect(known.value.threadId).toBe(created.value.threadId);
    expect(known.value.filePath).toBe("thread-b");
    expect(known.value.title).toBe("resolvable");

    const unknown = await fixture.sdk.threads.resolve({ threadId: "th_does_not_exist" });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.error.code).toBe("thread_not_found");
    expect(unknown.error.errorClass).toBe("caller_error");
  });

  test("TC-1.5: listing returns every row; a fresh instance lists empty", async () => {
    const created: Array<{ threadId: string; filePath: string }> = [];
    for (const title of ["one", "two", "three"]) {
      const result = await fixture.sdk.threads.newThread({ filePath: `thread-${title}`, title });
      expect(result.ok).toBe(true);
      if (result.ok) created.push(result.value);
    }

    const listed = await fixture.sdk.threads.listThreads();
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

    // A never-written instance lists empty (the "absent registry" analog).
    const emptyFixture = serviceFixture();
    const empty = await emptyFixture.sdk.threads.listThreads();
    expect(empty.ok).toBe(true);
    if (!empty.ok) return;
    expect(empty.value).toEqual([]);
  });

  test("lazy-init supplemental: resolve against a fresh instance returns thread_not_found", async () => {
    const result = await fixture.sdk.threads.resolve({ threadId: "th_anything" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("thread_not_found");
  });

  test("read-path equivalence: id-ref and path-ref land on the same thread", async () => {
    const created = await fixture.sdk.threads.newThread({ filePath: "thread-c" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const byId = await fixture.sdk.threads.info({ threadId: created.value.threadId });
    const byPath = await fixture.sdk.threads.info({ filePath: "thread-c" });
    expect(byId.ok).toBe(true);
    expect(byPath.ok).toBe(true);
    if (!byId.ok || !byPath.ok) return;
    // Both references reach the same thread: identical id and createdAt.
    expect(byId.value.threadId).toBe(created.value.threadId);
    expect(byPath.value.threadId).toBe(created.value.threadId);
    expect(byId.value).toEqual(byPath.value);

    const unknown = await fixture.sdk.threads.info({ threadId: "th_unknown" });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.error.code).toBe("thread_not_found");
  });
});
