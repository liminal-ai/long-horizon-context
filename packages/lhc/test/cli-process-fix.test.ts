// Epic Fix Batch 1, process boundary: the strict-flag and blank-path guards
// observed through the spawned dist/cli.js. Runs under verify-all only
// (LHC_PROCESS_SUITE=1), like the other cli-process suites.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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

describe("Epic Fix Batch 1 (process boundary): CLI usage guards", () => {
  it("NB-2: an unknown flag exits 1 and is named back to the caller", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "lhc-fix-"));
    try {
      const result = runBinary([
        "threads",
        "new-thread",
        "--file-path",
        path.join(dir, "thread.sqlite"),
        "--file-pth",
        "typo",
        "--registry",
        path.join(dir, "registry.sqlite"),
      ]);
      expect(result.status).toBe(1);
      const parsed = JSON.parse(result.stdout) as {
        ok: boolean;
        error: { code: string; reason: string };
      };
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe("unknown_flag");
      expect(parsed.error.reason).toContain("--file-pth");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("F-EPIC-001: an empty --file-path exits 1 with a caller_error", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "lhc-fix-"));
    try {
      const result = runBinary([
        "threads",
        "new-thread",
        "--file-path",
        "",
        "--registry",
        path.join(dir, "registry.sqlite"),
      ]);
      expect(result.status).toBe(1);
      const parsed = JSON.parse(result.stdout) as {
        ok: boolean;
        error: { errorClass: string; code: string };
      };
      expect(parsed.ok).toBe(false);
      expect(parsed.error.errorClass).toBe("caller_error");
      expect(parsed.error.code).toBe("invalid_thread_ref");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
