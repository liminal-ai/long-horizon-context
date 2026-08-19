import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { threads } from "lhc";
import { describe, expect, it } from "vitest";

import { recordSessionThread } from "../../src/intake/lineage-db.js";
import {
  acceptCurrentSession,
  bindLaunchThread,
  claudeSessionAlias,
  claudeSessionIdFromAlias,
  currentSessionAlias,
  resolveLaunchThread,
  ThreadRegistryUnavailableError,
  unacceptedSwapArtifacts,
} from "../../src/intake/thread-alias.js";

interface Paths {
  home: string;
  registryPath: string;
  lineageDbPath: string;
}

function tempPaths(label: string): Paths {
  const home = mkdtempSync(join(tmpdir(), `cc-lhc-alias-${label}-`));
  return { home, registryPath: join(home, "registry.sqlite"), lineageDbPath: join(home, "cc-lhc.sqlite") };
}

/** A registry written before the alias map existed: threads listing only. */
function seedPreAliasRegistry(registryPath: string): void {
  mkdirSync(join(registryPath, ".."), { recursive: true });
  const db = new DatabaseSync(registryPath);
  db.exec(`CREATE TABLE threads (
    thread_id TEXT PRIMARY KEY,
    file_path TEXT NOT NULL,
    title TEXT,
    cwd TEXT,
    created_at TEXT NOT NULL
  );`);
  db.prepare("INSERT INTO threads (thread_id, file_path, created_at) VALUES (?, ?, ?)").run(
    "th_legacy",
    "/threads/th_legacy.sqlite",
    new Date().toISOString(),
  );
  db.close();
}

/** Ordered lineage writes so "most recently bound" is deterministic. */
function tickingClock(): { nowFn: () => Date } {
  let tick = 0;
  return {
    nowFn: () => {
      tick += 1;
      return new Date(Date.UTC(2026, 0, 1, 0, 0, tick));
    },
  };
}

const VERIFIED = { kind: "verified" as const, lineCount: 4, byteLength: 80, sha256: "ab".repeat(32) };

describe("Claude session aliases", () => {
  it("qualifies and unqualifies a Claude Code session id", () => {
    expect(claudeSessionAlias("abc")).toBe("claude-code:abc");
    expect(claudeSessionIdFromAlias("claude-code:abc")).toBe("abc");
  });

  it("does not collide with another host's alias for the same native id", async () => {
    const { registryPath, lineageDbPath } = tempPaths("collide");
    const uuid = "9f2f4e1a-0000-4000-8000-000000000001";

    const claude = await bindLaunchThread({
      sessionId: uuid,
      registryPath,
      lineageDbPath,
      createThread: async () => "th_claude",
    });
    // Another host registers the same native id under its own qualifier.
    const foreign = await threads.registerCurrentAlias({
      alias: `pi:${uuid}`,
      threadId: "th_pi",
      registryPath,
    });

    expect(claude.threadId).toBe("th_claude");
    expect(foreign.ok).toBe(true);
    expect(await resolveLaunchThread({ sessionId: uuid, registryPath, lineageDbPath })).toBe(
      "th_claude",
    );
    // The unqualified native id is not an alias at all.
    expect(claudeSessionIdFromAlias(uuid)).toBeNull();
  });
});

describe("launch thread resolution", () => {
  it("creates and claims a thread for a session no registry has seen", async () => {
    const { registryPath, lineageDbPath } = tempPaths("fresh");
    const bound = await bindLaunchThread({
      sessionId: "s-fresh",
      registryPath,
      lineageDbPath,
      createThread: async () => "th_new",
    });

    expect(bound).toEqual({ threadId: "th_new", createdAtLaunch: true });
    expect(await currentSessionAlias("th_new", registryPath)).toBe("claude-code:s-fresh");
  });

  it("adopts the winner's thread when another launch claimed the alias first", async () => {
    const { registryPath, lineageDbPath } = tempPaths("adopt");
    await threads.registerCurrentAlias({ alias: claudeSessionAlias("s-raced"), threadId: "th_winner", registryPath });

    let created = 0;
    const bound = await bindLaunchThread({
      sessionId: "s-raced",
      registryPath,
      lineageDbPath,
      createThread: async () => {
        created += 1;
        return "th_loser";
      },
    });

    // The alias already resolved, so nothing was created at all.
    expect(created).toBe(0);
    expect(bound).toEqual({ threadId: "th_winner", createdAtLaunch: false });
  });

  it("says the registry is unavailable instead of guessing a thread", async () => {
    const { home, registryPath, lineageDbPath } = tempPaths("unavailable");
    mkdirSync(home, { recursive: true });
    // A registry file that is not a database at all.
    const db = new DatabaseSync(registryPath);
    db.exec("CREATE TABLE threads (thread_id TEXT PRIMARY KEY, file_path TEXT NOT NULL, created_at TEXT NOT NULL);");
    db.exec("CREATE TABLE thread_alias (nonsense TEXT);");
    db.exec("PRAGMA user_version = 2;");
    db.close();

    await expect(
      resolveLaunchThread({ sessionId: "s-any", registryPath, lineageDbPath }),
    ).rejects.toBeInstanceOf(ThreadRegistryUnavailableError);
  });
});

