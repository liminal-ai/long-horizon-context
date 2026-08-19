/**
 * Durable handoff state left behind by an installed pre-rewrite build.
 *
 * Builds before the forward-only rewrite kept two kinds of durable state about
 * an interrupted swap: per-attempt rows in `cc_governor_attempts`, and ordered
 * input journals / retained-input recovery artifacts under the recovery
 * directory. Both mechanisms are gone from the code. What can still exist is a
 * box that ran the older build, and none of it may wedge a launch.
 *
 * Consumption is one-way and unconditional. Whatever is found — a journal
 * caught mid-delivery, an unreadable one, an open attempt row with no journal
 * at all — resolves to the same fact: input may not have been delivered. The
 * operator is told to resend, the state is cleared, and the launch continues
 * forward on the thread's current session. Nothing here inspects delivery
 * state, decides anything, or replays a byte.
 */

import { readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { type LineageDbDeps, openLineageDatabase } from "../intake/lineage-db.js";
import { TYPED_AHEAD_RESEND_NOTICE } from "./typed-ahead-input.js";

/** Pre-rewrite artifacts under `<home>/recovery`. */
const LEGACY_RECOVERY_FILE = /^(input-.*\.journal|handoff-.*\.json)$/;
/** Pre-rewrite per-attempt handoff bookkeeping in cc-lhc.sqlite. */
const LEGACY_ATTEMPTS_TABLE = "cc_governor_attempts";

export interface ConsumeLegacyHandoffStateInput {
  /** cc-lhc state root holding the recovery directory. */
  home: string;
  lineageDbPath: string;
  lineageDeps?: LineageDbDeps;
}

export interface LegacyHandoffStateOutcome {
  /** Lines for the terminal, the wrapper log and the panel. Empty when clean. */
  notices: string[];
  legacyRecoveryFiles: number;
  legacyAttemptRows: number;
}

function consumeRecoveryFiles(home: string): { found: number; note: string | null } {
  const dir = join(home, "recovery");
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => LEGACY_RECOVERY_FILE.test(name));
  } catch {
    // No directory, or it cannot be listed. Either way there is nothing this
    // launch must act on, and an unreadable directory never holds it up.
    return { found: 0, note: null };
  }
  if (names.length === 0) return { found: 0, note: null };
  let cleared = 0;
  for (const name of names) {
    try {
      unlinkSync(join(dir, name));
      cleared += 1;
    } catch {
      // A file that will not delete is still consumed: it has no reader left.
    }
  }
  return {
    found: names.length,
    note:
      `cc-lhc: found ${names.length} retained-input artifact(s) from an earlier build in ${dir} ` +
      `(${cleared} cleared)`,
  };
}

function consumeAttemptRows(input: ConsumeLegacyHandoffStateInput): { found: number; note: string | null } {
  let db: DatabaseSync;
  try {
    db = openLineageDatabase(input.lineageDbPath, input.lineageDeps ?? {});
  } catch {
    return { found: 0, note: null };
  }
  try {
    const present = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(LEGACY_ATTEMPTS_TABLE) as { name: string } | undefined;
    if (present === undefined) return { found: 0, note: null };
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${LEGACY_ATTEMPTS_TABLE}`).get() as { n: number } | undefined;
    const found = Number(row?.n ?? 0);
    if (found === 0) return { found: 0, note: null };
    db.prepare(`DELETE FROM ${LEGACY_ATTEMPTS_TABLE}`).run();
    return {
      found,
      note: `cc-lhc: settled ${found} interrupted handoff attempt row(s) from an earlier build`,
    };
  } catch (cause) {
    // A corrupt or unreadable row is treated as unclaimed work, exactly like a
    // missing one: the durable facts a launch actually needs are the registry
    // pointer and the files on disk, never this bookkeeping.
    return {
      found: 1,
      note:
        "cc-lhc: interrupted handoff bookkeeping from an earlier build could not be read " +
        `(${cause instanceof Error ? cause.message : String(cause)}); treated as unclaimed`,
    };
  } finally {
    try {
      db.close();
    } catch {
      // best effort
    }
  }
}

export function consumeLegacyHandoffState(input: ConsumeLegacyHandoffStateInput): LegacyHandoffStateOutcome {
  const files = consumeRecoveryFiles(input.home);
  const rows = consumeAttemptRows(input);
  const notices: string[] = [];
  if (files.note !== null) notices.push(files.note);
  if (rows.note !== null) notices.push(rows.note);
  if (notices.length > 0) notices.push(TYPED_AHEAD_RESEND_NOTICE);
  return { notices, legacyRecoveryFiles: files.found, legacyAttemptRows: rows.found };
}
