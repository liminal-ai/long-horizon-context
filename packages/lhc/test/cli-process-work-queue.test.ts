// CLI process-boundary suite for work queueing: the production-path proof
// for `lhc turns list-queued-work` and the queuedWork half of the batch
// result — a real conversation goes in through real stdin and the queued
// work items come back as JSON through the spawned binary. Runs under
// verify-all only.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BatchResult, WorkItemRecord } from "../src/index.js";
import { validEvent } from "./fixtures/index.js";

const cliPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../dist/cli.js",
);

function runBinary(
  args: string[],
  input?: string,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    ...(input === undefined ? {} : { input }),
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

let dir: string;
let threadPath: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "lhc-proc-work-"));
  threadPath = path.join(dir, "thread.sqlite");
  const created = runBinary([
    "threads",
    "new-thread",
    "--file-path",
    threadPath,
    "--registry",
    path.join(dir, "registry.sqlite"),
  ]);
  if (created.status !== 0) throw new Error(`fixture new-thread failed: ${created.stdout}`);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("Story 5 (process boundary): queued work through the spawned binary", () => {
  it("a closed turn's work item reads back via turns list-queued-work", () => {
    const batch = [validEvent("user_prompt"), validEvent("assistant_text"), validEvent("turn_end")];
    const recorded = runBinary(
      ["intake-stream", "message-events", "--file-path", threadPath],
      JSON.stringify(batch),
    );
    expect(recorded.status).toBe(0);
    const batchResult = JSON.parse(recorded.stdout) as { ok: boolean; value: BatchResult };
    expect(batchResult.ok).toBe(true);
    expect(batchResult.value.queuedWork).toContainEqual({
      workItemId: "w-t1-turn_derivation",
      owner: "turns",
      kind: "turn_derivation",
      sourceRef: { turnId: "t1" },
    });

    const listed = runBinary(["turns", "list-queued-work", "--file-path", threadPath]);
    expect(listed.status).toBe(0);
    const parsed = JSON.parse(listed.stdout) as { ok: boolean; value: WorkItemRecord[] };
    expect(parsed.ok).toBe(true);
    expect(parsed.value).toHaveLength(1);
    expect(parsed.value[0]).toMatchObject({
      workItemId: "w-t1-turn_derivation",
      owner: "turns",
      kind: "turn_derivation",
      sourceRef: { turnId: "t1" },
      status: "queued",
    });
  });
});