describe("legacy lineage import", () => {
  it("imports every session of the thread once and makes the newest current", async () => {
    const { registryPath, lineageDbPath } = tempPaths("import");
    const clock = tickingClock();
    recordSessionThread(lineageDbPath, "s-original", "th_legacy", clock, { prefix: { kind: "none" } });
    recordSessionThread(lineageDbPath, "s-rebuilt", "th_legacy", clock, { prefix: VERIFIED });

    // Entering through the OLDEST alias still imports the whole thread.
    const bound = await bindLaunchThread({
      sessionId: "s-original",
      registryPath,
      lineageDbPath,
      createThread: async () => {
        throw new Error("must not create a thread when legacy lineage knows one");
      },
    });

    expect(bound).toEqual({ threadId: "th_legacy", createdAtLaunch: false });
    expect(await currentSessionAlias("th_legacy", registryPath)).toBe("claude-code:s-rebuilt");
    expect(await resolveLaunchThread({ sessionId: "s-rebuilt", registryPath, lineageDbPath })).toBe(
      "th_legacy",
    );
  });

  it("imports into a registry written before the alias map existed", async () => {
    const { registryPath, lineageDbPath } = tempPaths("migrated");
    seedPreAliasRegistry(registryPath);
    recordSessionThread(lineageDbPath, "s-migrated", "th_legacy", {}, { prefix: { kind: "none" } });

    const bound = await bindLaunchThread({
      sessionId: "s-migrated",
      registryPath,
      lineageDbPath,
      createThread: async () => {
        throw new Error("must not create");
      },
    });

    expect(bound.threadId).toBe("th_legacy");
    expect(await currentSessionAlias("th_legacy", registryPath)).toBe("claude-code:s-migrated");
    // The pre-existing threads listing survived the migration.
    const listed = await threads.listThreads({ registryPath });
    expect(listed.ok && listed.value.map((row) => row.threadId)).toEqual(["th_legacy"]);
  });

  it("never lets legacy storage override registry truth after the import", async () => {
    const { registryPath, lineageDbPath } = tempPaths("no-override");
    recordSessionThread(lineageDbPath, "s-known", "th_true", {}, { prefix: { kind: "none" } });
    await bindLaunchThread({
      sessionId: "s-known",
      registryPath,
      lineageDbPath,
      createThread: async () => {
        throw new Error("must not create");
      },
    });

    // Legacy storage is rewritten to point somewhere else entirely.
    recordSessionThread(lineageDbPath, "s-known", "th_impostor", {}, { prefix: { kind: "none" } });

    expect(await resolveLaunchThread({ sessionId: "s-known", registryPath, lineageDbPath })).toBe(
      "th_true",
    );
    expect(await currentSessionAlias("th_true", registryPath)).toBe("claude-code:s-known");
  });
});

describe("current session pointer", () => {
  it("advances to the accepted session so old aliases resolve forward", async () => {
    const { registryPath, lineageDbPath } = tempPaths("advance");
    await bindLaunchThread({
      sessionId: "s-old",
      registryPath,
      lineageDbPath,
      createThread: async () => "th_swap",
    });

    const advanced = await acceptCurrentSession({ sessionId: "s-new", threadId: "th_swap", registryPath });

    expect(advanced).toEqual({ ok: true });
    expect(await currentSessionAlias("th_swap", registryPath)).toBe("claude-code:s-new");
    // Both aliases still name the one thread.
    expect(await resolveLaunchThread({ sessionId: "s-old", registryPath, lineageDbPath })).toBe(
      "th_swap",
    );
  });

  it("re-read under the lock wins over a current read taken before it", async () => {
    const { registryPath, lineageDbPath } = tempPaths("reread");
    await bindLaunchThread({
      sessionId: "s-a",
      registryPath,
      lineageDbPath,
      createThread: async () => "th_race",
    });

    // Pre-lock: names the lock key only.
    const preLockThreadId = await resolveLaunchThread({
      sessionId: "s-a",
      registryPath,
      lineageDbPath,
    });
    const preLockCurrent = await currentSessionAlias("th_race", registryPath);

    // The prior owner accepts a swap in exactly this window.
    await acceptCurrentSession({ sessionId: "s-b", threadId: "th_race", registryPath });

    // …and the launch reads current again after taking the lock.
    const underLockCurrent = await currentSessionAlias(preLockThreadId!, registryPath);

    expect(preLockCurrent).toBe("claude-code:s-a");
    expect(underLockCurrent).toBe("claude-code:s-b");
  });
});

describe("interrupted swap artifacts", () => {
  it("reports rebuilt sessions reserved after the current one and nothing else", () => {
    const { lineageDbPath } = tempPaths("interrupted");
    const clock = tickingClock();
    recordSessionThread(lineageDbPath, "s-first", "th_i", clock, { prefix: { kind: "none" } });
    recordSessionThread(lineageDbPath, "s-accepted", "th_i", clock, { prefix: VERIFIED });
    recordSessionThread(lineageDbPath, "s-interrupted", "th_i", clock, { prefix: VERIFIED });

    const discarded = unacceptedSwapArtifacts({
      threadId: "th_i",
      currentAlias: claudeSessionAlias("s-accepted"),
      lineageDbPath,
    });

    expect(discarded.map((artifact) => artifact.sessionId)).toEqual(["s-interrupted"]);
  });

  it("reports nothing when the thread's current session is its latest binding", () => {
    const { lineageDbPath } = tempPaths("settled");
    const clock = tickingClock();
    recordSessionThread(lineageDbPath, "s-first", "th_s", clock, { prefix: { kind: "none" } });
    recordSessionThread(lineageDbPath, "s-accepted", "th_s", clock, { prefix: VERIFIED });

    expect(
      unacceptedSwapArtifacts({
        threadId: "th_s",
        currentAlias: claudeSessionAlias("s-accepted"),
        lineageDbPath,
      }),
    ).toEqual([]);
  });
});
