import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

const ownerMocks = vi.hoisted(() => ({
  whileAcquiring: null as (() => void) | null,
}));

vi.mock("../../src/runtime/thread-owner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/runtime/thread-owner.js")>();
  return {
    ...actual,
    acquireThreadOwner: (threadId: string, options?: Parameters<typeof actual.acquireThreadOwner>[1]) => {
      const during = ownerMocks.whileAcquiring;
      ownerMocks.whileAcquiring = null;
      during?.();
      return actual.acquireThreadOwner(threadId, options ?? {});
    },
  };
});

import { openLaunchThread } from "../../src/intake/launch-thread.js";
import {
  readPendingCurrentSession,
  recordPendingCurrentSession,
  recordSessionThread,
} from "../../src/intake/lineage-db.js";
import {
  acceptCurrentSession,
  bindLaunchThread,
  claudeSessionAlias,
  currentSessionAlias,
  ThreadRegistryUnavailableError,
} from "../../src/intake/thread-alias.js";
import {
  acquireThreadOwner,
  ThreadOwnershipConflictError,
  threadOwnerGuardPath,
  threadOwnerPath,
} from "../../src/runtime/thread-owner.js";
import { tsxCommand } from "../helpers/tsx.js";

interface Home {
  home: string;
  registryPath: string;
  lineageDbPath: string;
}

function tempHome(label: string): Home {
  const home = mkdtempSync(join(tmpdir(), `cc-lhc-launch-${label}-`));
  return { home, registryPath: join(home, "registry.sqlite"), lineageDbPath: join(home, "cc-lhc.sqlite") };
}

function mustNotCreate(): Promise<string> {
  return Promise.reject(new Error("this launch must not create a thread"));
}

async function seedSwappedThread(paths: Home, threadId: string, first: string, current: string): Promise<void> {
  await bindLaunchThread({
    sessionId: first,
    registryPath: paths.registryPath,
    lineageDbPath: paths.lineageDbPath,
    createThread: async () => threadId,
  });
  await acceptCurrentSession({ sessionId: current, threadId, registryPath: paths.registryPath });
}

