import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeterministicInferenceCallbacks, initLhc, type Lhc, retrieval } from "../src/index.js";
import { openDatabase, SQLITE_BUSY_TIMEOUT_MS } from "../src/shared-tech/storage.js";
import { o200k, type TempStore, tempStore, validEvent, withEstimator } from "./fixtures/index.js";

describe("sqlite concurrent capture + retrieval", () => {
  let store: TempStore;
  let sdk: Lhc;
  let filePath: string;

  beforeEach(async () => {
    store = tempStore();
    sdk = initLhc({
      tokenFamily: "o200k",
      mode: "manual",
      inferenceCallbacks: createDeterministicInferenceCallbacks(),
    });
    const path = store.threadPath();
    const created = await sdk.threads.newThread({ filePath: path, registryPath: store.registryPath });
    if (!created.ok) throw new Error(created.error.reason);
    filePath = path;
    await sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: "q" } }),
      validEvent("assistant_text", { payload: { text: "a" } }),
      validEvent("turn_end"),
    ]);
    await sdk.work.drain({ filePath });
  });

  afterEach(() => {
    store.cleanup();
  });

  it("Promise.all retrieval + capture both succeed repeatedly on existing archive", async () => {
    for (let i = 0; i < 20; i += 1) {
      const retP = withEstimator(o200k, () => retrieval.getTurns({ filePath }, ["t1"], { surface: `race-${i}` }));
      const capP = sdk.intakeStream.messageEvents({ filePath }, [
        validEvent("user_prompt", { payload: { text: `race-${i}` } }),
        validEvent("assistant_text", { payload: { text: `ans-${i}` } }),
        validEvent("turn_end"),
      ]);
      const [ret, cap] = await Promise.all([retP, capP]);
      expect(ret.ok, `retrieval failed iter ${i}: ${ret.ok ? "" : ret.error.reason}`).toBe(true);
      expect(cap.ok, `capture failed iter ${i}: ${cap.ok ? "" : cap.error.reason}`).toBe(true);
    }
    const imps = await withEstimator(o200k, () => retrieval.listImpressions({ filePath }));
    expect(imps.ok).toBe(true);
    if (!imps.ok) return;
    expect(imps.value.length).toBeGreaterThanOrEqual(20);
  });

  it("fresh archive: create then race open paths", async () => {
    const path2 = store.threadPath("fresh-race");
    const created = await sdk.threads.newThread({ filePath: path2, registryPath: store.registryPath });
    if (!created.ok) throw new Error(created.error.reason);
    await sdk.intakeStream.messageEvents({ filePath: path2 }, [
      validEvent("user_prompt", { payload: { text: "seed" } }),
      validEvent("assistant_text", { payload: { text: "seed-a" } }),
      validEvent("turn_end"),
    ]);
    await sdk.work.drain({ filePath: path2 });

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        Promise.all([
          withEstimator(o200k, () => retrieval.getTurns({ filePath: path2 }, ["t1"], { surface: `f-${i}` })),
          sdk.intakeStream.messageEvents({ filePath: path2 }, [
            validEvent("runtime_note", { payload: { text: `n-${i}` } }),
          ]),
        ]),
      ),
    );
    for (const [ret, cap] of results) {
      expect(ret.ok).toBe(true);
      expect(cap.ok).toBe(true);
    }
  });
});

describe("openDatabase on a fresh file another connection is writing", () => {
  let store: TempStore;

  beforeEach(() => {
    store = tempStore();
  });

  afterEach(() => {
    store.cleanup();
  });

  it("switches to WAL once the writer commits instead of failing with database is locked", async () => {
    const path = store.threadPath("fresh-wal");
    const writer = new Worker(
      `
      const { parentPort, workerData } = require("node:worker_threads");
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(workerData.path);
      db.exec("BEGIN IMMEDIATE; CREATE TABLE seed (id INTEGER);");
      parentPort.postMessage("locked");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
      db.exec("COMMIT;");
      db.close();
      `,
      { eval: true, workerData: { path } },
    );
    await once(writer, "message");

    const db = openDatabase(path);
    const mode = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    db.close();
    await once(writer, "exit");

    expect(mode.journal_mode).toBe("wal");
  });

  it("fails with SQLITE_BUSY without another WAL attempt once the budget is spent", () => {
    const path = store.threadPath("spent-budget");
    let reads = 0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => (++reads === 1 ? 0 : SQLITE_BUSY_TIMEOUT_MS));
    try {
      expect(() => openDatabase(path)).toThrow(expect.objectContaining({ errcode: 5 }));
    } finally {
      spy.mockRestore();
    }
    const db = new DatabaseSync(path);
    const mode = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    db.close();
    expect(mode.journal_mode).not.toBe("wal");
  });
});
