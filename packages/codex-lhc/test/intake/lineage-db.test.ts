import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  appendThreadSignatures,
  defaultLineageDbPath,
  loadThreadSignatures,
  lookupThreadForSession,
  newestRolloutSessionId,
  newestSessionEntry,
  recordSessionThread,
  resolveCaptureThread,
  tryContinueThreadFromResumeLast,
} from "../../src/intake/lineage-db.js";
import { codexLhcHome } from "../../src/intake/paths.js";

const SESSION_HIT = "550e8400-e29b-41d4-a716-446655440010";
const SESSION_OLD = "550e8400-e29b-41d4-a716-446655440011";
const SESSION_NEW = "550e8400-e29b-41d4-a716-446655440012";
const SESSION_UNKNOWN = "550e8400-e29b-41d4-a716-446655440099";
const SESSION_FRESH = "550e8400-e29b-41d4-a716-446655440020";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "codex-lhc-home-"));
}

function dbPathInHome(home: string): string {
  process.env.CODEX_LHC_HOME = home;
  return join(home, "codex-lhc.sqlite");
}

function rolloutPath(sessionsRoot: string, sessionId: string, mtimeLabel: string): string {
  const dayDir = join(sessionsRoot, "2026", "07", "07");
  mkdirSync(dayDir, { recursive: true });
  return join(dayDir, `rollout-2026-07-07T12-00-${mtimeLabel}-${sessionId}.jsonl`);
}