describe("opening a launch thread", () => {
  it("lands a fresh launch on its own session and owns the created thread", async () => {
    const paths = tempHome("fresh");
    const opened = await openLaunchThread({
      expectedSession: { sessionId: "s-fresh", source: "fresh" },
      registryPath: paths.registryPath,
      lineageDbPath: paths.lineageDbPath,
      home: paths.home,
      createThread: async () => "th_fresh",
    });

    try {
      expect(opened.threadId).toBe("th_fresh");
      expect(opened.createdAtLaunch).toBe(true);
      expect(opened.expectedSession).toEqual({ sessionId: "s-fresh", source: "fresh" });
      expect(opened.correctedFrom).toBeUndefined();
      expect(opened.lease.path).toBe(threadOwnerPath("th_fresh", paths.home));
      const stored = JSON.parse(readFileSync(opened.lease.path, "utf8")) as {
        threadId: string;
        token: string;
      };
      expect(stored.threadId).toBe("th_fresh");
      expect(stored.token).toBe(opened.lease.token);
      expect(existsSync(threadOwnerGuardPath("th_fresh", paths.home))).toBe(false);
    } finally {
      opened.lease.release();
    }
  });

  it("self-corrects a launch through an old alias onto the current session", async () => {
    const paths = tempHome("old-alias");
    await seedSwappedThread(paths, "th_swapped", "s-old", "s-current");

    const opened = await openLaunchThread({
      expectedSession: { sessionId: "s-old", source: "explicit_resume" },
      registryPath: paths.registryPath,
      lineageDbPath: paths.lineageDbPath,
      home: paths.home,
      createThread: mustNotCreate,
    });

    try {
      expect(opened.threadId).toBe("th_swapped");
      expect(opened.correctedFrom).toBe("s-old");
      expect(opened.expectedSession).toEqual({ sessionId: "s-current", source: "current_alias" });
    } finally {
      opened.lease.release();
    }
  });

  it("converges old and current aliases on one session and one lock", async () => {
    const paths = tempHome("converge");
    await seedSwappedThread(paths, "th_conv", "s-old", "s-current");

    const viaOld = await openLaunchThread({
      expectedSession: { sessionId: "s-old", source: "explicit_resume" },
      registryPath: paths.registryPath,
      lineageDbPath: paths.lineageDbPath,
      home: paths.home,
      createThread: mustNotCreate,
    });
    viaOld.lease.release();
    const viaCurrent = await openLaunchThread({
      expectedSession: { sessionId: "s-current", source: "explicit_resume" },
      registryPath: paths.registryPath,
      lineageDbPath: paths.lineageDbPath,
      home: paths.home,
      createThread: mustNotCreate,
    });

    try {
      expect(viaOld.expectedSession.sessionId).toBe("s-current");
      expect(viaCurrent.expectedSession.sessionId).toBe("s-current");
      expect(viaOld.lease.path).toBe(viaCurrent.lease.path);
    } finally {
      viaCurrent.lease.release();
    }
  });

  it("refuses a second launch on another alias of a thread it already owns", async () => {
    const paths = tempHome("conflict");
    await seedSwappedThread(paths, "th_busy", "s-old", "s-current");

    const first = await openLaunchThread({
      expectedSession: { sessionId: "s-current", source: "explicit_resume" },
      registryPath: paths.registryPath,
      lineageDbPath: paths.lineageDbPath,
      home: paths.home,
      createThread: mustNotCreate,
    });

    try {
      await expect(
        openLaunchThread({
          expectedSession: { sessionId: "s-old", source: "explicit_resume" },
          registryPath: paths.registryPath,
          lineageDbPath: paths.lineageDbPath,
          home: paths.home,
          createThread: mustNotCreate,
        }),
      ).rejects.toBeInstanceOf(ThreadOwnershipConflictError);
    } finally {
      first.lease.release();
    }
  });

  it("honours a swap accepted while this launch was taking the lock", async () => {
    const paths = tempHome("acquire-window");
    await seedSwappedThread(paths, "th_window", "s-old", "s-current");

    const accept = tsxCommand(join(dirname(fileURLToPath(import.meta.url)), "../fixtures/accept-current-session.ts"));
    ownerMocks.whileAcquiring = () => {
      execFileSync(accept.command, accept.args, {
        env: {
          ...process.env,
          ACCEPT_REGISTRY: paths.registryPath,
          ACCEPT_THREAD: "th_window",
          ACCEPT_SESSION: "s-newest",
        },
        stdio: ["ignore", "ignore", "inherit"],
      });
    };

    const opened = await openLaunchThread({
      expectedSession: { sessionId: "s-old", source: "explicit_resume" },
      registryPath: paths.registryPath,
      lineageDbPath: paths.lineageDbPath,
      home: paths.home,
      createThread: mustNotCreate,
    });

    try {
      expect(opened.expectedSession.sessionId).toBe("s-newest");
      expect(opened.correctedFrom).toBe("s-old");
    } finally {
      opened.lease.release();
    }
  }, 30_000);

  it("discards an interrupted swap's reserved session and lands on the current one", async () => {
    const paths = tempHome("interrupted");
    let tick = 0;
    const clock = {
      nowFn: () => {
        tick += 1;
        return new Date(Date.UTC(2026, 0, 1, 0, 0, tick));
      },
    };
    await seedSwappedThread(paths, "th_int", "s-old", "s-current");
    recordSessionThread(paths.lineageDbPath, "s-old", "th_int", clock, { prefix: { kind: "none" } });
    recordSessionThread(paths.lineageDbPath, "s-current", "th_int", clock, {
      prefix: { kind: "verified", lineCount: 2, byteLength: 40, sha256: "cd".repeat(32) },
    });
    recordSessionThread(paths.lineageDbPath, "s-reserved", "th_int", clock, {
      prefix: { kind: "verified", lineCount: 3, byteLength: 60, sha256: "ef".repeat(32) },
    });

    const opened = await openLaunchThread({
      expectedSession: { sessionId: "s-old", source: "explicit_resume" },
      registryPath: paths.registryPath,
      lineageDbPath: paths.lineageDbPath,
      home: paths.home,
      createThread: mustNotCreate,
    });

    try {
      expect(opened.discardedSwapArtifacts.map((artifact) => artifact.sessionId)).toEqual(["s-reserved"]);
      expect(opened.expectedSession.sessionId).toBe("s-current");
    } finally {
      opened.lease.release();
    }
  });
});

