// CLI process-boundary suite: spawns the built dist/cli.js. Runs under
// verify-all only (needs a build artifact); plain verify announces the skip.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
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
    const result = runBinary(["threads", "list"]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: {
        errorClass: "system_error",
        code: "storage_failure",
        reason: "not implemented: threads.list",
      },
    });
  });
});
