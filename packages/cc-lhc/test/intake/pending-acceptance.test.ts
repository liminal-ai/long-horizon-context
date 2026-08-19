import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

const registryMocks = vi.hoisted(() => ({
  /** Alias whose current-pointer advance the registry cannot write. */
  unwritableAlias: null as string | null,
}));

vi.mock("lhc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lhc")>();
  return {
    ...actual,
    threads: {
      ...actual.threads,
      registerCurrentAlias: async (registration: Parameters<typeof actual.threads.registerCurrentAlias>[0]) =>
        registration.alias === registryMocks.unwritableAlias
          ? {
              ok: false as const,
              error: {
                errorClass: "system_error" as const,
                code: "storage_failure" as const,
                reason: "attempt to write a readonly database",
              },
            }
          : actual.threads.registerCurrentAlias(registration),
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
  recordSwapAcceptance,
} from "../../src/intake/thread-alias.js";

const VERIFIED = { kind: "verified" as const, lineCount: 3, byteLength: 60, sha256: "ab".repeat(32) };

describe("a recorded acceptance the registry still cannot absorb", () => {
  it("lands on the accepted replacement, keeps the record, and never calls it unaccepted", async () => {
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-pending-unavailable-"));
    const registryPath = join(home, "registry.sqlite");
    const lineageDbPath = join(home, "cc-lhc.sqlite");
    let tick = 0;
    const clock = {
      nowFn: () => {
        tick += 1;
        return new Date(Date.UTC(2026, 0, 1, 0, 0, tick));
      },
    };

    await bindLaunchThread({
      sessionId: "s-old",
      registryPath,
      lineageDbPath,
      createThread: async () => "th_stuck",
    });
    await acceptCurrentSession({ sessionId: "s-old", threadId: "th_stuck", registryPath });
    recordSessionThread(lineageDbPath, "s-old", "th_stuck", clock, { prefix: { kind: "none" } });
    recordSessionThread(lineageDbPath, "s-accepted", "th_stuck", clock, { prefix: VERIFIED });
    recordPendingCurrentSession(lineageDbPath, "th_stuck", "s-accepted", "s-old", clock);

    registryMocks.unwritableAlias = claudeSessionAlias("s-accepted");
    const opened = await openLaunchThread({
      expectedSession: { sessionId: "s-old", source: "explicit_resume" },
      registryPath,
      lineageDbPath,
      home,
      createThread: async () => {
        throw new Error("must not create");
      },
    });

    try {
      // The safest forward path: the session this host already accepted, live
      // and captured, rather than the superseded one the pointer still names.
      expect(opened.expectedSession).toEqual({ sessionId: "s-accepted", source: "current_alias" });
      expect(opened.correctedFrom).toBe("s-old");
      expect(opened.discardedSwapArtifacts).toEqual([]);
      // Reported truthfully rather than papered over.
      expect(opened.pendingAcceptanceNote).toContain("registry pointer still cannot advance");
      expect(opened.pendingAcceptanceNote).toContain("readonly database");
      // Registry unchanged, record retained for the next attempt.
      expect(await currentSessionAlias("th_stuck", registryPath)).toBe(claudeSessionAlias("s-old"));
      expect(readPendingCurrentSession(lineageDbPath, "th_stuck")).toMatchObject({ sessionId: "s-accepted" });
    } finally {
      registryMocks.unwritableAlias = null;
      opened.lease.release();
    }
  });
});

describe("repeated handoffs inside one wrapper lifetime", () => {
  it("never lets a stale earlier acceptance drag the pointer back off the later one", async () => {
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-pending-repeat-"));
    const registryPath = join(home, "registry.sqlite");
    const lineageDbPath = join(home, "cc-lhc.sqlite");
    let tick = 0;
    const clock = {
      nowFn: () => {
        tick += 1;
        return new Date(Date.UTC(2026, 0, 1, 0, 0, tick));
      },
    };

    await bindLaunchThread({
      sessionId: "s0",
      registryPath,
      lineageDbPath,
      createThread: async () => "th_repeat",
    });
    await acceptCurrentSession({ sessionId: "s0", threadId: "th_repeat", registryPath });
    recordSessionThread(lineageDbPath, "s0", "th_repeat", clock, { prefix: { kind: "none" } });
    recordSessionThread(lineageDbPath, "s1", "th_repeat", clock, { prefix: VERIFIED });
    recordSessionThread(lineageDbPath, "s2", "th_repeat", clock, { prefix: VERIFIED });

    // One wrapper lifetime: it takes the thread lease once and keeps it across
    // every handoff it performs. No launch happens in between.
    const wrapper = await openLaunchThread({
      expectedSession: { sessionId: "s0", source: "explicit_resume" },
      registryPath,
      lineageDbPath,
      home,
      createThread: async () => {
        throw new Error("must not create");
      },
    });
    expect(wrapper.expectedSession.sessionId).toBe("s0");

    // First handoff: s1 is accepted, but the registry pointer cannot be written.
    registryMocks.unwritableAlias = claudeSessionAlias("s1");
    const first = await recordSwapAcceptance({
      sessionId: "s1",
      threadId: "th_repeat",
      registryPath,
      lineageDbPath,
      lineageDeps: clock,
    });
    registryMocks.unwritableAlias = null;
    expect(first).toMatchObject({ registryAdvanced: false, recovery: "recorded" });
    expect(readPendingCurrentSession(lineageDbPath, "th_repeat")).toMatchObject({
      sessionId: "s1",
      previousSessionId: "s0",
    });

    // Second handoff in the same lifetime: s2 is accepted and the pointer moves.
    // Its cleanup of the older record fails, so the stale s1 row survives.
    const second = await recordSwapAcceptance({
      sessionId: "s2",
      threadId: "th_repeat",
      registryPath,
      lineageDbPath,
      lineageDeps: {
        ...clock,
        withDb: () => {
          throw new Error("pending cleanup unavailable");
        },
      },
    });
    expect(second).toMatchObject({ registryAdvanced: true, recovery: "applied" });
    expect(await currentSessionAlias("th_repeat", registryPath)).toBe(claudeSessionAlias("s2"));
    expect(readPendingCurrentSession(lineageDbPath, "th_repeat")).toMatchObject({ sessionId: "s1" });

    wrapper.lease.release();

    // Restart, entering through the oldest alias.
    const restarted = await openLaunchThread({
      expectedSession: { sessionId: "s0", source: "explicit_resume" },
      registryPath,
      lineageDbPath,
      home,
      createThread: async () => {
        throw new Error("must not create");
      },
    });

    try {
      // s1 is never restored: the record could only repair the s0 it observed.
      expect(restarted.expectedSession).toEqual({ sessionId: "s2", source: "current_alias" });
      expect(await currentSessionAlias("th_repeat", registryPath)).toBe(claudeSessionAlias("s2"));
      expect(restarted.pendingAcceptanceNote).toContain("settled unapplied");
      expect(restarted.pendingAcceptanceNote).toContain("s2");
      // The stale record is settled rather than retried forever.
      expect(readPendingCurrentSession(lineageDbPath, "th_repeat")).toBeUndefined();
      // The live replacement is not an artifact to discard.
      expect(restarted.discardedSwapArtifacts).toEqual([]);
    } finally {
      restarted.lease.release();
    }
  });
});

describe("a pending record that observed no predecessor", () => {
  it("settles unapplied rather than guessing which state it could repair", async () => {
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-pending-null-"));
    const registryPath = join(home, "registry.sqlite");
    const lineageDbPath = join(home, "cc-lhc.sqlite");

    await bindLaunchThread({
      sessionId: "s-old",
      registryPath,
      lineageDbPath,
      createThread: async () => "th_null",
    });
    await acceptCurrentSession({ sessionId: "s-old", threadId: "th_null", registryPath });
    // The shape a pre-amendment build left behind.
    recordPendingCurrentSession(lineageDbPath, "th_null", "s-accepted", null);

    const opened = await openLaunchThread({
      expectedSession: { sessionId: "s-old", source: "explicit_resume" },
      registryPath,
      lineageDbPath,
      home,
      createThread: async () => {
        throw new Error("must not create");
      },
    });

    try {
      expect(opened.expectedSession.sessionId).toBe("s-old");
      expect(opened.pendingAcceptanceNote).toContain("no predecessor state to repair");
      expect(await currentSessionAlias("th_null", registryPath)).toBe(claudeSessionAlias("s-old"));
      expect(readPendingCurrentSession(lineageDbPath, "th_null")).toBeUndefined();
    } finally {
      opened.lease.release();
    }
  });
});
