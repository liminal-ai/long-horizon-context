import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  discoverSessionFile,
  findSessionFileOnce,
  parseRolloutFilename,
} from "../../src/rollout/discover.js";

const SESSION_UUID = "019f3c44-62fa-7161-975a-3f456e028ff4";

function fakeDirent(name: string, isFile = true): Dirent {
  return {
    name,
    isFile: () => isFile,
    isDirectory: () => !isFile,
  } as Dirent;
}

function rolloutName(ts = "2026-07-07T10-05-00"): string {
  return `rollout-${ts}-${SESSION_UUID}.jsonl`;
}

function sessionsDir(codexHome: string, year: number, month: number, day: number): string {
  const dir = join(
    codexHome,
    "sessions",
    String(year),
    String(month).padStart(2, "0"),
    String(day).padStart(2, "0"),
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("parseRolloutFilename", () => {
  it("extracts the session uuid from a valid rollout filename", () => {
    expect(parseRolloutFilename(rolloutName())).toBe(SESSION_UUID);
    expect(parseRolloutFilename("notes.jsonl")).toBeNull();
    expect(parseRolloutFilename("rollout-bad-format.jsonl")).toBeNull();
  });
});

describe("findSessionFileOnce", () => {
  it("finds a new rollout file in today's date dir", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-lhc-discover-"));
    const todayDir = sessionsDir(codexHome, 2026, 7, 7);
    const fileName = rolloutName();
    const filePath = join(todayDir, fileName);
    writeFileSync(filePath, "{}\n");

    const startedAt = new Date(2026, 6, 7, 10, 0, 0);
    const startedAtMs = startedAt.getTime();
    const found = await findSessionFileOnce(startedAt, {
      codexHome,
      now: () => new Date(2026, 6, 7, 10, 30, 0),
      statFn: async () => ({
        birthtimeMs: startedAtMs + 1_000,
        mtimeMs: startedAtMs + 2_000,
      }),
    });

    expect(found).toEqual({ path: filePath, sessionId: SESSION_UUID });
  });

  it("finds a rollout in yesterday's dir just after midnight", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-lhc-discover-"));
    const yesterdayDir = sessionsDir(codexHome, 2026, 7, 6);
    const fileName = rolloutName("2026-07-06T23-58-00");
    const filePath = join(yesterdayDir, fileName);
    writeFileSync(filePath, "{}\n");

    const startedAt = new Date(2026, 6, 7, 0, 0, 0);
    const startedAtMs = startedAt.getTime();
    const found = await findSessionFileOnce(startedAt, {
      codexHome,
      now: () => new Date(2026, 6, 7, 0, 5, 0),
      statFn: async () => ({
        birthtimeMs: startedAtMs - 120_000,
        mtimeMs: startedAtMs + 60_000,
      }),
    });

    expect(found).toEqual({ path: filePath, sessionId: SESSION_UUID });
  });

  it("ignores files created or modified before wrapper start", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-lhc-discover-"));
    sessionsDir(codexHome, 2026, 7, 7);

    const startedAt = new Date(2026, 6, 7, 12, 0, 0);
    const startedAtMs = startedAt.getTime();
    const found = await findSessionFileOnce(startedAt, {
      codexHome,
      now: () => new Date(2026, 6, 7, 12, 30, 0),
      readdirFn: async () => [fakeDirent(rolloutName())],
      statFn: async () => ({
        birthtimeMs: startedAtMs - 120_000,
        mtimeMs: startedAtMs - 60_000,
      }),
    });

    expect(found).toBeNull();
  });

  it("ignores non-matching filenames and picks the newest qualifying rollout", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-lhc-discover-"));
    const todayDir = sessionsDir(codexHome, 2026, 7, 7);
    const olderName = rolloutName("2026-07-07T10-05-00");
    const newerName = rolloutName("2026-07-07T10-10-00");
    const olderPath = join(todayDir, olderName);
    const newerPath = join(todayDir, newerName);
    const startedAt = new Date(2026, 6, 7, 10, 0, 0);
    const startedAtMs = startedAt.getTime();

    const statsByPath = new Map<string, { birthtimeMs: number; mtimeMs: number }>([
      [
        olderPath,
        {
          birthtimeMs: startedAtMs + 1_000,
          mtimeMs: startedAtMs + 1_500,
        },
      ],
      [
        newerPath,
        {
          birthtimeMs: startedAtMs + 2_000,
          mtimeMs: startedAtMs + 2_500,
        },
      ],
    ]);

    const found = await findSessionFileOnce(startedAt, {
      codexHome,
      now: () => new Date(2026, 6, 7, 10, 30, 0),
      readdirFn: async () => [
        fakeDirent("session-index.jsonl"),
        fakeDirent(olderName),
        fakeDirent(newerName),
        fakeDirent("notes.txt", false),
      ],
      statFn: async (path) => {
        const stat = statsByPath.get(path);
        if (stat === undefined) throw new Error(`unexpected path: ${path}`);
        return stat;
      },
    });

    expect(found).toEqual({ path: newerPath, sessionId: SESSION_UUID });
  });

  it("treats missing date dirs as normal", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-lhc-discover-"));
    const startedAt = new Date(2026, 6, 7, 10, 0, 0);

    const found = await findSessionFileOnce(startedAt, {
      codexHome,
      now: () => new Date(2026, 6, 7, 10, 30, 0),
    });

    expect(found).toBeNull();
  });
});