describe("lineage sqlite", () => {
  it("stores session lineage in ~/.codex-lhc/codex-lhc.sqlite by default", () => {
    const home = tempHome();
    process.env.CODEX_LHC_HOME = home;
    expect(defaultLineageDbPath()).toBe(join(home, "codex-lhc.sqlite"));
    expect(codexLhcHome()).toBe(home);
    recordSessionThread(defaultLineageDbPath(), "session-a", "th_1");
    expect(lookupThreadForSession(defaultLineageDbPath(), "session-a")).toBe("th_1");
  });

  it("tolerates a missing database file", () => {
    const home = tempHome();
    const dbPath = dbPathInHome(home);
    expect(lookupThreadForSession(dbPath, "missing")).toBeUndefined();
  });

  it("renames corrupt databases aside and starts fresh", () => {
    const home = tempHome();
    const dbPath = dbPathInHome(home);
    mkdirSync(home, { recursive: true });
    writeFileSync(dbPath, "not sqlite");
    expect(lookupThreadForSession(dbPath, "session-a")).toBeUndefined();
    expect(readdirSync(home).some((name) => name.includes(".corrupt-"))).toBe(true);
    recordSessionThread(dbPath, "session-a", "th_1");
    expect(lookupThreadForSession(dbPath, "session-a")).toBe("th_1");
  });

  it("resolves resume-arg lookup through the old session id", async () => {
    const home = tempHome();
    const dbPath = dbPathInHome(home);
    recordSessionThread(dbPath, SESSION_OLD, "th_resume");

    let created = 0;
    const resolution = await resolveCaptureThread({
      sessionId: SESSION_NEW,
      cwd: "/work/project",
      resumeSessionId: SESSION_OLD,
      lineageDbPath: dbPath,
      createThreadFn: async () => {
        created += 1;
        return { ok: true, value: { threadId: "th_new", registryPath: join(home, "registry.sqlite") } };
      },
    });

    expect(created).toBe(0);
    expect(resolution.threadRef).toEqual({ threadId: "th_resume", registryPath: join(home, "registry.sqlite") });
    expect(lookupThreadForSession(dbPath, SESSION_NEW)).toBe("th_resume");
  });

  it("creates a thread when resume id has no lineage", async () => {
    const home = tempHome();
    const dbPath = dbPathInHome(home);
    let created = 0;
    const resolution = await resolveCaptureThread({
      sessionId: SESSION_FRESH,
      cwd: "/work/project",
      resumeSessionId: SESSION_UNKNOWN,
      lineageDbPath: dbPath,
      createThreadFn: async () => {
        created += 1;
        return { ok: true, value: { threadId: "th_fresh", registryPath: join(home, "registry.sqlite") } };
      },
    });

    expect(created).toBe(1);
    expect(resolution.isExistingThread).toBe(false);
    expect(lookupThreadForSession(dbPath, SESSION_FRESH)).toBe("th_fresh");
  });

  it("creates a thread on map miss and records the session", async () => {
    const home = tempHome();
    const dbPath = dbPathInHome(home);
    let created = 0;
    const resolution = await resolveCaptureThread({
      sessionId: SESSION_FRESH,
      cwd: "/work/project",
      lineageDbPath: dbPath,
      createThreadFn: async () => {
        created += 1;
        return { ok: true, value: { threadId: "th_fresh", registryPath: join(home, "registry.sqlite") } };
      },
    });

    expect(created).toBe(1);
    expect(resolution.isExistingThread).toBe(false);
    expect(lookupThreadForSession(dbPath, SESSION_FRESH)).toBe("th_fresh");
  });

  it("reuses a mapped thread on hit without creating a new one", async () => {
    const home = tempHome();
    const dbPath = dbPathInHome(home);
    recordSessionThread(dbPath, SESSION_HIT, "th_hit");
    let created = 0;
    const resolution = await resolveCaptureThread({
      sessionId: SESSION_HIT,
      cwd: "/work/project",
      lineageDbPath: dbPath,
      createThreadFn: async () => {
        created += 1;
        return { ok: true, value: { threadId: "th_other", registryPath: join(home, "registry.sqlite") } };
      },
    });
    expect(created).toBe(0);
    expect(resolution.threadRef).toEqual({ threadId: "th_hit", registryPath: join(home, "registry.sqlite") });
  });

  it("continues via resume-last when newest rollout file has lineage", async () => {
    const home = tempHome();
    const dbPath = dbPathInHome(home);
    const sessionsRoot = mkdtempSync(join(tmpdir(), "codex-lhc-sessions-"));
    const olderPath = rolloutPath(sessionsRoot, SESSION_OLD, "00");
    const newerPath = rolloutPath(sessionsRoot, SESSION_NEW, "01");
    writeFileSync(olderPath, '{"type":"session_meta"}\n');
    writeFileSync(newerPath, '{"type":"session_meta"}\n');
    recordSessionThread(dbPath, SESSION_OLD, "th_old");
    recordSessionThread(dbPath, SESSION_NEW, "th_new");

    const continued = await tryContinueThreadFromResumeLast(dbPath, sessionsRoot);
    expect(continued).toEqual({ sessionId: SESSION_NEW, threadId: "th_new" });
    expect(await newestRolloutSessionId(sessionsRoot)).toBe(SESSION_NEW);
  });

  it("resolveCaptureThread uses resume-last when newest rollout has lineage", async () => {
    const home = tempHome();
    const dbPath = dbPathInHome(home);
    const sessionsRoot = mkdtempSync(join(tmpdir(), "codex-lhc-sessions-resolve-"));
    const rollout = rolloutPath(sessionsRoot, SESSION_OLD, "00");
    writeFileSync(rollout, '{"type":"session_meta"}\n');
    recordSessionThread(dbPath, SESSION_OLD, "th_resume_last");

    let created = 0;
    const resolution = await resolveCaptureThread({
      sessionId: SESSION_FRESH,
      cwd: "/work/project",
      resumeLast: true,
      sessionsRoot,
      lineageDbPath: dbPath,
      createThreadFn: async () => {
        created += 1;
        return { ok: true, value: { threadId: "th_new", registryPath: join(home, "registry.sqlite") } };
      },
    });

    expect(created).toBe(0);
    expect(resolution.threadRef).toEqual({ threadId: "th_resume_last", registryPath: join(home, "registry.sqlite") });
    expect(lookupThreadForSession(dbPath, SESSION_FRESH)).toBe("th_resume_last");
  });

  it("creates a new thread when resume-last rollout has no lineage", async () => {
    const home = tempHome();
    const dbPath = dbPathInHome(home);
    const sessionsRoot = mkdtempSync(join(tmpdir(), "codex-lhc-sessions-no-lineage-"));
    const rollout = rolloutPath(sessionsRoot, SESSION_UNKNOWN, "00");
    writeFileSync(rollout, '{"type":"session_meta"}\n');

    let created = 0;
    const resolution = await resolveCaptureThread({
      sessionId: SESSION_FRESH,
      cwd: "/work/project",
      resumeLast: true,
      sessionsRoot,
      lineageDbPath: dbPath,
      createThreadFn: async () => {
        created += 1;
        return { ok: true, value: { threadId: "th_fresh", registryPath: join(home, "registry.sqlite") } };
      },
    });

    expect(created).toBe(1);
    expect(resolution.isExistingThread).toBe(false);
  });

  it("trims signature caches to the last 500 entries", () => {
    const home = tempHome();
    const dbPath = dbPathInHome(home);
    const initial = Array.from({ length: 499 }, (_, index) => `sig-${index}`);
    appendThreadSignatures(dbPath, "th_1", initial);
    appendThreadSignatures(dbPath, "th_1", ["sig-new-a", "sig-new-b"]);
    expect(loadThreadSignatures(dbPath, "th_1").length).toBe(500);
    const overflow = Array.from({ length: 10 }, (_, index) => `overflow-${index}`);
    appendThreadSignatures(dbPath, "th_1", overflow);
    const trimmed = loadThreadSignatures(dbPath, "th_1");
    expect(trimmed.length).toBe(500);
    expect(trimmed.at(-1)).toBe("overflow-9");
  });

  it("picks the newest session entry by updatedAt", () => {
    const home = tempHome();
    const dbPath = dbPathInHome(home);
    let tick = 0;
    const deps = {
      nowFn: () => {
        tick += 1;
        return new Date(Date.UTC(2026, 0, 1, 0, 0, tick));
      },
    };
    recordSessionThread(dbPath, "a", "th_a", deps);
    recordSessionThread(dbPath, "b", "th_b", deps);
    expect(newestSessionEntry(dbPath)?.sessionId).toBe("b");
  });

  it("keeps concurrent session lineage writes", async () => {
    const home = tempHome();
    const dbPath = dbPathInHome(home);
    await Promise.all([
      Promise.resolve().then(() => recordSessionThread(dbPath, "session-one", "th_one")),
      Promise.resolve().then(() => recordSessionThread(dbPath, "session-two", "th_two")),
    ]);
    expect(lookupThreadForSession(dbPath, "session-one")).toBe("th_one");
    expect(lookupThreadForSession(dbPath, "session-two")).toBe("th_two");
  });

  it("creates a new thread when lineage reads fail", async () => {
    const home = tempHome();
    const dbPath = dbPathInHome(home);
    recordSessionThread(dbPath, SESSION_HIT, "th_mapped");
    const errors: string[] = [];
    let created = 0;
    const resolution = await resolveCaptureThread({
      sessionId: SESSION_HIT,
      cwd: "/work/project",
      lineageDbPath: dbPath,
      logError: (message) => errors.push(message),
      lineageDeps: {
        withDb: () => {
          throw new Error("disk read fail");
        },
      },
      createThreadFn: async () => {
        created += 1;
        return { ok: true, value: { threadId: "th_fresh", registryPath: join(home, "registry.sqlite") } };
      },
    });

    expect(created).toBe(1);
    expect(resolution.threadRef).toEqual({ threadId: "th_fresh", registryPath: join(home, "registry.sqlite") });
    expect(errors.some((line) => line.includes("lineage read failed (continuing)"))).toBe(true);
  });

  it("closes handles when schema init fails and recreates after rename", () => {
    const home = tempHome();
    const dbPath = dbPathInHome(home);
    let opens = 0;
    let closes = 0;
    const deps = {
      openDbFn: (path: string) => {
        opens += 1;
        const db = new DatabaseSync(path);
        if (opens === 1) {
          const realExec = db.exec.bind(db);
          db.exec = (sql: string) => {
            if (sql.includes("CREATE TABLE")) throw new Error("schema init boom");
            return realExec(sql);
          };
          const realClose = db.close.bind(db);
          db.close = () => {
            closes += 1;
            return realClose();
          };
        }
        return db;
      },
    };

    recordSessionThread(dbPath, "after-recreate", "th_ok", deps);
    expect(closes).toBeGreaterThanOrEqual(1);
    expect(lookupThreadForSession(dbPath, "after-recreate", deps)).toBe("th_ok");
    expect(readdirSync(home).some((name) => name.includes(".corrupt-"))).toBe(true);
  });
});
