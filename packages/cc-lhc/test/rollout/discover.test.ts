import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Dirent } from "node:fs";

import { describe, expect, it } from "vitest";

import { encodeProjectPath, findSessionFileOnce } from "../../src/rollout/discover.js";

function fakeDirent(name: string, isFile = true): Dirent {
  return {
    name,
    isFile: () => isFile,
    isDirectory: () => !isFile,
  } as Dirent;
}

describe("encodeProjectPath", () => {
  it("replaces slashes with dashes", () => {
    expect(encodeProjectPath("/Users/alice/foo/bar")).toBe("-Users-alice-foo-bar");
  });

  it("matches Claude Code project dirs for paths containing dots", () => {
    expect(encodeProjectPath("/Users/parsifal2.0/Desktop/cc-lhc-smoke")).toBe(
      "-Users-parsifal2-0-Desktop-cc-lhc-smoke",
    );
  });
});

describe("findSessionFileOnce", () => {
  it("picks the newest jsonl active since wrapper start", async () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-discover-"));
    const cwd = "/work/project";
    const projectDir = join(projectsRoot, encodeProjectPath(cwd));
    const startedAt = new Date("2026-07-03T10:00:00.000Z");
    const oldPath = join(projectDir, "old.jsonl");
    const newPath = join(projectDir, "new.jsonl");

    const statsByPath = new Map<string, { birthtimeMs: number; mtimeMs: number }>([
      [
        oldPath,
        {
          birthtimeMs: Date.parse("2026-07-03T09:00:00.000Z"),
          mtimeMs: Date.parse("2026-07-03T09:30:00.000Z"),
        },
      ],
      [
        newPath,
        {
          birthtimeMs: Date.parse("2026-07-03T10:05:00.000Z"),
          mtimeMs: Date.parse("2026-07-03T10:06:00.000Z"),
        },
      ],
    ]);

    const found = await findSessionFileOnce(cwd, startedAt, {
      projectsRoot,
      readdirFn: async (dir) => {
        expect(dir).toBe(projectDir);
        return [fakeDirent("old.jsonl"), fakeDirent("new.jsonl"), fakeDirent("notes.txt", false)];
      },
      statFn: async (path) => {
        const stat = statsByPath.get(path);
        if (stat === undefined) throw new Error(`unexpected path: ${path}`);
        return stat;
      },
    });

    expect(found).toBe(newPath);
  });

  it("accepts existing files touched after wrapper start (resume case)", async () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-discover-"));
    const cwd = "/work/resume";
    const projectDir = join(projectsRoot, encodeProjectPath(cwd));
    const startedAt = new Date("2026-07-03T12:00:00.000Z");
    const resumedPath = join(projectDir, "continued.jsonl");

    const found = await findSessionFileOnce(cwd, startedAt, {
      projectsRoot,
      readdirFn: async () => [fakeDirent("continued.jsonl")],
      statFn: async () => ({
        birthtimeMs: Date.parse("2026-07-02T08:00:00.000Z"),
        mtimeMs: Date.parse("2026-07-03T12:01:00.000Z"),
      }),
    });

    expect(found).toBe(resumedPath);
  });
});
