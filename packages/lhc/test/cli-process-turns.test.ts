// CLI process-boundary suite for turns: the production-path proof for
// `lhc turns list` — a real conversation goes in through real stdin and the
// turn records come back as JSON through the spawned binary, with membership
// and boundary orders intact. Runs under verify-all only.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TurnRecord } from "../src/index.js";
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
  dir = mkdtempSync(path.join(tmpdir(), "lhc-proc-turns-"));
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

describe("Story 4 (process boundary): turns list through the spawned binary", () => {
  it("a closed and an open turn read back with full shape via turns list", () => {
    const batch = [
      validEvent("user_prompt"),
      validEvent("assistant_text"),
      validEvent("turn_end"),
      validEvent("user_prompt"),
    ];
    const recorded = runBinary(
      ["intake-stream", "message-events", "--file-path", threadPath],
      JSON.stringify(batch),
    );
    expect(recorded.status).toBe(0);
    const batchResult = JSON.parse(recorded.stdout) as {
      ok: boolean;
      value: { turnTransitions: Array<{ action: string; turnId: string }> };
    };
    expect(batchResult.ok).toBe(true);
    expect(batchResult.value.turnTransitions).toEqual([
      { action: "opened", turnId: "t1" },
      { action: "closed", turnId: "t1" },
      { action: "opened", turnId: "t2" },
    ]);

    const listed = runBinary(["turns", "list", "--file-path", threadPath]);
    expect(listed.status).toBe(0);
    const parsed = JSON.parse(listed.stdout) as { ok: boolean; value: TurnRecord[] };
    expect(parsed.ok).toBe(true);
    expect(parsed.value).toEqual([
      {
        turnId: "t1",
        status: "closed",
        memberMessageIds: ["m1", "m2"],
        openedAtEventOrder: 1,
        closedAtEventOrder: 3,
      },
      {
        turnId: "t2",
        status: "open",
        memberMessageIds: ["m4"],
        openedAtEventOrder: 4,
      },
    ]);
  });
});
