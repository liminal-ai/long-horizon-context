import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  appendThreadSignatures,
  defaultLineageDbPath,
  loadThreadSignatures,
  lookupSessionLineage,
  lookupThreadForSession,
  newestSessionEntry,
  openLineageDatabase,
  recordSessionThread,
  resolveCaptureThread,
  tryContinueThreadFromNewestSession,
} from "../../src/intake/lineage-db.js";
import { ccLhcHome } from "../../src/intake/paths.js";
import { encodeProjectPath } from "../../src/rollout/discover.js";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "cc-lhc-home-"));
}

function dbPathInHome(home: string): string {
  process.env.CC_LHC_HOME = home;
  return join(home, "cc-lhc.sqlite");
}

describe("lineage sqlite", () => {
  it("stores session lineage in ~/.cc-lhc/cc-lhc.sqlite by default", () => {
    const home = tempHome();
    process.env.CC_LHC_HOME = home;
    expect(defaultLineageDbPath()).toBe(join(home, "cc-lhc.sqlite"));
    expect(ccLhcHome()).toBe(home);
    recordSessionThread(defaultLineageDbPath(), "session-a", "th_1", {}, { prefix: { kind: "none" } });
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
    recordSessionThread(dbPath, "session-a", "th_1", {}, { prefix: { kind: "none" } });
    expect(lookupThreadForSession(dbPath, "session-a")).toBe("th_1");
  });

  it("resolves resume-arg lookup through the old session id", async () => {
    const home = tempHome();
    const dbPath = dbPathInHome(home);
    recordSessionThread(dbPath, "old-session", "th_resume", {}, { prefix: { kind: "none" } });

    let created = 0;
    const resolution = await resolveCaptureThread({
      sessionId: "new-session",
      cwd: "/work/project",
      resumeSessionId: "old-session",
      lineageDbPath: dbPath,
      createThreadFn: async () => {
        created += 1;
        return { ok: true, value: { threadId: "th_new", registryPath: join(home, "registry.sqlite") } };
      },
    });

    expect(created).toBe(0);
    expect(resolution.threadRef).toEqual({ threadId: "th_resume", registryPath: join(home, "registry.sqlite") });
    // Ordinary rebind does not invent a target row as known-none.
    expect(lookupThreadForSession(dbPath, "new-session")).toBeUndefined();
    expect(resolution.prefix.kind).toBe("unknown");
  });

  it("creates a thread on map miss and records the session", async () => {
    const home = tempHome();
    const dbPath = dbPathInHome(home);
    let created = 0;
    const resolution = await resolveCaptureThread({
      sessionId: "fresh-session",
      cwd: "/work/project",
      lineageDbPath: dbPath,
      createThreadFn: async () => {
        created += 1;
        return { ok: true, value: { threadId: "th_fresh", registryPath: join(home, "registry.sqlite") } };
      },
    });

    expect(created).toBe(1);
    expect(resolution.isExistingThread).toBe(false);
    expect(lookupThreadForSession(dbPath, "fresh-session")).toBe("th_fresh");
  });

  it("reuses a mapped thread on hit without creating a new one", async () => {
    const home = tempHome();
    const dbPath = dbPathInHome(home);
    recordSessionThread(dbPath, "session-hit", "th_hit", {}, { prefix: { kind: "none" } });
    let created = 0;
    const resolution = await resolveCaptureThread({
      sessionId: "session-hit",
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

  it("continues via --continue when newest map entry matches newest jsonl", async () => {
    const home = tempHome();
    const dbPath = dbPathInHome(home);
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-lineage-continue-"));
    const cwd = "/work/continue";
    const projectDir = join(root, encodeProjectPath(cwd));
    mkdirSync(projectDir, { recursive: true });
    const sessionId = "continue-session";
    const rolloutPath = join(projectDir, `${sessionId}.jsonl`);
    writeFileSync(rolloutPath, '{"type":"user"}\n');
    recordSessionThread(dbPath, sessionId, "th_continue", {}, { prefix: { kind: "none" } });

    const continued = await tryContinueThreadFromNewestSession(dbPath, cwd, root, {
      readdirFn: (async () => [`${sessionId}.jsonl`]) as unknown as typeof import("node:fs/promises").readdir,
      statFn: async () => ({ mtimeMs: Date.now() }) as never,
    });
    expect(continued).toEqual({ sessionId, threadId: "th_continue" });
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
    recordSessionThread(dbPath, "a", "th_a", deps, { prefix: { kind: "none" } });
    recordSessionThread(dbPath, "b", "th_b", deps, { prefix: { kind: "none" } });
    expect(newestSessionEntry(dbPath)?.sessionId).toBe("b");
  });

  it("keeps concurrent session lineage writes", async () => {
    const home = tempHome();
    const dbPath = dbPathInHome(home);
    await Promise.all([
      Promise.resolve().then(() => recordSessionThread(dbPath, "session-one", "th_one", {}, { prefix: { kind: "none" } })),
      Promise.resolve().then(() => recordSessionThread(dbPath, "session-two", "th_two", {}, { prefix: { kind: "none" } })),
    ]);
    expect(lookupThreadForSession(dbPath, "session-one")).toBe("th_one");
    expect(lookupThreadForSession(dbPath, "session-two")).toBe("th_two");
  });

  it("creates a new thread when lineage reads fail", async () => {
    const home = tempHome();
    const dbPath = dbPathInHome(home);
    recordSessionThread(dbPath, "mapped-session", "th_mapped", {}, { prefix: { kind: "none" } });
    const errors: string[] = [];
    let created = 0;
    const resolution = await resolveCaptureThread({
      sessionId: "mapped-session",
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
            if (sql.includes("CREATE TABLE")) {
              const error = new Error("file is not a database") as Error & { code?: string };
              error.code = "ERR_SQLITE_NOTADB";
              throw error;
            }
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

    recordSessionThread(dbPath, "after-recreate", "th_ok", deps, { prefix: { kind: "none" } });
    expect(closes).toBeGreaterThanOrEqual(1);
    expect(lookupThreadForSession(dbPath, "after-recreate", deps)).toBe("th_ok");
    expect(readdirSync(home).some((name) => name.includes(".corrupt-"))).toBe(true);
  });

  it("never renames a healthy database on a transient lock", () => {
    const home = tempHome();
    const dbPath = dbPathInHome(home);
    recordSessionThread(dbPath, "existing", "th_existing", {}, { prefix: { kind: "none" } });
    let renamed = false;
    expect(() =>
      openLineageDatabase(dbPath, {
        openDbFn: () => {
          const error = new Error("database is locked") as Error & { code?: string };
          error.code = "ERR_SQLITE_BUSY";
          throw error;
        },
        renameFn: () => {
          renamed = true;
        },
      }),
    ).toThrow(/database is locked/);
    expect(renamed).toBe(false);
    expect(lookupThreadForSession(dbPath, "existing")).toBe("th_existing");
  });

  it("persists verified prefix boundary and preserves it across ordinary re-bind", () => {
    const home = tempHome();
    const dbPath = dbPathInHome(home);
    const verified = {
      kind: "verified" as const,
      lineCount: 7,
      byteLength: 120,
      sha256: "ab".repeat(32),
    };
    recordSessionThread(dbPath, "rebuilt-sid", "th_r", {}, { prefix: verified });
    expect(lookupSessionLineage(dbPath, "rebuilt-sid")).toMatchObject({
      threadId: "th_r",
      replayedPrefixLines: 7,
      prefix: verified,
    });
    // Ordinary re-bind (no prefix option) must not clear the fence.
    recordSessionThread(dbPath, "rebuilt-sid", "th_r");
    expect(lookupSessionLineage(dbPath, "rebuilt-sid")?.prefix).toEqual(verified);
  });

  it("count-only registration is not promoted to verified", () => {
    const home = tempHome();
    const dbPath = dbPathInHome(home);
    recordSessionThread(dbPath, "count-only", "th_c", {}, { replayedPrefixLines: 7 });
    expect(lookupSessionLineage(dbPath, "count-only")?.prefix.kind).toBe("unknown");
  });

  it("resolveCaptureThread returns durable verified prefix for the target session", async () => {
    const home = tempHome();
    const dbPath = dbPathInHome(home);
    const verified = {
      kind: "verified" as const,
      lineCount: 5,
      byteLength: 99,
      sha256: "cd".repeat(32),
    };
    recordSessionThread(dbPath, "target-rebuilt", "th_t", {}, { prefix: verified });
    const resolution = await resolveCaptureThread({
      sessionId: "target-rebuilt",
      cwd: "/work",
      lineageDbPath: dbPath,
      createThreadFn: async () => {
        throw new Error("must not create");
      },
    });
    expect(resolution.prefix).toEqual(verified);
    expect(resolution.replayedPrefixLines).toBe(5);
    expect(resolution.isExistingThread).toBe(true);
  });

  it("migrates pre-prefix schema; legacy rows are unknown not known-zero", () => {
    const home = tempHome();
    const dbPath = dbPathInHome(home);
    mkdirSync(home, { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE cc_session_lineage (
        rollout_session_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    db.prepare(
      "INSERT INTO cc_session_lineage (rollout_session_id, thread_id, updated_at) VALUES (?, ?, ?)",
    ).run("legacy-sid", "th_legacy", new Date().toISOString());
    db.close();

    // Open via production path — must ALTER; legacy is unknown (not trusted none).
    expect(lookupSessionLineage(dbPath, "legacy-sid")).toMatchObject({
      threadId: "th_legacy",
      prefix: { kind: "unknown" },
      replayedPrefixLines: 0,
    });
    const verified = {
      kind: "verified" as const,
      lineCount: 3,
      byteLength: 50,
      sha256: "ef".repeat(32),
    };
    recordSessionThread(dbPath, "legacy-sid", "th_legacy", {}, { prefix: verified });
    expect(lookupSessionLineage(dbPath, "legacy-sid")?.prefix).toEqual(verified);
  });

  it("fresh thread create records known-none prefix only with launchClass fresh", async () => {
    const home = tempHome();
    const dbPath = dbPathInHome(home);
    await resolveCaptureThread({
      sessionId: "fresh-none",
      cwd: "/work",
      launchClass: "fresh",
      lineageDbPath: dbPath,
      createThreadFn: async () => ({
        ok: true,
        value: { threadId: "th_none", registryPath: join(home, "reg.sqlite") },
      }),
    });
    expect(lookupSessionLineage(dbPath, "fresh-none")?.prefix.kind).toBe("none");
  });

  it("existing launch without target row does not establish known-none", async () => {
    const home = tempHome();
    const dbPath = dbPathInHome(home);
    const resolution = await resolveCaptureThread({
      sessionId: "resume-no-row",
      cwd: "/work",
      launchClass: "existing",
      resumeSessionId: "missing-source",
      lineageDbPath: dbPath,
      createThreadFn: async () => ({
        ok: true,
        value: { threadId: "th_ambig", registryPath: join(home, "reg.sqlite") },
      }),
    });
    expect(resolution.prefix.kind).toBe("unknown");
    expect(lookupSessionLineage(dbPath, "resume-no-row")?.prefix.kind).toBe("unknown");
  });
});