describe("a swap accepted before its registry pointer advanced", () => {
  it("reconciles the recorded acceptance under the lock and lands on the replacement", async () => {
    const paths = tempHome("pending");
    let tick = 0;
    const clock = {
      nowFn: () => {
        tick += 1;
        return new Date(Date.UTC(2026, 0, 1, 0, 0, tick));
      },
    };
    await seedSwappedThread(paths, "th_pending", "s-first", "s-old");
    recordSessionThread(paths.lineageDbPath, "s-old", "th_pending", clock, { prefix: { kind: "none" } });
    recordSessionThread(paths.lineageDbPath, "s-accepted", "th_pending", clock, {
      prefix: { kind: "verified", lineCount: 3, byteLength: 60, sha256: "ab".repeat(32) },
    });
    recordPendingCurrentSession(paths.lineageDbPath, "th_pending", "s-accepted", "s-old", clock);

    const opened = await openLaunchThread({
      expectedSession: { sessionId: "s-old", source: "explicit_resume" },
      registryPath: paths.registryPath,
      lineageDbPath: paths.lineageDbPath,
      home: paths.home,
      createThread: mustNotCreate,
    });

    try {
      expect(opened.expectedSession).toEqual({ sessionId: "s-accepted", source: "current_alias" });
      expect(opened.correctedFrom).toBe("s-old");
      expect(opened.discardedSwapArtifacts).toEqual([]);
      expect(opened.pendingAcceptanceNote).toBeUndefined();
      expect(await currentSessionAlias("th_pending", paths.registryPath)).toBe(claudeSessionAlias("s-accepted"));
      expect(readPendingCurrentSession(paths.lineageDbPath, "th_pending")).toBeUndefined();
    } finally {
      opened.lease.release();
    }
  });

  it("keeps the registry authoritative when it says that session is another thread's", async () => {
    const paths = tempHome("pending-foreign");
    await seedSwappedThread(paths, "th_own", "s-first", "s-old");
    await acceptCurrentSession({ sessionId: "s-elsewhere", threadId: "th_other", registryPath: paths.registryPath });
    recordPendingCurrentSession(paths.lineageDbPath, "th_own", "s-elsewhere", "s-old");

    const opened = await openLaunchThread({
      expectedSession: { sessionId: "s-first", source: "explicit_resume" },
      registryPath: paths.registryPath,
      lineageDbPath: paths.lineageDbPath,
      home: paths.home,
      createThread: mustNotCreate,
    });

    try {
      expect(opened.expectedSession.sessionId).toBe("s-old");
      expect(opened.pendingAcceptanceNote).toContain("discarded");
      expect(await currentSessionAlias("th_own", paths.registryPath)).toBe(claudeSessionAlias("s-old"));
      expect(readPendingCurrentSession(paths.lineageDbPath, "th_own")).toBeUndefined();
    } finally {
      opened.lease.release();
    }
  });
});

