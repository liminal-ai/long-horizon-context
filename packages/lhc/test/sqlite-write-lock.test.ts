/**
 * Write-lock identity keying, refuse-on-no-stat, cleanup after throw, real FIFO,
 * symlink alias. Separate-process same-file race uses tsx fixture.
 */

import { spawn } from "node:child_process";
import { linkSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDbWriteTransaction,
  createDeterministicInferenceCallbacks,
  initLhc,
  type Lhc,
  retrieval,
} from "../src/index.js";
import {
  __runUnderThreadWriteLockForTests,
  __setStatSyncForTests,
  __writeLockMapSizeForTests,
  threadWriteLockKey,
} from "../src/shared-tech/persist.js";
import { type TempStore, tempStore, validEvent } from "./fixtures/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const multiprocFixture = join(here, "fixtures/write-lock-multiproc-worker.ts");
const tsxBin = join(here, "../node_modules/.bin/tsx");

describe("thread write lock identity", () => {
  let store: TempStore;
  let sdk: Lhc;
  let filePath: string;
  beforeEach(async () => {
    store = tempStore();
    sdk = initLhc({ mode: "manual", inferenceCallbacks: createDeterministicInferenceCallbacks() });
    filePath = store.threadPath();
    const created = await sdk.threads.newThread({
      filePath,
      registryPath: store.registryPath,
    });
    if (!created.ok) throw new Error(created.error.reason);
    await sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: "q" } }),
      validEvent("assistant_text", { payload: { text: "a" } }),
      validEvent("turn_end"),
    ]);
    await sdk.work.drain({ filePath });
  });

  afterEach(() => {
    __setStatSyncForTests(undefined);
    store.cleanup();
    expect(__writeLockMapSizeForTests()).toBe(0);
  });

  it("symlink alias shares identity key with real path", () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-sym-"));
    const link = join(dir, "alias.sqlite");
    symlinkSync(filePath, link);
    expect(threadWriteLockKey(link)).toBe(threadWriteLockKey(filePath));
    expect(threadWriteLockKey(filePath)).not.toBeNull();
  });

  it("hard link alias shares identity key (equality only; no SQLite write via hardlink)", () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-hl-"));
    const hl = join(dir, "hard.sqlite");
    try {
      linkSync(filePath, hl);
    } catch {
      // some FS disallow hardlinks
      return;
    }
    expect(threadWriteLockKey(hl)).toBe(threadWriteLockKey(filePath));
  });

  it("stat failure refuses write with explicit storage error (no raw-path fallback)", async () => {
    const missing = join(store.dir, "does-not-exist-yet.sqlite");
    expect(threadWriteLockKey(missing)).toBeNull();

    const ghost = join(store.dir, "ghost-lock.sqlite");
    const missingResult = await createDbWriteTransaction({ filePath: ghost }, async () => "x");
    expect(missingResult.ok).toBe(false);
    if (!missingResult.ok) {
      expect(missingResult.error.errorClass).toBe("caller_error");
      expect(missingResult.error.code).toBe("thread_not_found");
    }
    expect(__writeLockMapSizeForTests()).toBe(0);

    // Identity key is ino-based, never the raw path string.
    const key = threadWriteLockKey(filePath);
    expect(key).toMatch(/^ino:/);
    expect(key).not.toBe(filePath);

    // Force stat failure while the file still exists → storage_failure OpResult,
    // callback never runs, map empty. No raw-path lock key fallback.
    __setStatSyncForTests(() => {
      throw Object.assign(new Error("EIO: forced stat failure"), { code: "EIO" });
    });
    try {
      expect(threadWriteLockKey(filePath)).toBeNull();
      let ran = false;
      const refused = await createDbWriteTransaction({ filePath }, async () => {
        ran = true;
        return "must-not";
      });
      expect(ran).toBe(false);
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.error.errorClass).toBe("system_error");
        expect(refused.error.code).toBe("storage_failure");
        expect(refused.error.reason).toMatch(/identity/);
      }
      await expect(__runUnderThreadWriteLockForTests(filePath, async () => 1)).rejects.toThrow(/identity/);
    } finally {
      __setStatSyncForTests(undefined);
    }
    expect(__writeLockMapSizeForTests()).toBe(0);
    // After restore, identity works again
    expect(threadWriteLockKey(filePath)).toMatch(/^ino:/);
  });

  it("createDbWriteTransaction throw while holding mutex still drains; next writer succeeds", async () => {
    await expect(
      createDbWriteTransaction({ filePath }, () => {
        throw new Error("injected-writer-boom");
      }),
    ).rejects.toThrow(/injected-writer-boom/);

    expect(__writeLockMapSizeForTests()).toBe(0);

    const ret = await retrieval.getTurns({ filePath }, ["t1"], { surface: "after-throw" });
    expect(ret.ok).toBe(true);
    expect(__writeLockMapSizeForTests()).toBe(0);
  });

  it("FIFO entry order under controlled barriers", async () => {
    const entryOrder: number[] = [];
    const releaseGates: Array<() => void> = [];
    const results: Array<Promise<number>> = [];

    const waitForEntry = async (n: number): Promise<void> => {
      const start = Date.now();
      while (entryOrder.length < n) {
        if (Date.now() - start > 3_000) {
          throw new Error(`timed out waiting for entry count ${n}, got ${entryOrder.join(",")}`);
        }
        await new Promise((r) => setImmediate(r));
      }
    };

    for (let i = 0; i < 5; i += 1) {
      const idx = i;
      results.push(
        __runUnderThreadWriteLockForTests(filePath, async () => {
          entryOrder.push(idx);
          await new Promise<void>((resolve) => {
            releaseGates[idx] = resolve;
          });
          return idx;
        }),
      );
      // Chain each waiter onto the mutex before enqueuing the next.
      await new Promise((r) => setImmediate(r));
    }

    await waitForEntry(1);
    expect(entryOrder).toEqual([0]);
    expect(releaseGates[0]).toBeTypeOf("function");

    for (let i = 0; i < 5; i += 1) {
      releaseGates[i]!();
      if (i < 4) {
        await waitForEntry(i + 2);
        expect(entryOrder.slice(0, i + 2)).toEqual(Array.from({ length: i + 2 }, (_, j) => j));
      }
    }

    const values = await Promise.all(results);
    expect(values).toEqual([0, 1, 2, 3, 4]);
    expect(entryOrder).toEqual([0, 1, 2, 3, 4]);
    expect(__writeLockMapSizeForTests()).toBe(0);
  });

  it("real path vs symlink concurrent writers both succeed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-symr-"));
    const link = join(dir, "alias.sqlite");
    symlinkSync(filePath, link);
    let fails = 0;
    for (let i = 0; i < 15; i += 1) {
      const [ret, cap] = await Promise.all([
        retrieval.getTurns({ filePath: link }, ["t1"], { surface: `s${i}` }),
        sdk.intakeStream.messageEvents({ filePath }, [
          validEvent("user_prompt", { payload: { text: `q${i}` } }),
          validEvent("assistant_text", { payload: { text: `a${i}` } }),
          validEvent("turn_end"),
        ]),
      ]);
      if (!ret.ok || !cap.ok) fails += 1;
    }
    expect(fails).toBe(0);
    expect(__writeLockMapSizeForTests()).toBe(0);
  });

  it("separate-process same-file race: zero database-is-locked failures", async () => {
    const rounds = 24;
    const outPath = join(store.dir, "multiproc-result.json");
    const readyPath = join(store.dir, "multiproc-ready");
    const goPath = join(store.dir, "multiproc-go");
    const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
    const { DatabaseSync } = await import("node:sqlite");

    const raceCaptureEvents = (
      side: "parent" | "child",
      round: number,
      userText: string,
      asstText: string,
    ): import("../src/index.js").MessageEventInput[] => {
      const base = { actor: `${side}-actor`, harness: "multiproc-race" } as const;
      return [
        {
          eventKind: "user_prompt",
          idempotencyKey: `race-${side}-r${round}-user`,
          ...base,
          payload: { text: userText },
        },
        {
          eventKind: "assistant_text",
          idempotencyKey: `race-${side}-r${round}-asst`,
          ...base,
          payload: { text: asstText },
        },
        {
          eventKind: "turn_end",
          idempotencyKey: `race-${side}-r${round}-end`,
          ...base,
          payload: {},
        },
      ];
    };

    // Mutation assertion: parent/child keys must not collide.
    for (let i = 0; i < rounds; i += 1) {
      expect(`race-parent-r${i}-user`).not.toBe(`race-child-r${i}-user`);
    }

    const impsBefore = await retrieval.listImpressions({ filePath });
    expect(impsBefore.ok).toBe(true);
    if (!impsBefore.ok) return;
    const nBefore = impsBefore.value.length;

    const dbPre = new DatabaseSync(filePath, { readOnly: true });
    const eventsBeforeRow = dbPre.prepare(`SELECT COUNT(*) AS c FROM event`).get() as { c: number } | undefined;
    const eventsBefore = Number(eventsBeforeRow?.c ?? 0);
    dbPre.close();
    // Seed is 3 events (user, assistant, turn_end).
    expect(eventsBefore).toBe(3);

    // Pre-release: go must not exist yet (barrier not released).
    expect(existsSync(goPath)).toBe(false);

    const child = spawn(tsxBin, [multiprocFixture, filePath, String(rounds), outPath, readyPath, goPath], {
      cwd: join(here, ".."),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    let stdout = "";
    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString();
    });

    // Wait for child READY (imports + SDK done) before releasing either side.
    const readyStart = Date.now();
    while (!existsSync(readyPath)) {
      if (Date.now() - readyStart > 15_000) {
        child.kill("SIGKILL");
        throw new Error(`timeout waiting for child READY; stderr=${stderr}`);
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(readFileSync(readyPath, "utf8")).toMatch(/^READY/);
    // Still no go — parent must not have started races yet.
    expect(existsSync(goPath)).toBe(false);

    // Prepare parent jobs but do not start them until simultaneous release.
    let parentFails = 0;
    let parentLocked = 0;
    let parentSuccess = 0;
    let parentSkips = 0;
    const parentSurfaces: string[] = [];
    const parentJobs: Promise<void>[] = [];
    for (let i = 0; i < rounds; i += 1) {
      const surface = `parent-${i}`;
      parentJobs.push(
        (async () => {
          // Wait for go barrier (same release step as child).
          while (!existsSync(goPath)) {
            await new Promise((r) => setTimeout(r, 5));
          }
          const [ret, cap] = await Promise.all([
            retrieval.getTurns({ filePath }, ["t1"], { surface }),
            sdk.intakeStream.messageEvents({ filePath }, raceCaptureEvents("parent", i, `p-${i}`, `pa-${i}`)),
          ]);
          if (!ret.ok || !cap.ok) {
            parentFails += 1;
            const reasons = [ret.ok ? "" : ret.error.reason, cap.ok ? "" : cap.error.reason].join(" ");
            if (/database is locked/i.test(reasons)) parentLocked += 1;
            return;
          }
          const outcomes = cap.value.events.map((e) => e.outcome);
          const skipCount = outcomes.filter((o) => o === "skipped").length;
          if (skipCount > 0) {
            parentFails += 1;
            parentSkips += skipCount;
            return;
          }
          if (outcomes.length !== 3 || outcomes.some((o) => o !== "recorded")) {
            parentFails += 1;
            return;
          }
          parentSuccess += 1;
          parentSurfaces.push(surface);
        })(),
      );
    }

    // Simultaneous release: both parent waiters and child see go at this step.
    writeFileSync(goPath, "GO\n", "utf8");

    const [exitCode] = await Promise.all([
      new Promise<number>((resolve) => {
        child.on("close", (code) => resolve(code ?? 1));
      }),
      Promise.all(parentJobs),
    ]);

    expect(exitCode, `child exit stderr=${stderr} stdout=${stdout}`).toBe(0);
    expect(parentFails, `parent fails locked=${parentLocked} skips=${parentSkips}`).toBe(0);
    expect(parentLocked).toBe(0);
    expect(parentSkips).toBe(0);
    expect(parentSuccess).toBe(rounds);
    expect(parentSurfaces).toHaveLength(rounds);

    const childResult = JSON.parse(readFileSync(outPath, "utf8")) as {
      fails: number;
      locked: number;
      rounds: number;
      successRounds: number;
      skippedOutcomes: number;
      surfaces: string[];
    };
    expect(childResult.fails).toBe(0);
    expect(childResult.locked).toBe(0);
    expect(childResult.skippedOutcomes ?? 0).toBe(0);
    expect(childResult.rounds).toBe(rounds);
    expect(childResult.successRounds).toBe(rounds);
    expect(childResult.surfaces).toHaveLength(rounds);
    expect(new Set(childResult.surfaces).size).toBe(rounds);

    // Exact durable impression deltas: parent rounds + child rounds (each one retrieval).
    const imps = await retrieval.listImpressions({ filePath });
    expect(imps.ok).toBe(true);
    if (!imps.ok) return;
    expect(imps.value.length - nBefore).toBe(rounds * 2);
    const after = imps.value.slice(nBefore);
    const parentDelta = after.filter((row) => String(row.surface ?? "").startsWith("parent-"));
    const childDelta = after.filter((row) => String(row.surface ?? "").startsWith("child-"));
    expect(parentDelta).toHaveLength(rounds);
    expect(childDelta).toHaveLength(rounds);
    expect(new Set(parentDelta.map((r) => r.surface)).size).toBe(rounds);
    expect(new Set(childDelta.map((r) => r.surface)).size).toBe(rounds);

    // Exact durable event delta: seed 3 + 2 sides × rounds × 3 events.
    const dbPost = new DatabaseSync(filePath, { readOnly: true });
    const eventsAfterRow = dbPost.prepare(`SELECT COUNT(*) AS c FROM event`).get() as { c: number } | undefined;
    const eventsAfter = Number(eventsAfterRow?.c ?? 0);
    const keys = dbPost
      .prepare(`SELECT idempotency_key FROM event WHERE idempotency_key LIKE 'race-%'`)
      .all() as Array<{ idempotency_key: string }>;
    dbPost.close();
    expect(eventsAfter - eventsBefore).toBe(2 * rounds * 3);
    expect(eventsAfter).toBe(3 + 2 * rounds * 3);
    expect(keys).toHaveLength(2 * rounds * 3);
    expect(new Set(keys.map((k) => k.idempotency_key)).size).toBe(2 * rounds * 3);

    expect(__writeLockMapSizeForTests()).toBe(0);
  }, 60_000);
});
