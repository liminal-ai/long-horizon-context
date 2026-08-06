import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MAX_PARTIAL_BYTES, type RolloutWatcher, watchRolloutFile } from "../../src/rollout/watcher.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("watchRolloutFile buffer cap", () => {
  let watcher: RolloutWatcher | undefined;

  afterEach(() => {
    watcher?.stop();
    watcher = undefined;
  });

  it("drops oversized partial buffer and counts parse_fail via diagnostic", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-watcher-cap-"));
    const filePath = join(dir, "session.jsonl");
    writeFileSync(filePath, "");

    const parseErrors: string[] = [];
    const lines: string[] = [];

    watcher = watchRolloutFile(filePath, {
      pollMs: 50,
      maxPartialBytes: 128,
      onBatch: (emissions) => {
        for (const emission of emissions) {
          if (emission.kind === "parse_error") parseErrors.push(emission.error);
          if (emission.kind === "line") lines.push(emission.item.uuid ?? "no-uuid");
        }
      },
      onBufferCap: (message) => {
        parseErrors.push(message);
      },
    });

    const oversized = "x".repeat(200);
    appendFileSync(filePath, oversized);
    await sleep(150);

    const valid = '{"type":"user","uuid":"after-cap","message":{"role":"user","content":"ok"}}\n';
    appendFileSync(filePath, valid);
    await sleep(150);
    watcher.stop();

    expect(parseErrors.some((error) => error.includes("byte cap"))).toBe(true);
    expect(lines).toContain("after-cap");
    expect(MAX_PARTIAL_BYTES).toBe(10 * 1024 * 1024);
  });
});
