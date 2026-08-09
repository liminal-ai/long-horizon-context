import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { WatcherEmission } from "../../src/rollout/types.js";
import { type RolloutWatcher, watchRolloutFile } from "../../src/rollout/watcher.js";

function collectBatches(filePath: string, pollMs = 50): { batches: WatcherEmission[][]; watcher: RolloutWatcher } {
  const batches: WatcherEmission[][] = [];
  const watcher = watchRolloutFile(filePath, {
    pollMs,
    onBatch: (emissions) => {
      batches.push(emissions);
    },
  });
  return { batches, watcher };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("watchRolloutFile", () => {
  let dir: string;
  let filePath: string;
  let watcher: RolloutWatcher | undefined;

  afterEach(() => {
    watcher?.stop();
    watcher = undefined;
  });

  it("emits complete lines as they are appended", async () => {
    dir = mkdtempSync(join(tmpdir(), "cc-lhc-watcher-"));
    filePath = join(dir, "session.jsonl");
    writeFileSync(filePath, "");

    const collected = collectBatches(filePath);
    watcher = collected.watcher;

    appendFileSync(filePath, '{"type":"user","uuid":"a","message":{"role":"user","content":"one"}}\n');
    await sleep(120);

    appendFileSync(filePath, '{"type":"user","uuid":"b","message":{"role":"user","content":"two"}}\n');
    await sleep(120);

    watcher.stop();

    const lines = collected.batches.flat().filter((entry) => entry.kind === "line");
    expect(lines).toHaveLength(2);
    if (lines[0]?.kind === "line") expect(lines[0].item.uuid).toBe("a");
    if (lines[1]?.kind === "line") expect(lines[1].item.uuid).toBe("b");
  });

  it("buffers a line split across writes and emits once complete", async () => {
    dir = mkdtempSync(join(tmpdir(), "cc-lhc-watcher-"));
    filePath = join(dir, "session.jsonl");
    writeFileSync(filePath, "");

    const collected = collectBatches(filePath);
    watcher = collected.watcher;

    const full = '{"type":"user","uuid":"split","message":{"role":"user","content":"mid"}}\n';
    const splitAt = Math.floor(full.length / 2);
    appendFileSync(filePath, full.slice(0, splitAt));
    await sleep(80);
    expect(collected.batches.flat()).toHaveLength(0);

    appendFileSync(filePath, full.slice(splitAt));
    await sleep(120);
    watcher.stop();

    const lines = collected.batches.flat().filter((entry) => entry.kind === "line");
    expect(lines).toHaveLength(1);
    if (lines[0]?.kind === "line") expect(lines[0].item.uuid).toBe("split");
  });

  it("emits parse diagnostics for bad JSON without throwing", async () => {
    dir = mkdtempSync(join(tmpdir(), "cc-lhc-watcher-"));
    filePath = join(dir, "session.jsonl");
    writeFileSync(filePath, "not-json\n");

    const collected = collectBatches(filePath);
    watcher = collected.watcher;
    await sleep(120);
    watcher.stop();

    const errors = collected.batches.flat().filter((entry) => entry.kind === "parse_error");
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it("reads final on-disk lines on stop without waiting for the next poll", async () => {
    dir = mkdtempSync(join(tmpdir(), "cc-lhc-watcher-final-"));
    filePath = join(dir, "session.jsonl");
    writeFileSync(filePath, "");

    const collected = collectBatches(filePath, 5_000);
    watcher = collected.watcher;

    appendFileSync(filePath, '{"type":"user","uuid":"early","message":{"role":"user","content":"one"}}\n');
    await sleep(80);

    appendFileSync(filePath, '{"type":"user","uuid":"final-a","message":{"role":"user","content":"two"}}\n');
    appendFileSync(filePath, '{"type":"user","uuid":"final-b","message":{"role":"user","content":"three"}}\n');
    watcher.stop();

    const uuids = collected.batches
      .flat()
      .filter((entry): entry is Extract<WatcherEmission, { kind: "line" }> => entry.kind === "line")
      .map((entry) => entry.item.uuid);
    expect(uuids).toContain("early");
    expect(uuids).toContain("final-a");
    expect(uuids).toContain("final-b");
  });

  it("does not re-ingest from byte zero on file truncation (fail closed)", async () => {
    dir = mkdtempSync(join(tmpdir(), "cc-lhc-watcher-"));
    filePath = join(dir, "session.jsonl");
    // Long enough first line so a shorter rewrite shrinks below offset.
    writeFileSync(
      filePath,
      '{"type":"user","uuid":"old","message":{"role":"user","content":"old-content-long-enough"}}\n',
    );

    const shrinks: string[] = [];
    const batches: WatcherEmission[][] = [];
    watcher = watchRolloutFile(filePath, {
      pollMs: 50,
      onBatch: (emissions) => {
        batches.push(emissions);
      },
      onFileShrink: (m) => shrinks.push(m),
    });
    await watcher.initialCatchUp;
    const before = batches
      .flat()
      .filter((e): e is Extract<WatcherEmission, { kind: "line" }> => e.kind === "line")
      .map((e) => e.item.uuid);
    expect(before).toContain("old");

    // Truncate/rewrite shorter than current offset.
    writeFileSync(filePath, '{"type":"user","uuid":"new"}\n');
    await sleep(200);
    watcher.stop();

    expect(shrinks.length).toBeGreaterThanOrEqual(1);
    const after = batches
      .flat()
      .filter((e): e is Extract<WatcherEmission, { kind: "line" }> => e.kind === "line")
      .map((e) => e.item.uuid);
    // Must not re-deliver rewritten content from byte zero after shrink.
    expect(after).not.toContain("new");
  });

  it("rejects initialCatchUp on missing file (stat failure), not empty success", async () => {
    dir = mkdtempSync(join(tmpdir(), "cc-lhc-watcher-miss-"));
    filePath = join(dir, "missing.jsonl");
    const failures: string[] = [];
    watcher = watchRolloutFile(filePath, {
      pollMs: 50,
      onBatch: () => {},
      onInitialFailure: (m) => failures.push(m),
    });
    await expect(watcher.initialCatchUp).rejects.toThrow(/initial open failed/);
    expect(failures.some((m) => m.includes("initial open failed"))).toBe(true);
  });

  it("resolves initialCatchUp successfully for a genuinely empty file", async () => {
    dir = mkdtempSync(join(tmpdir(), "cc-lhc-watcher-empty-"));
    filePath = join(dir, "empty.jsonl");
    writeFileSync(filePath, "");
    watcher = watchRolloutFile(filePath, {
      pollMs: 50,
      onBatch: () => {},
    });
    await expect(watcher.initialCatchUp).resolves.toBeUndefined();
  });
});
