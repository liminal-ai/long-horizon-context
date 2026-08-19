/**
 * Durable handoff state left by an installed pre-rewrite build is consumed on
 * the way up, once, and never wedges a launch. Whatever shape it is in — a
 * journal caught mid-delivery, an unreadable one, an open attempt row with no
 * journal — it resolves to the same fact: input may not have been delivered.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openLineageDatabase } from "../../src/intake/lineage-db.js";
import { consumeLegacyHandoffState } from "../../src/wrapper/legacy-handoff-state.js";
import { TYPED_AHEAD_RESEND_NOTICE } from "../../src/wrapper/typed-ahead-input.js";

const homes: string[] = [];

function tempHome(): { home: string; lineageDbPath: string } {
  const home = mkdtempSync(join(tmpdir(), "cc-lhc-legacy-"));
  homes.push(home);
  return { home, lineageDbPath: join(home, "cc-lhc.sqlite") };
}

/** The pre-rewrite per-attempt table, as an installed older build left it. */
function seedLegacyAttemptRow(lineageDbPath: string, stage: string): void {
  const db = openLineageDatabase(lineageDbPath);
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
  ).run("r-1", "a-1", 1, stage, 1, "{}", "2026-08-17T00:00:00.000Z", "2026-08-17T00:00:00.000Z");
  db.close();
}

function legacyAttemptRowCount(lineageDbPath: string): number {
  const db = openLineageDatabase(lineageDbPath);
  const row = db.prepare("SELECT COUNT(*) AS n FROM cc_governor_attempts").get() as { n: number };
  db.close();
  return Number(row.n);
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("consuming pre-rewrite handoff state", () => {
  it("says nothing on a clean home", () => {
    const paths = tempHome();
    const outcome = consumeLegacyHandoffState(paths);
    expect(outcome.notices).toEqual([]);
    expect(outcome.legacyRecoveryFiles).toBe(0);
    expect(outcome.legacyAttemptRows).toBe(0);
  });

  it("consumes an input journal caught mid-delivery as possible input loss", () => {
    const paths = tempHome();
    const recovery = join(paths.home, "recovery");
    mkdirSync(recovery, { recursive: true });
    const journal = join(recovery, "input-abc.journal");
    // A journal whose last state record says `delivering`: the send ambiguity
    // the old build wedged on. Its contents are never inspected.
    writeFileSync(journal, Buffer.from([0x01, 0x00, 0x00, 0x00, 0x02, 0x03, 0x01]));

    const outcome = consumeLegacyHandoffState(paths);
    expect(outcome.legacyRecoveryFiles).toBe(1);
    expect(outcome.notices.at(-1)).toBe(TYPED_AHEAD_RESEND_NOTICE);
    expect(existsSync(journal)).toBe(false);
  });

  it("consumes a retained-input recovery artifact the same way", () => {
    const paths = tempHome();
    const recovery = join(paths.home, "recovery");
    mkdirSync(recovery, { recursive: true });
    writeFileSync(join(recovery, "handoff-1-2.json"), '{"bufferedInputBytes":9}\n');

    const outcome = consumeLegacyHandoffState(paths);
    expect(outcome.legacyRecoveryFiles).toBe(1);
    expect(outcome.notices.at(-1)).toBe(TYPED_AHEAD_RESEND_NOTICE);
  });

  it("settles an open attempt row with no journal at all", () => {
    const paths = tempHome();
    seedLegacyAttemptRow(paths.lineageDbPath, "old_child_exited");

    const outcome = consumeLegacyHandoffState(paths);
    expect(outcome.legacyAttemptRows).toBe(1);
    expect(outcome.notices.join("\n")).toContain("interrupted handoff attempt row");
    expect(outcome.notices.at(-1)).toBe(TYPED_AHEAD_RESEND_NOTICE);
    // Consumed once: a second launch has nothing left to settle.
    expect(legacyAttemptRowCount(paths.lineageDbPath)).toBe(0);
    expect(consumeLegacyHandoffState(paths).notices).toEqual([]);
  });

  it("never throws when the host-local database cannot be opened", () => {
    const paths = tempHome();
    const outcome = consumeLegacyHandoffState({
      ...paths,
      lineageDeps: {
        openDbFn: () => {
          throw new Error("cc-lhc.sqlite unreadable");
        },
      },
    });
    expect(outcome.notices).toEqual([]);
  });

  it("treats unreadable attempt bookkeeping as unclaimed and still asks for a resend", () => {
    const paths = tempHome();
    seedLegacyAttemptRow(paths.lineageDbPath, "replacement_ready");

    const outcome = consumeLegacyHandoffState({
      ...paths,
      lineageDeps: {
        // The table is there; its rows will not come back.
        openDbFn: (path: string) => {
          const real = openLineageDatabase(path);
          return new Proxy(real, {
            get(target, prop, receiver) {
              if (prop === "prepare") {
                return (sql: string) => {
                  if (sql.includes("COUNT(*)")) throw new Error("database disk image is malformed");
                  return target.prepare(sql);
                };
              }
              return Reflect.get(target, prop, receiver).bind?.(target) ?? Reflect.get(target, prop, receiver);
            },
          });
        },
      },
    });
    expect(outcome.notices.join("\n")).toContain("treated as unclaimed");
    expect(outcome.notices.at(-1)).toBe(TYPED_AHEAD_RESEND_NOTICE);
  });
});