describe("a failure after the thread lock is taken", () => {
  it("releases the lease and reports the registry error truthfully", async () => {
    const paths = tempHome("post-lock");
    await seedSwappedThread(paths, "th_leak", "s-old", "s-current");

    ownerMocks.whileAcquiring = () => {
      writeFileSync(paths.registryPath, "not a database at all");
    };

    await expect(
      openLaunchThread({
        expectedSession: { sessionId: "s-old", source: "explicit_resume" },
        registryPath: paths.registryPath,
        lineageDbPath: paths.lineageDbPath,
        home: paths.home,
        createThread: mustNotCreate,
      }),
    ).rejects.toBeInstanceOf(ThreadRegistryUnavailableError);

    expect(existsSync(threadOwnerPath("th_leak", paths.home))).toBe(false);
    expect(existsSync(threadOwnerGuardPath("th_leak", paths.home))).toBe(false);
    const retry = acquireThreadOwner("th_leak", { home: paths.home });
    expect(retry.path).toBe(threadOwnerPath("th_leak", paths.home));
    retry.release();
  });
});

describe("concurrent launches through different aliases of one thread", () => {
  it("produce exactly one owner; every loser fails with a typed conflict", async () => {
    const paths = tempHome("race");
    await seedSwappedThread(paths, "th_race", "s-old", "s-current");

    const here = dirname(fileURLToPath(import.meta.url));
    const worker = join(here, "../fixtures/launch-alias-race-worker.ts");
    const tsx = tsxCommand(worker);
    const aliases = ["s-old", "s-current", "s-old", "s-current", "s-old", "s-current"];

    const children: ChildProcess[] = [];
    const outcomes = new Map<number, string>();
    const done: Array<Promise<void>> = [];
    for (const [index, sessionId] of aliases.entries()) {
      const child = spawn(tsx.command, tsx.args, {
        env: { ...process.env, RACE_HOME: paths.home, RACE_SESSION: sessionId },
        stdio: ["ignore", "pipe", "inherit"],
      });
      children.push(child);
      done.push(
        new Promise<void>((resolve, reject) => {
          let buffer = "";
          const timer = setTimeout(() => reject(new Error(`worker ${index} produced no outcome`)), 25_000);
          child.stdout!.on("data", (chunk: Buffer) => {
            buffer += chunk.toString("utf8");
            const line = buffer.split("\n", 1)[0];
            if (line !== undefined && buffer.includes("\n")) {
              clearTimeout(timer);
              outcomes.set(index, line.trim());
              resolve();
            }
          });
          child.once("error", (cause) => {
            clearTimeout(timer);
            reject(cause);
          });
        }),
      );
    }

    try {
      await Promise.all(done);
      const results = [...outcomes.values()];
      const wins = results.filter((line) => line.startsWith("WON "));
      const losses = results.filter((line) => line.startsWith("LOST "));
      expect(wins.length).toBe(1);
      expect(losses.length).toBe(aliases.length - 1);
      for (const loss of losses) {
        expect(["LOST ThreadOwnershipConflictError", "LOST ThreadOwnerGuardError"]).toContain(loss);
      }
      expect(wins[0]).toBe("WON th_race s-current");
      const stored = JSON.parse(readFileSync(threadOwnerPath("th_race", paths.home), "utf8")) as {
        threadId: string;
      };
      expect(stored.threadId).toBe("th_race");
      expect(existsSync(threadOwnerGuardPath("th_race", paths.home))).toBe(false);
    } finally {
      writeFileSync(join(paths.home, "race-stop"), "", { mode: 0o600 });
      await Promise.all(
        children.map(
          (child) =>
            new Promise<void>((resolve) => {
              const settle = (): void => {
                child.stdout?.destroy();
                child.removeAllListeners();
                resolve();
              };
              if (child.exitCode !== null || child.signalCode !== null) settle();
              else child.once("close", settle);
            }),
        ),
      );
    }
  }, 40_000);
});

