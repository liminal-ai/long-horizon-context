import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { settleReceipts } from "../../src/wrapper/run.js";
import { countWarnLinesInLog, createWrapperLog } from "../../src/wrapper/wrapper-log.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createWrapperLog", () => {
  it("appends timestamped lines, counts only warnings, creates the directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-wlog-"));
    const path = join(dir, "nested", "wrapper.log");
    const log = createWrapperLog(path);

    expect(log.path).toBe(path);
    expect(log.warningCount()).toBe(0);
    log.info("resume injected");
    log.warn("drain not settled");
    log.warn("buffer overflow");

    await sleep(50);
    expect(log.warningCount()).toBe(2);
    const contents = await readFile(path, "utf8");
    expect(contents).toMatch(/\[info\] resume injected\n/);
    expect(contents).toMatch(/\[warn\] drain not settled\n/);
    expect(contents).toMatch(/\[warn\] buffer overflow\n/);
    expect(contents.split("\n").filter(Boolean)).toHaveLength(3);
  });

  it("never throws when the path is unwritable", async () => {
    const log = createWrapperLog("/dev/null/impossible/wrapper.log");
    expect(() => {
      log.info("x");
      log.warn("y");
    }).not.toThrow();
    await sleep(50);
    expect(log.warningCount()).toBe(0);
  });

  it("derives warning count from the log file so a fresh instance still reports them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-wlog-durable-"));
    const path = join(dir, "wrapper.log");
    const writer = createWrapperLog(path);
    writer.warn("drain not settled");
    await sleep(50);
    expect(writer.warningCount()).toBe(1);

    const relaunched = createWrapperLog(path);
    expect(relaunched.warningCount()).toBe(1);
    expect(countWarnLinesInLog(path)).toBe(1);
  });

  it("does not count warnings whose append failed", async () => {
    const log = createWrapperLog("/dev/null/impossible/wrapper.log");
    log.warn("phantom");
    await sleep(50);
    expect(log.warningCount()).toBe(0);
  });
});

describe("settleReceipts (panel settle decision)", () => {
  it("auto-dismisses (null) ONLY on a confirmed swap", () => {
    expect(settleReceipts(["compact view=v4", "resuming session in-place..."], { swapped: true, receipts: [] })).toBe(
      null,
    );
  });

  it("keeps the panel for refusals, errors, no-ops, and status/stats", () => {
    // refusal / no-op / status: no restart attempted
    expect(settleReceipts(["turn in progress — rerun when idle"], null)).toEqual([
      "turn in progress — rerun when idle",
    ]);
    expect(settleReceipts(["prune boundary 0 -> 0", "no-op"], null)).toEqual(["prune boundary 0 -> 0", "no-op"]);
    // swap attempted but failed: outcome receipt + failure receipt stay visible
    expect(settleReceipts(["compact view=v4"], { swapped: false, receipts: ["resume did not take"] })).toEqual([
      "compact view=v4",
      "resume did not take",
    ]);
  });
});
