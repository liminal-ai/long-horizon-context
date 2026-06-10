// CLI process-boundary suite: spawns the built dist/cli.js. Runs under
// verify-all only (needs a build artifact); plain verify announces the skip.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cliPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../dist/cli.js",
);

function runBinary(args: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("FC-0.3 (process boundary): built binary", () => {
  it("dist/cli.js exists (build ran before this suite)", () => {
    expect(existsSync(cliPath)).toBe(true);
  });

  it("--help exits 0 with usage on stdout", () => {
    const result = runBinary(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage:");
  });

  it("unknown command exits 1 with structured JSON", () => {
    const result = runBinary(["nonsense"]);
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout) as { ok: boolean };
    expect(parsed.ok).toBe(false);
  });

  it("a structured SDK error reaches the caller through the real binary", () => {
    // Every command went live by Story 5 (list-queued-work was the last
    // stub), so the rail proof is now the real error path: an unknown thread
    // id renders the SDK's error result as JSON with exit 1.
    const result = runBinary(["messages", "list-queued-work", "--thread-id", "th_x"]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: {
        errorClass: "caller_error",
        code: "thread_not_found",
        reason: "no thread registered with id th_x",
      },
    });
  });

  it("Story 1: new-thread → resolve round-trip through the spawned binary", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "lhc-proc-"));
    try {
      const registryPath = path.join(dir, "registry.sqlite");
      const threadPath = path.join(dir, "thread.sqlite");

      const created = runBinary([
        "threads",
        "new-thread",
        "--file-path",
        threadPath,
        "--title",
        "process suite",
        "--registry",
        registryPath,
      ]);
      expect(created.status).toBe(0);
      const createdParsed = JSON.parse(created.stdout) as {
        ok: boolean;
        value: { threadId: string; filePath: string };
      };
      expect(createdParsed.ok).toBe(true);
      expect(createdParsed.value.filePath).toBe(threadPath);

      const resolved = runBinary([
        "threads",
        "resolve",
        "--thread-id",
        createdParsed.value.threadId,
        "--registry",
        registryPath,
      ]);
      expect(resolved.status).toBe(0);
      const resolvedParsed = JSON.parse(resolved.stdout) as {
        ok: boolean;
        value: { threadId: string; filePath: string; title?: string };
      };
      expect(resolvedParsed.ok).toBe(true);
      expect(resolvedParsed.value.threadId).toBe(createdParsed.value.threadId);
      expect(resolvedParsed.value.filePath).toBe(threadPath);
      expect(resolvedParsed.value.title).toBe("process suite");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
