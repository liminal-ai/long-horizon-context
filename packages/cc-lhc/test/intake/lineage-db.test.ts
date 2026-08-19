import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  appendThreadSignatures,
  bindCaptureThread,
  defaultLineageDbPath,
  loadThreadSignatures,
  lookupSessionLineage,
  openLineageDatabase,
  readPendingCurrentSession,
  recordPendingCurrentSession,
  recordSessionThread,
  threadForLegacySession,
  threadSessionRows,
} from "../../src/intake/lineage-db.js";
import { ccLhcHome } from "../../src/intake/paths.js";

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
    expect(threadForLegacySession(defaultLineageDbPath(), "session-a")).toBe("th_1");
  });

  it("tolerates a missing database file", () => {
    const home = tempHome();
    const dbPath = dbPathInHome(home);
    expect(threadForLegacySession(dbPath, "missing")).toBeUndefined();
  });

  it("renames corrupt databases aside and starts fresh", () => {
    const home = tempHome();
    const dbPath = dbPathInHome(home);
    mkdirSync(home, { recursive: true });
    writeFileSync(dbPath, "not sqlite");
    expect(threadForLegacySession(dbPath, "session-a")).toBeUndefined();
    expect(readdirSync(home).some((name) => name.includes(".corrupt-"))).toBe(true);
    recordSessionThread(dbPath, "session-a", "th_1", {}, { prefix: { kind: "none" } });
    expect(threadForLegacySession(dbPath, "session-a")).toBe("th_1");
  });

  it("lists a thread's session bindings oldest first for the alias import", () => {
    const home = tempHome();
    const dbPath = dbPathInHome(home);
    let tick = 0;
    const deps = {
      nowFn: () => {
        tick += 1;
        return new Date(Date.UTC(2026, 0, 1, 0, 0, tick));
      },
    };
    const verified = { kind: "verified" as const, lineCount: 4, byteLength: 80, sha256: "ab".repeat(32) };
    recordSessionThread(dbPath, "original", "th_lineage", deps, { prefix: { kind: "none" } });
    recordSessionThread(dbPath, "rebuilt", "th_lineage", deps, { prefix: verified });
    recordSessionThread(dbPath, "other-thread", "th_elsewhere", deps, { prefix: { kind: "none" } });

    const rows = threadSessionRows(dbPath, "th_lineage");
    expect(rows.map((row) => row.sessionId)).toEqual(["original", "rebuilt"]);
    expect(rows[1]!.prefix).toEqual(verified);
  });

  it("records the session against the thread the launch created", async () => {
    const home = tempHome();
    const dbPath = dbPathInHome(home);
    const bound = await bindCaptureThread({
      sessionId: "fresh-session",
      threadId: "th_fresh",
      threadCreatedAtLaunch: true,
      launchClass: "fresh",
      lineageDbPath: dbPath,
      registryPath: join(home, "registry.sqlite"),
    });

    expect(bound.isExistingThread).toBe(false);
    expect(bound.threadRef).toEqual({ threadId: "th_fresh", registryPath: join(home, "registry.sqlite") });
    expect(threadForLegacySession(dbPath, "fresh-session")).toBe("th_fresh");
  });

  it("binds a new session of an existing thread without inventing a row", async () => {
    const home = tempHome();
    const dbPath = dbPathInHome(home);
    recordSessionThread(dbPath, "session-hit", "th_hit", {}, { prefix: { kind: "none" } });
    const bound = await bindCaptureThread({
      sessionId: "session-later",
      threadId: "th_hit",
      threadCreatedAtLaunch: false,
      lineageDbPath: dbPath,
      registryPath: join(home, "registry.sqlite"),
    });

    expect(bound.isExistingThread).toBe(true);
    expect(bound.threadRef).toEqual({ threadId: "th_hit", registryPath: join(home, "registry.sqlite") });
    // Ordinary rebind never invents a target row as known-none.
    expect(threadForLegacySession(dbPath, "session-later")).toBeUndefined();
    expect(bound.prefix.kind).toBe("unknown");
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

  it("keeps concurrent session lineage writes", async () => {
    const home = tempHome();
    const dbPath = dbPathInHome(home);
    await Promise.all([
      Promise.resolve().then(() => recordSessionThread(dbPath, "session-one", "th_one", {}, { prefix: { kind: "none" } })),
      Promise.resolve().then(() => recordSessionThread(dbPath, "session-two", "th_two", {}, { prefix: { kind: "none" } })),
    ]);
    expect(threadForLegacySession(dbPath, "session-one")).toBe("th_one");
    expect(threadForLegacySession(dbPath, "session-two")).toBe("th_two");
  });

  it("lineage read failure leaves provenance unknown on the launch thread", async () => {
    const home = tempHome();
    const dbPath = dbPathInHome(home);
    recordSessionThread(dbPath, "mapped-session", "th_mapped", {}, { prefix: { kind: "none" } });
    const errors: string[] = [];
    const bound = await bindCaptureThread({
      sessionId: "mapped-session",
      threadId: "th_mapped",
      threadCreatedAtLaunch: false,
      lineageDbPath: dbPath,
      registryPath: join(home, "registry.sqlite"),
      logError: (message) => errors.push(message),
      lineageDeps: {
        withDb: () => {
          throw new Error("disk read fail");
        },
      },
    });

    expect(bound.threadRef).toEqual({ threadId: "th_mapped", registryPath: join(home, "registry.sqlite") });
    expect(bound.prefix.kind).toBe("unknown");
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
    expect(threadForLegacySession(dbPath, "after-recreate", deps)).toBe("th_ok");
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
    expect(threadForLegacySession(dbPath, "existing")).toBe("th_existing");
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

  it("serves the target session's durable verified prefix", async () => {
    const home = tempHome();
    const dbPath = dbPathInHome(home);
    const verified = {
      kind: "verified" as const,
      lineCount: 5,
      byteLength: 99,
      sha256: "cd".repeat(32),
    };
    recordSessionThread(dbPath, "target-rebuilt", "th_t", {}, { prefix: verified });
    const bound = await bindCaptureThread({
      sessionId: "target-rebuilt",
      threadId: "th_t",
      threadCreatedAtLaunch: false,
      lineageDbPath: dbPath,
    });
    expect(bound.prefix).toEqual(verified);
    expect(bound.replayedPrefixLines).toBe(5);
    expect(bound.isExistingThread).toBe(true);
  });

  it("migrates a pending-acceptance row written before it recorded a predecessor", () => {
    const home = tempHome();
    const dbPath = dbPathInHome(home);
    mkdirSync(home, { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE cc_pending_current_session (
        thread_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        accepted_at TEXT NOT NULL
      )
    `);
    db.prepare("INSERT INTO cc_pending_current_session (thread_id, session_id, accepted_at) VALUES (?, ?, ?)").run(
      "th_legacy_pending",
      "s-accepted",
      new Date().toISOString(),
    );
    db.close();

    // Opening through the production path adds the column; the pre-amendment
    // row keeps a null predecessor, so it can repair no state at all.
    expect(readPendingCurrentSession(dbPath, "th_legacy_pending")).toEqual({
      threadId: "th_legacy_pending",
      sessionId: "s-accepted",
      previousSessionId: null,
      acceptedAt: expect.any(String),
    });
    recordPendingCurrentSession(dbPath, "th_legacy_pending", "s-newer", "s-prior");
    expect(readPendingCurrentSession(dbPath, "th_legacy_pending")).toMatchObject({
      sessionId: "s-newer",
      previousSessionId: "s-prior",
    });
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
    await bindCaptureThread({
      sessionId: "fresh-none",
      threadId: "th_none",
      threadCreatedAtLaunch: true,
      launchClass: "fresh",
      lineageDbPath: dbPath,
    });
    expect(lookupSessionLineage(dbPath, "fresh-none")?.prefix.kind).toBe("none");
  });

  it("existing launch without target row does not establish known-none", async () => {
    const home = tempHome();
    const dbPath = dbPathInHome(home);
    const bound = await bindCaptureThread({
      sessionId: "resume-no-row",
      threadId: "th_ambig",
      threadCreatedAtLaunch: true,
      launchClass: "existing",
      lineageDbPath: dbPath,
    });
    expect(bound.prefix.kind).toBe("unknown");
    expect(lookupSessionLineage(dbPath, "resume-no-row")?.prefix.kind).toBe("unknown");
  });
});
