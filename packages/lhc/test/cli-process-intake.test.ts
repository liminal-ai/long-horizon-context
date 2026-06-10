// CLI process-boundary suite for intake-stream: spawns the built dist/cli.js
// with real stdin pipes and real exit codes. Runs under verify-all only.
// The TTY leg of empty_stdin cannot be fabricated through a spawned pipe
// (no pty in the suite); it is proven in-process in intake.test.ts, and the
// empty-pipe leg here exercises the same adapter refusal.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eventBatch } from "./fixtures/index.js";

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
  dir = mkdtempSync(path.join(tmpdir(), "lhc-proc-intake-"));
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

describe("Story 2 (process boundary): message-events and list-events", () => {
  it("records a batch piped through real stdin and reads it back", () => {
    const batch = eventBatch(["user_prompt", "assistant_text", "turn_end"]);
    const recorded = runBinary(
      ["intake-stream", "message-events", "--file-path", threadPath],
      JSON.stringify(batch),
    );
    expect(recorded.status).toBe(0);
    const recordedParsed = JSON.parse(recorded.stdout) as {
      ok: boolean;
      value: { events: Array<{ outcome: string }>; threadPosition: { lastEventOrder: number } };
    };
    expect(recordedParsed.ok).toBe(true);
    expect(recordedParsed.value.events).toHaveLength(3);
    expect(recordedParsed.value.threadPosition.lastEventOrder).toBe(3);

    const listed = runBinary(["intake-stream", "list-events", "--file-path", threadPath]);
    expect(listed.status).toBe(0);
    const listedParsed = JSON.parse(listed.stdout) as {
      ok: boolean;
      value: Array<{ eventOrder: number; idempotencyKey: string }>;
    };
    expect(listedParsed.ok).toBe(true);
    expect(listedParsed.value.map((e) => e.eventOrder)).toEqual([1, 2, 3]);
    expect(listedParsed.value.map((e) => e.idempotencyKey)).toEqual(
      batch.map((e) => e.idempotencyKey),
    );
  });

  it("an empty stdin pipe exits 1 with empty_stdin", () => {
    const result = runBinary(
      ["intake-stream", "message-events", "--file-path", threadPath],
      "",
    );
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      error: { errorClass: string; code: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.errorClass).toBe("caller_error");
    expect(parsed.error.code).toBe("empty_stdin");
  });

  it("malformed stdin JSON exits 1 with a structured caller error", () => {
    const result = runBinary(
      ["intake-stream", "message-events", "--file-path", threadPath],
      "{definitely not json",
    );
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      error: { errorClass: string; code: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.errorClass).toBe("caller_error");
    expect(parsed.error.code).toBe("invalid_event");
  });

  it("a validation failure exits 1 with the JSON error shape naming the event index", () => {
    const batch = [{ ...eventBatch(["user_prompt"])[0]!, eventKind: "mystery_kind" }];
    const result = runBinary(
      ["intake-stream", "message-events", "--file-path", threadPath],
      JSON.stringify(batch),
    );
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      error: { errorClass: string; code: string; eventIndex?: number };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.errorClass).toBe("caller_error");
    expect(parsed.error.code).toBe("invalid_event");
    expect(parsed.error.eventIndex).toBe(0);
  });
});
