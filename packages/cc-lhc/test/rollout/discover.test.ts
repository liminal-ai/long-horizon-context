import type { Dirent } from "node:fs";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  encodeProjectPath,
  findExpectedSessionFileOnce,
  SessionAttributionError,
  resolveContinueSessionId,
} from "../../src/rollout/discover.js";

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

  it("matches Claude Code project dirs for paths containing underscores", () => {
    expect(encodeProjectPath("/Users/alice/foo_bar")).toBe("-Users-alice-foo-bar");
  });

  it("preserves only letters, digits, and hyphens", () => {
    expect(encodeProjectPath("/tmp/azAZ09-_. +=,;:@#%&!?[]'\"~^\u00e9\u2603/next")).toBe(
      "-tmp-azAZ09------------------------next",
    );
  });
});

describe("findExpectedSessionFileOnce", () => {
  it("binds only the expected session id file, not the newest peer", async () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-discover-"));
    const cwd = "/work/project";
    const projectDir = join(projectsRoot, encodeProjectPath(cwd));
    mkdirSync(projectDir, { recursive: true });
    const expectedId = "expected-session-id";
    const expectedPath = join(projectDir, `${expectedId}.jsonl`);
    const newerPath = join(projectDir, "newer-session-id.jsonl");
    writeFileSync(expectedPath, "{}\n");
    writeFileSync(newerPath, "{}\n");

    const found = await findExpectedSessionFileOnce(cwd, expectedId, {
      projectsRoot,
      readdirFn: async () => [fakeDirent("expected-session-id.jsonl"), fakeDirent("newer-session-id.jsonl")],
      statFn: async (path) => {
        if (path === expectedPath) {
          return { birthtimeMs: 1, mtimeMs: 1 };
        }
        if (path === newerPath) {
          return { birthtimeMs: 9, mtimeMs: 9 };
        }
        throw new Error(`unexpected path ${path}`);
      },
    });

    expect(found).toBe(expectedPath);
  });

  it("returns null when the expected file is missing (no recency fallback)", async () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-discover-miss-"));
    const cwd = "/work/missing";
    const found = await findExpectedSessionFileOnce(cwd, "no-such-session", {
      projectsRoot,
      readdirFn: async () => [fakeDirent("other.jsonl")],
      statFn: async () => {
        throw Object.assign(new Error("enoent"), { code: "ENOENT" });
      },
    });
    expect(found).toBeNull();
  });

  it("two expected ids in one cwd bind independently", async () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-discover-two-"));
    const cwd = "/work/dual";
    const projectDir = join(projectsRoot, encodeProjectPath(cwd));
    mkdirSync(projectDir, { recursive: true });
    const a = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const b = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    writeFileSync(join(projectDir, `${a}.jsonl`), "{}\n");
    writeFileSync(join(projectDir, `${b}.jsonl`), "{}\n");

    const foundA = await findExpectedSessionFileOnce(cwd, a, { projectsRoot });
    const foundB = await findExpectedSessionFileOnce(cwd, b, { projectsRoot });
    expect(foundA).toBe(join(projectDir, `${a}.jsonl`));
    expect(foundB).toBe(join(projectDir, `${b}.jsonl`));
    expect(foundA).not.toBe(foundB);
  });
});

describe("resolveContinueSessionId", () => {
  it("resolves newest jsonl id for pre-launch continue rewrite only", async () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-continue-"));
    const cwd = "/work/cont";
    const projectDir = join(projectsRoot, encodeProjectPath(cwd));
    const oldPath = join(projectDir, "old.jsonl");
    const newPath = join(projectDir, "new.jsonl");
    const id = await resolveContinueSessionId(cwd, {
      projectsRoot,
      readdirFn: async () => [fakeDirent("old.jsonl"), fakeDirent("new.jsonl")],
      statFn: async (path) => {
        if (path === oldPath) return { birthtimeMs: 1, mtimeMs: 1 };
        if (path === newPath) return { birthtimeMs: 2, mtimeMs: 99 };
        throw new Error("bad path");
      },
    });
    expect(id).toBe("new");
  });
});

describe("SessionAttributionError", () => {
  it("is thrown for empty expected id", async () => {
    await expect(findExpectedSessionFileOnce("/w", "", {})).rejects.toBeInstanceOf(SessionAttributionError);
  });
});
