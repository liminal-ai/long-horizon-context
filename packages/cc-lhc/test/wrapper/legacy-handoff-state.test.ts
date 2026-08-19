/**
 * Pre-rewrite handoff state is consumed once, under the thread lease, and only
 * for the thread that holds it.
 *
 * The recovery directory and the attempt table are shared by every thread on
 * the box and neither carries a thread column, so these tests are mostly about
 * what consumption must NOT touch: another thread's artifacts, and anything
 * whose identity cannot be read.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { openLineageDatabase, recordSessionThread } from "../../src/intake/lineage-db.js";
import { consumeLegacyHandoffState } from "../../src/wrapper/legacy-handoff-state.js";
import { TYPED_AHEAD_RESEND_NOTICE } from "../../src/wrapper/typed-ahead-input.js";
import { tsxCommand } from "../helpers/tsx.js";

const homes: string[] = [];

interface Home {
  home: string;
  recovery: string;
  lineageDbPath: string;
}

function tempHome(): Home {
  const home = mkdtempSync(join(tmpdir(), "cc-lhc-legacy-"));
  homes.push(home);
  const recovery = join(home, "recovery");
  mkdirSync(recovery, { recursive: true });
  return { home, recovery, lineageDbPath: join(home, "cc-lhc.sqlite") };
}

/**
 * A legacy input journal exactly as the pre-rewrite build wrote it: a framed
 * `[type:1][length:4 BE][JSON header]` record, then chunk and state records
 * that consumption must never need to read.
 */
function writeLegacyJournal(
  paths: Home,
  journalId: string,
  header: Record<string, unknown>,
  opts: { withBody?: boolean } = {},
): string {
  const payload = Buffer.from(JSON.stringify(header), "utf8");
  const frame = Buffer.allocUnsafe(5);
  frame.writeUInt8(0x01, 0);
  frame.writeUInt32BE(payload.length, 1);
  const parts = [frame, payload];
  if (opts.withBody !== false) {
    // A chunk record and a `delivering` state record — the send ambiguity the
    // old build wedged on, and which nothing here may look at.
    const chunk = Buffer.from("secret keystrokes", "utf8");
    const chunkFrame = Buffer.allocUnsafe(5);
    chunkFrame.writeUInt8(0x02, 0);
    chunkFrame.writeUInt32BE(chunk.length, 1);
    const stateFrame = Buffer.from([0x03, 0x00, 0x00, 0x00, 0x01, 0x01]);
    parts.push(chunkFrame, chunk, stateFrame);
  }
  const path = join(paths.recovery, `input-${journalId}.journal`);
  writeFileSync(path, Buffer.concat(parts));
  return path;
}

function writeLegacyRecoveryJson(paths: Home, name: string, body: Record<string, unknown>): string {
  const path = join(paths.recovery, `handoff-${name}.json`);
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
  return path;
}

