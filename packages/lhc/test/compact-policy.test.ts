import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { threads } from "../src/index.js";
import { getSchemaVersion } from "../src/shared-tech/storage.js";
import { THREAD_SCHEMA_VERSION_13, THREAD_SCHEMA_VERSION_14 } from "../src/shared-tech/thread-migrate.js";
import { type TempStore, tempStore } from "./fixtures/index.js";

let store: TempStore;

beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
});

async function newThread(): Promise<{ threadId: string; filePath: string }> {
  const created = await threads.newThread({ filePath: store.threadPath(), registryPath: store.registryPath });
  if (!created.ok) throw new Error(created.error.reason);
  return created.value;
}

function schemaVersion(filePath: string): number {
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    return getSchemaVersion(db);
  } finally {
    db.close();
  }
}

describe("threads compact policy", () => {
  it("a new thread has no policy", async () => {
    const { filePath } = await newThread();
    expect(await threads.getCompactPolicy({ filePath })).toEqual({ ok: true, value: null });
  });

  it("reads back the pair it stored, by file path and by thread id", async () => {
    const { threadId, filePath } = await newThread();
    const set = await threads.setCompactPolicy({ filePath }, { trigger: 700_000, target: 140_000 });
    expect(set).toEqual({ ok: true, value: { trigger: 700_000, target: 140_000 } });
    expect(await threads.getCompactPolicy({ threadId, registryPath: store.registryPath })).toEqual({
      ok: true,
      value: { trigger: 700_000, target: 140_000 },
    });
    await threads.setCompactPolicy({ filePath }, { trigger: 300_000, target: 100_000 });
    expect(await threads.getCompactPolicy({ filePath })).toEqual({
      ok: true,
      value: { trigger: 300_000, target: 100_000 },
    });
  });

  it.each([
    ["zero trigger", { trigger: 0, target: 0 }, /positive integers/],
    ["negative target", { trigger: 1000, target: -1 }, /positive integers/],
    ["fractional trigger", { trigger: 1000.5, target: 10 }, /positive integers/],
    ["NaN target", { trigger: 1000, target: Number.NaN }, /positive integers/],
    ["target equal to trigger", { trigger: 1000, target: 1000 }, /target must be below trigger/],
    ["target above trigger", { trigger: 1000, target: 2000 }, /target must be below trigger/],
  ])("refuses %s with a caller error and leaves the stored pair alone", async (_name, policy, reason) => {
    const { filePath } = await newThread();
    await threads.setCompactPolicy({ filePath }, { trigger: 700_000, target: 140_000 });
    const refused = await threads.setCompactPolicy({ filePath }, policy);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.errorClass).toBe("caller_error");
    expect(refused.error.code).toBe("invalid_compact_policy");
    expect(refused.error.reason).toMatch(reason);
    expect(await threads.getCompactPolicy({ filePath })).toEqual({
      ok: true,
      value: { trigger: 700_000, target: 140_000 },
    });
  });

  it("a schema-13 thread opens, migrates to 14, and has no policy", async () => {
    const { filePath } = await newThread();
    const raw = new DatabaseSync(filePath);
    raw.exec("ALTER TABLE thread_metadata DROP COLUMN compact_trigger_tokens;");
    raw.exec("ALTER TABLE thread_metadata DROP COLUMN compact_target_tokens;");
    raw.exec(`PRAGMA user_version = ${THREAD_SCHEMA_VERSION_13};`);
    raw.close();
    expect(schemaVersion(filePath)).toBe(THREAD_SCHEMA_VERSION_13);

    expect(await threads.getCompactPolicy({ filePath })).toEqual({ ok: true, value: null });
    expect(schemaVersion(filePath)).toBe(THREAD_SCHEMA_VERSION_14);
    await threads.setCompactPolicy({ filePath }, { trigger: 200_000, target: 80_000 });
    expect(await threads.getCompactPolicy({ filePath })).toEqual({
      ok: true,
      value: { trigger: 200_000, target: 80_000 },
    });
  });

  it("copyThread carries the pair to the copy", async () => {
    const { filePath } = await newThread();
    await threads.setCompactPolicy({ filePath }, { trigger: 700_000, target: 140_000 });
    const copied = await threads.copyThread({
      source: { filePath },
      filePath: store.threadPath("copy"),
      registryPath: store.registryPath,
    });
    if (!copied.ok) throw new Error(copied.error.reason);
    expect(
      await threads.getCompactPolicy({ threadId: copied.value.threadId, registryPath: store.registryPath }),
    ).toEqual({ ok: true, value: { trigger: 700_000, target: 140_000 } });
  });

  it("refuses an unknown thread", async () => {
    const missing = await threads.getCompactPolicy({ threadId: "th_missing", registryPath: store.registryPath });
    expect(!missing.ok && missing.error.code).toBe("thread_not_found");
    const unset = await threads.setCompactPolicy(
      { threadId: "th_missing", registryPath: store.registryPath },
      { trigger: 2, target: 1 },
    );
    expect(!unset.ok && unset.error.code).toBe("thread_not_found");
  });
});
