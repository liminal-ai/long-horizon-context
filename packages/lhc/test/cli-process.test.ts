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

  it("a planned command reaches its fail-closed stub through the real binary", () => {
    // messages list went live in Story 3; list-queued-work is still stubbed.
    const result = runBinary(["messages", "list-queued-work", "--thread-id", "th_x"]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: {
        errorClass: "system_error",
        code: "storage_failure",
        reason: "not implemented: messages.list-queued-work",
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
