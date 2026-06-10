// CLI process-boundary suite for message projection: TC-2.4's spawned-CLI
// leg. A 300KB tool result goes in through real stdin (stdin → pipeline →
// projection) and comes back byte-identical through `messages list`, proving
// no layer between the pipe and the read-back shortens content. Runs under
// verify-all only.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    maxBuffer: 64 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

let dir: string;
let threadPath: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "lhc-proc-projection-"));
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

describe("Story 3 (process boundary): projection through the spawned binary", () => {
  it("TC-2.4 (CLI leg): a 300KB tool result piped through real stdin reads back byte-identical via messages list", () => {
    const bigContent = "spawned-cli verbatim δσπ 😀 line\n".repeat(10_000);
    expect(Buffer.byteLength(bigContent, "utf8")).toBeGreaterThan(300_000);
    const batch = [
      validEvent("user_prompt", { payload: { text: "run the big tool" } }),
      validEvent("tool_result", {
        payload: { toolCallId: "proc-big", content: bigContent, isError: false },
      }),
      validEvent("turn_end"),
    ];

    const recorded = runBinary(
      ["intake-stream", "message-events", "--file-path", threadPath],
      JSON.stringify(batch),
    );
    expect(recorded.status).toBe(0);
    const recordedParsed = JSON.parse(recorded.stdout) as {
      ok: boolean;
      value: { events: Array<{ outcome: string; messageId?: string }> };
    };
    expect(recordedParsed.ok).toBe(true);
    expect(recordedParsed.value.events.map((entry) => entry.messageId)).toEqual([
      "m1",
      "m2",
      undefined,
    ]);

    const listed = runBinary(["messages", "list", "--file-path", threadPath]);
    expect(listed.status).toBe(0);
    const listedParsed = JSON.parse(listed.stdout) as {
      ok: boolean;
      value: Array<{
        messageId: string;
        kind: string;
        tokenEstimate: number;
        blocks: Array<{ blockType: string; content: Record<string, unknown> }>;
      }>;
    };
    expect(listedParsed.ok).toBe(true);
    expect(listedParsed.value.map((message) => message.messageId)).toEqual(["m1", "m2"]);

    const toolResult = listedParsed.value[1]!;
    expect(toolResult.kind).toBe("tool_result");
    expect(toolResult.blocks).toHaveLength(1);
    expect(toolResult.blocks[0]!.blockType).toBe("tool_result");
    expect(toolResult.blocks[0]!.content["content"] === bigContent).toBe(true);
    expect(toolResult.blocks[0]!.content["toolCallId"]).toBe("proc-big");
    expect(toolResult.tokenEstimate).toBeGreaterThan(0);
  });
});