describe("discoverSessionFile", () => {
  it("polls until a qualifying rollout appears", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-lhc-discover-"));
    const todayDir = sessionsDir(codexHome, 2026, 7, 7);
    const fileName = rolloutName();
    const filePath = join(todayDir, fileName);
    const startedAt = new Date(2026, 6, 7, 10, 0, 0);
    const startedAtMs = startedAt.getTime();
    let polls = 0;

    const found = await discoverSessionFile(startedAt, {
      codexHome,
      now: () => new Date(2026, 6, 7, 10, 30, 0),
      pollMs: 1,
      sleep: async () => {
        polls += 1;
        if (polls === 1) {
          writeFileSync(filePath, "{}\n");
        }
      },
      statFn: async () => ({
        birthtimeMs: startedAtMs + 1_000,
        mtimeMs: startedAtMs + 2_000,
      }),
    });

    expect(found).toEqual({ path: filePath, sessionId: SESSION_UUID });
    expect(polls).toBeGreaterThanOrEqual(1);
  });

  it("throws when aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      discoverSessionFile(new Date(), {
        codexHome: mkdtempSync(join(tmpdir(), "codex-lhc-discover-")),
        signal: controller.signal,
        pollMs: 1,
      }),
    ).rejects.toThrow("discoverSessionFile aborted");
  });
});

describe("expectedCwd filter", () => {
  it("skips a newer rollout from another workspace and picks the matching one", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-lhc-cwd-filter-"));
    const dayDir = join(codexHome, "sessions", "2026", "07", "07");
    mkdirSync(dayDir, { recursive: true });
    const meta = (id: string, cwd: string) =>
      `${JSON.stringify({ timestamp: "2026-07-07T12:00:00.000Z", type: "session_meta", payload: { session_id: id, id, cwd } })}\n`;
    const mine = "11111111-1111-4111-8111-111111111111";
    const foreign = "22222222-2222-4222-8222-222222222222";
    writeFileSync(join(dayDir, `rollout-2026-07-07T12-00-00-${mine}.jsonl`), meta(mine, "/work/mine"));
    writeFileSync(join(dayDir, `rollout-2026-07-07T12-00-05-${foreign}.jsonl`), meta(foreign, "/work/other"));
    // Foreign file is newer by mtime.
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(dayDir, `rollout-2026-07-07T12-00-05-${foreign}.jsonl`), future, future);

    const startedAt = new Date(Date.now() - 60_000);
    const filtered = await findSessionFileOnce(startedAt, {
      codexHome,
      now: () => new Date("2026-07-07T12:00:10.000Z"),
      expectedCwd: "/work/mine",
    });
    expect(filtered?.sessionId).toBe(mine);

    const unfiltered = await findSessionFileOnce(startedAt, {
      codexHome,
      now: () => new Date("2026-07-07T12:00:10.000Z"),
    });
    expect(unfiltered?.sessionId).toBe(foreign);
  });
});