/** The pre-rewrite per-attempt table, as an installed older build left it. */
function seedAttemptRow(paths: Home, receiptId: string, payload: unknown): void {
  const db = openLineageDatabase(paths.lineageDbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS cc_governor_attempts (
      receipt_id TEXT PRIMARY KEY,
      attempt_id TEXT NOT NULL,
      claim_epoch INTEGER NOT NULL,
      stage TEXT NOT NULL,
      payload_version INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.prepare(
    `INSERT INTO cc_governor_attempts
      (receipt_id, attempt_id, claim_epoch, stage, payload_version, payload_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    receiptId,
    `a-${receiptId}`,
    1,
    "replacement_ready",
    1,
    typeof payload === "string" ? payload : JSON.stringify(payload),
    "2026-08-17T00:00:00.000Z",
    "2026-08-17T00:00:00.000Z",
  );
  db.close();
}

function attemptReceiptIds(paths: Home): string[] {
  const db = openLineageDatabase(paths.lineageDbPath);
  const rows = db.prepare("SELECT receipt_id FROM cc_governor_attempts ORDER BY receipt_id").all() as Array<{
    receipt_id: string;
  }>;
  db.close();
  return rows.map((row) => row.receipt_id);
}

/** A RecoveryAttempt payload as the pre-rewrite recovery store serialized it. */
function attemptPayload(threadId: string | undefined, sessions: { old: string; rebuilt: string }): unknown {
  return {
    receiptId: "r",
    attemptId: "a",
    claimEpoch: 1,
    owner: { pid: 4242, startTicks: "1" },
    stage: "replacement_ready",
    artifacts: {
      ...(threadId === undefined ? {} : { threadId }),
      oldSessionId: sessions.old,
      rebuiltSessionId: sessions.rebuilt,
    },
  };
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("state this thread owns", () => {
  it("says nothing on a clean home", () => {
    const paths = tempHome();
    const outcome = consumeLegacyHandoffState({ ...paths, threadId: "th_a" });
    expect(outcome.notices).toEqual([]);
    expect(outcome.legacyRecoveryFiles).toBe(0);
    expect(outcome.legacyAttemptRows).toBe(0);
  });

  it("consumes a journal whose header names a session of this thread", () => {
    const paths = tempHome();
    recordSessionThread(paths.lineageDbPath, "s-a-old", "th_a", {}, { prefix: { kind: "none" } });
    const journal = writeLegacyJournal(paths, "j-a", {
      version: 1,
      journalId: "j-a",
      receiptId: "r1",
      attemptId: "a1",
      oldSessionId: "s-a-old",
      rebuiltSessionId: "s-a-new",
      createdAt: "2026-08-17T00:00:00.000Z",
    });

    const outcome = consumeLegacyHandoffState({ ...paths, threadId: "th_a" });
    expect(outcome.legacyRecoveryFiles).toBe(1);
    expect(outcome.notices.at(-1)).toBe(TYPED_AHEAD_RESEND_NOTICE);
    expect(existsSync(journal)).toBe(false);
    // Consumed once: a second launch has nothing left to settle.
    expect(consumeLegacyHandoffState({ ...paths, threadId: "th_a" }).notices).toEqual([]);
  });

  it("attributes a journal through the session the launch landed on, not only lineage", () => {
    const paths = tempHome();
    const journal = writeLegacyJournal(paths, "j-live", {
      version: 1,
      journalId: "j-live",
      oldSessionId: "s-current",
      rebuiltSessionId: "s-reserved",
      createdAt: "2026-08-17T00:00:00.000Z",
    });
    const outcome = consumeLegacyHandoffState({
      ...paths,
      threadId: "th_a",
      knownSessionIds: ["s-current"],
    });
    expect(outcome.legacyRecoveryFiles).toBe(1);
    expect(existsSync(journal)).toBe(false);
  });

  it("reads a journal no further than its header frame", () => {
    const paths = tempHome();
    recordSessionThread(paths.lineageDbPath, "s-a-old", "th_a", {}, { prefix: { kind: "none" } });
    // Truncated immediately after the header: no chunk record, no state record.
    const journal = writeLegacyJournal(
      paths,
      "j-header-only",
      { version: 1, journalId: "j-header-only", oldSessionId: "s-a-old", rebuiltSessionId: "s-a-new" },
      { withBody: false },
    );
    const outcome = consumeLegacyHandoffState({ ...paths, threadId: "th_a" });
    expect(outcome.legacyRecoveryFiles).toBe(1);
    expect(existsSync(journal)).toBe(false);
  });

  it("consumes a retained-input recovery artifact naming one of its sessions", () => {
    const paths = tempHome();
    recordSessionThread(paths.lineageDbPath, "s-a-new", "th_a", {}, { prefix: { kind: "none" } });
    const artifact = writeLegacyRecoveryJson(paths, "1-2", {
      reason: "rollback capture timeout",
      oldSessionId: "s-a-old",
      rebuiltSessionId: "s-a-new",
      bufferedInputBytes: 9,
      bufferedInputBase64: "aGVsbG8gdGhlcmU=",
    });
    const outcome = consumeLegacyHandoffState({ ...paths, threadId: "th_a" });
    expect(outcome.legacyRecoveryFiles).toBe(1);
    expect(outcome.notices.at(-1)).toBe(TYPED_AHEAD_RESEND_NOTICE);
    expect(existsSync(artifact)).toBe(false);
  });

  it("settles an attempt row whose payload names this thread", () => {
    const paths = tempHome();
    seedAttemptRow(paths, "r-a", attemptPayload("th_a", { old: "s-a-old", rebuilt: "s-a-new" }));
    const outcome = consumeLegacyHandoffState({ ...paths, threadId: "th_a" });
    expect(outcome.legacyAttemptRows).toBe(1);
    expect(outcome.notices.join("\n")).toContain("interrupted handoff attempt row");
    expect(outcome.notices.at(-1)).toBe(TYPED_AHEAD_RESEND_NOTICE);
    expect(attemptReceiptIds(paths)).toEqual([]);
    expect(consumeLegacyHandoffState({ ...paths, threadId: "th_a" }).notices).toEqual([]);
  });
});

describe("state belonging to another thread", () => {
  it("consumes only this thread's artifacts and rows, byte for byte", () => {
    const paths = tempHome();
    recordSessionThread(paths.lineageDbPath, "s-a-old", "th_a", {}, { prefix: { kind: "none" } });
    recordSessionThread(paths.lineageDbPath, "s-b-old", "th_b", {}, { prefix: { kind: "none" } });

    const journalA = writeLegacyJournal(paths, "j-a", {
      version: 1,
      journalId: "j-a",
      oldSessionId: "s-a-old",
      rebuiltSessionId: "s-a-new",
    });
    const journalB = writeLegacyJournal(paths, "j-b", {
      version: 1,
      journalId: "j-b",
      oldSessionId: "s-b-old",
      rebuiltSessionId: "s-b-new",
    });
    const artifactB = writeLegacyRecoveryJson(paths, "b", {
      reason: "rollback",
      oldSessionId: "s-b-old",
      rebuiltSessionId: "s-b-new",
      bufferedInputBytes: 3,
    });
    const journalBBefore = readFileSync(journalB);
    const artifactBBefore = readFileSync(artifactB);

    seedAttemptRow(paths, "r-a", attemptPayload("th_a", { old: "s-a-old", rebuilt: "s-a-new" }));
    seedAttemptRow(paths, "r-b", attemptPayload("th_b", { old: "s-b-old", rebuilt: "s-b-new" }));

    const outcome = consumeLegacyHandoffState({ ...paths, threadId: "th_a" });
    expect(outcome.legacyRecoveryFiles).toBe(1);
    expect(outcome.legacyAttemptRows).toBe(1);
    expect(existsSync(journalA)).toBe(false);

    // Thread B is untouched: same bytes, same row.
    expect(readFileSync(journalB)).toEqual(journalBBefore);
    expect(readFileSync(artifactB)).toEqual(artifactBBefore);
    expect(attemptReceiptIds(paths)).toEqual(["r-b"]);

    // And B's own wrapper can still settle it later, on its own lease.
    const outcomeB = consumeLegacyHandoffState({ ...paths, threadId: "th_b" });
    expect(outcomeB.legacyRecoveryFiles).toBe(2);
    expect(outcomeB.legacyAttemptRows).toBe(1);
    expect(existsSync(journalB)).toBe(false);
    expect(attemptReceiptIds(paths)).toEqual([]);
  });
});

describe("state that cannot be attributed", () => {
  it("leaves it exactly where it is and tells this operator nothing", () => {
    const paths = tempHome();
    recordSessionThread(paths.lineageDbPath, "s-a-old", "th_a", {}, { prefix: { kind: "none" } });

    // A journal with no framed header at all (the old build's torn file).
    const tornPath = join(paths.recovery, "input-torn.journal");
    writeFileSync(tornPath, Buffer.from([0x01, 0x02]));
    // A header frame that parses but names no session.
    const anonymous = writeLegacyJournal(paths, "j-anon", { version: 1, journalId: "j-anon" });
    // A header naming sessions no thread on this box claims.
    const foreign = writeLegacyJournal(paths, "j-foreign", {
      version: 1,
      journalId: "j-foreign",
      oldSessionId: "s-unknown",
      rebuiltSessionId: "s-unknown-new",
    });
    // Recovery JSON that is not JSON.
    const unparsable = join(paths.recovery, "handoff-bad.json");
    writeFileSync(unparsable, "{not json");
    // Rows that name no thread, and a payload that will not parse.
    seedAttemptRow(paths, "r-nothread", attemptPayload(undefined, { old: "s-x", rebuilt: "s-y" }));
    seedAttemptRow(paths, "r-corrupt", "{{{");

    const before = [tornPath, anonymous, foreign, unparsable].map((path) => readFileSync(path));
    const outcome = consumeLegacyHandoffState({ ...paths, threadId: "th_a" });

    // No claim, no deletion, and above all no resend notice for input that was
    // never this operator's.
    expect(outcome.notices).toEqual([]);
    expect(outcome.legacyRecoveryFiles).toBe(0);
    expect(outcome.legacyAttemptRows).toBe(0);
    for (const [index, path] of [tornPath, anonymous, foreign, unparsable].entries()) {
      expect(readFileSync(path)).toEqual(before[index]);
    }
    expect(attemptReceiptIds(paths)).toEqual(["r-corrupt", "r-nothread"]);
  });

  it("never throws when the host-local database cannot be opened", () => {
    const paths = tempHome();
    const outcome = consumeLegacyHandoffState({
      ...paths,
      threadId: "th_a",
      lineageDeps: {
        openDbFn: () => {
          throw new Error("cc-lhc.sqlite unreadable");
        },
      },
    });
    expect(outcome.notices).toEqual([]);
  });

  it("leaves attempt bookkeeping it cannot read alone, and says nothing about it", () => {
    const paths = tempHome();
    seedAttemptRow(paths, "r-a", attemptPayload("th_a", { old: "s-a-old", rebuilt: "s-a-new" }));

    const outcome = consumeLegacyHandoffState({
      ...paths,
      threadId: "th_a",
      lineageDeps: {
        // The table is there; its rows will not come back.
        openDbFn: (path: string) => {
          const real = openLineageDatabase(path);
          return new Proxy(real, {
            get(target, prop, receiver) {
              if (prop === "prepare") {
                return (sql: string) => {
                  if (sql.includes("FROM cc_governor_attempts")) {
                    throw new Error("database disk image is malformed");
                  }
                  return target.prepare(sql);
                };
              }
              return Reflect.get(target, prop, receiver).bind?.(target) ?? Reflect.get(target, prop, receiver);
            },
          });
        },
      },
    });
    expect(outcome.notices).toEqual([]);
    expect(outcome.legacyAttemptRows).toBe(0);
    // Unreadable is not the same as consumed: the row is still there.
    expect(attemptReceiptIds(paths)).toEqual(["r-a"]);
  });
});

describe("two wrappers consuming at once, each on its own thread lease", () => {
  it("cannot consume each other's state", async () => {
    const paths = tempHome();
    recordSessionThread(paths.lineageDbPath, "s-a-old", "th_a", {}, { prefix: { kind: "none" } });
    recordSessionThread(paths.lineageDbPath, "s-b-old", "th_b", {}, { prefix: { kind: "none" } });
    for (const thread of ["a", "b"]) {
      writeLegacyJournal(paths, `j-${thread}`, {
        version: 1,
        journalId: `j-${thread}`,
        oldSessionId: `s-${thread}-old`,
        rebuiltSessionId: `s-${thread}-new`,
      });
      seedAttemptRow(
        paths,
        `r-${thread}`,
        attemptPayload(`th_${thread}`, { old: `s-${thread}-old`, rebuilt: `s-${thread}-new` }),
      );
    }

    const here = dirname(fileURLToPath(import.meta.url));
    const tsx = tsxCommand(join(here, "../fixtures/legacy-consume-race-worker.ts"));
    const children: ChildProcess[] = [];
    const lines: string[] = [];
    const done = ["th_a", "th_b"].map((threadId) => {
      const child = spawn(tsx.command, tsx.args, {
        env: { ...process.env, RACE_HOME: paths.home, RACE_THREAD: threadId },
        stdio: ["ignore", "pipe", "inherit"],
      });
      children.push(child);
      return new Promise<void>((resolve, reject) => {
        let buffer = "";
        const timer = setTimeout(() => reject(new Error(`worker ${threadId} produced no outcome`)), 25_000);
        child.stdout!.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          if (buffer.includes("\n")) {
            clearTimeout(timer);
            lines.push(buffer.split("\n", 1)[0]!.trim());
            resolve();
          }
        });
        child.once("error", (cause) => {
          clearTimeout(timer);
          reject(cause);
        });
      });
    });

    try {
      // Both workers hold their leases before either is allowed to consume.
      await new Promise((resolve) => setTimeout(resolve, 300));
      writeFileSync(join(paths.home, "consume-go"), "go");
      await Promise.all(done);
    } finally {
      for (const child of children) child.kill("SIGKILL");
    }

    // Each consumed exactly its own one journal and one row.
    expect(lines.sort()).toEqual(["DONE th_a 1 1", "DONE th_b 1 1"]);
    expect(existsSync(join(paths.recovery, "input-j-a.journal"))).toBe(false);
    expect(existsSync(join(paths.recovery, "input-j-b.journal"))).toBe(false);
    expect(attemptReceiptIds(paths)).toEqual([]);
  }, 40_000);
});
