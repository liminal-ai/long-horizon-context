import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
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

  // Deterministically unwritable on every platform: the parent of the log
  // path is an existing regular FILE, so directory creation and append both
  // fail (ENOTDIR on POSIX, ENOENT on Windows). "/dev/null/…" is only
  // unwritable on POSIX — on Windows it is a creatable relative path.
  function unwritableLogPath(): string {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-wlog-blocked-"));
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "");
    return join(blocker, "impossible", "wrapper.log");
  }

  it("never throws when the path is unwritable", async () => {
    const log = createWrapperLog(unwritableLogPath());
    expect(() => {
      log.info("x");
      log.warn("y");
    }).not.toThrow();
    await sleep(50);
    expect(log.warningCount()).toBe(0);
  });

  it("reports warnings from this wrapper run, not the shared log lifetime", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-wlog-durable-"));
    const path = join(dir, "wrapper.log");
    const writer = createWrapperLog(path);
    writer.warn("drain not settled");
    await sleep(50);
    expect(writer.warningCount()).toBe(1);

    const relaunched = createWrapperLog(path);
    expect(relaunched.warningCount()).toBe(0);
    expect(countWarnLinesInLog(path)).toBe(1);
  });

  it("does not count warnings whose append failed", async () => {
    const log = createWrapperLog(unwritableLogPath());
    log.warn("phantom");
    await sleep(50);
    expect(log.warningCount()).toBe(0);
  });

  it("counts only warn records, not message-body tokens or continuation lines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-wlog-shape-"));
    const path = join(dir, "wrapper.log");
    const log = createWrapperLog(path);

    log.warn("real warning");
    log.info("note: prior line was [warn] but this is info");
    appendFileSync(path, "continuation mentioning [warn] token\n");

    await sleep(50);
    expect(log.warningCount()).toBe(1);
    expect(countWarnLinesInLog(path)).toBe(1);
  });
});

describe("settleReceipts (panel settle decision)", () => {
  it("always keeps messages visible (no in-app swap auto-dismiss)", () => {
    expect(settleReceipts(["compact view=v4", "Exit Claude, then relaunch with: cc-lhc --resume new"])).toEqual([
      "compact view=v4",
      "Exit Claude, then relaunch with: cc-lhc --resume new",
    ]);
    expect(settleReceipts(["turn in progress — rerun when idle"])).toEqual(["turn in progress — rerun when idle"]);
  });
});
