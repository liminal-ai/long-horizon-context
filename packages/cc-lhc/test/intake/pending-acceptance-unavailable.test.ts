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
    recordPendingCurrentSession(lineageDbPath, "th_stuck", "s-accepted", clock);

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