describe("restart in the middle of a swap", () => {
  it("leaves a stale reserved rollout untouched on disk instead of activating it", async () => {
    const paths = tempHome("stale-file");
    await seedSwappedThread(paths, "th_stale", "s-old", "s-current");
    recordSessionThread(paths.lineageDbPath, "s-current", "th_stale", {}, { prefix: { kind: "none" } });
    recordSessionThread(
      paths.lineageDbPath,
      "s-reserved",
      "th_stale",
      {},
      {
        prefix: { kind: "verified", lineCount: 3, byteLength: 60, sha256: "ef".repeat(32) },
      },
    );
    const reservedFile = join(paths.home, "s-reserved.jsonl");
    writeFileSync(reservedFile, '{"reserved":true}\n');

    const opened = await openLaunchThread({
      expectedSession: { sessionId: "s-old", source: "explicit_resume" },
      registryPath: paths.registryPath,
      lineageDbPath: paths.lineageDbPath,
      home: paths.home,
      createThread: mustNotCreate,
    });
    try {
      expect(opened.expectedSession.sessionId).toBe("s-current");
      expect(opened.discardedSwapArtifacts.map((a) => a.sessionId)).toContain("s-reserved");
      expect(existsSync(reservedFile)).toBe(true);
      expect(readFileSync(reservedFile, "utf8")).toBe('{"reserved":true}\n');
    } finally {
      opened.lease.release();
    }
  });

  it("keeps an accepted replacement even after the old session was resumed again", async () => {
    const paths = tempHome("never-revert");
    await seedSwappedThread(paths, "th_keep", "s-first", "s-old");
    recordPendingCurrentSession(paths.lineageDbPath, "th_keep", "s-accepted", "s-old");
    const opened = await openLaunchThread({
      expectedSession: { sessionId: "s-old", source: "explicit_resume" },
      registryPath: paths.registryPath,
      lineageDbPath: paths.lineageDbPath,
      home: paths.home,
      createThread: mustNotCreate,
    });
    try {
      expect(opened.expectedSession.sessionId).toBe("s-accepted");
      expect(await currentSessionAlias("th_keep", paths.registryPath)).toBe(claudeSessionAlias("s-accepted"));
    } finally {
      opened.lease.release();
    }
  });

  it("treats a corrupt recovery row as unclaimed and lands on the registry pointer", async () => {
    const paths = tempHome("corrupt-row");
    await seedSwappedThread(paths, "th_corrupt", "s-old", "s-current");
    recordPendingCurrentSession(paths.lineageDbPath, "th_corrupt", "", "s-current");
    expect(readPendingCurrentSession(paths.lineageDbPath, "th_corrupt")).toBeUndefined();

    const opened = await openLaunchThread({
      expectedSession: { sessionId: "s-old", source: "explicit_resume" },
      registryPath: paths.registryPath,
      lineageDbPath: paths.lineageDbPath,
      home: paths.home,
      createThread: mustNotCreate,
    });
    try {
      expect(opened.expectedSession.sessionId).toBe("s-current");
      expect(opened.pendingAcceptanceNote).toBeUndefined();
    } finally {
      opened.lease.release();
    }
  });

  it("lands on the current session when host-local lineage detail cannot be read", async () => {
    const paths = tempHome("unreadable-lineage");
    await seedSwappedThread(paths, "th_unreadable", "s-old", "s-current");
    const opened = await openLaunchThread({
      expectedSession: { sessionId: "s-old", source: "explicit_resume" },
      registryPath: paths.registryPath,
      lineageDbPath: paths.lineageDbPath,
      home: paths.home,
      createThread: mustNotCreate,
      lineageDeps: {
        openDbFn: () => {
          throw new Error("cc-lhc.sqlite unreadable");
        },
      },
    });
    try {
      expect(opened.expectedSession.sessionId).toBe("s-current");
      expect(opened.discardedSwapArtifacts).toEqual([]);
    } finally {
      opened.lease.release();
    }
  });
});
