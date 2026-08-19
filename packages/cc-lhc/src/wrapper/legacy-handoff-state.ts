/**
 * Durable handoff state left behind by an installed pre-rewrite build.
 *
 * Builds before the forward-only rewrite kept two kinds of durable state about
 * an interrupted swap: per-attempt rows in `cc_governor_attempts`, and ordered
 * input journals / retained-input recovery artifacts under the recovery
 * directory. Both mechanisms are gone from the code. What can still exist is a
 * box that ran the older build, and none of it may wedge a launch.
 *
 * Both stores are shared across every thread on the box, and neither carries a
 * thread column, so consumption is scoped by identity: an attempt row through
 * `artifacts.threadId`, a journal or recovery artifact through the session ids
 * in its header matched against the sessions this thread is known to have had.
 * Only state attributable to the thread this wrapper holds the lease on is
 * touched. Everything else — another thread's, or an artifact whose identity
 * cannot be read — is left exactly as it is, and never produces a notice
 * telling this operator to resend input that was never theirs.
 *
 * For state that is ours, the answer is the one the story settled: a journal
 * caught mid-delivery, an unreadable one, an open attempt row with no journal
 * at all all mean the same thing. Input may not have been delivered, so the
 * operator is told to resend, the state is cleared, and the launch continues.
 * Nothing here inspects delivery state, decodes a chunk, or replays a byte —
 * a journal is read exactly as far as its header frame.
 */

import { closeSync, openSync, readdirSync, readFileSync, readSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { type LineageDbDeps, openLineageDatabase, threadSessionRows } from "../intake/lineage-db.js";
import { TYPED_AHEAD_RESEND_NOTICE } from "./typed-ahead-input.js";

/** Pre-rewrite artifacts under `<home>/recovery`. */
const LEGACY_JOURNAL_FILE = /^input-.*\.journal$/;
const LEGACY_RECOVERY_JSON = /^handoff-.*\.json$/;
/** Pre-rewrite per-attempt handoff bookkeeping in cc-lhc.sqlite. */
const LEGACY_ATTEMPTS_TABLE = "cc_governor_attempts";
/** First frame of a journal: `[type:1][length:4 BE][JSON header]`. */
const JOURNAL_HEADER_RECORD = 0x01;
/** A header frame longer than this is not a header this build can read. */
const JOURNAL_HEADER_CAP_BYTES = 64 * 1024;

export interface ConsumeLegacyHandoffStateInput {
  /** cc-lhc state root holding the recovery directory. */
  home: string;
  lineageDbPath: string;
  /** The thread this wrapper holds the lease on. Only its state is consumed. */
  threadId: string;
  /** Sessions known to be this thread's beyond what host lineage records. */
  knownSessionIds?: readonly string[];
  lineageDeps?: LineageDbDeps;
}

export interface LegacyHandoffStateOutcome {
  /** Lines for the terminal, the wrapper log and the panel. Empty when clean. */
  notices: string[];
  /** Artifacts and rows attributed to this thread and consumed. */
  legacyRecoveryFiles: number;
  legacyAttemptRows: number;
}

/** The session identities a legacy artifact carries in its header. */
interface ArtifactIdentity {
  oldSessionId?: string;
  rebuiltSessionId?: string;
}

function identityOf(value: unknown): ArtifactIdentity | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const identity: ArtifactIdentity = {};
  if (typeof record.oldSessionId === "string" && record.oldSessionId !== "") {
    identity.oldSessionId = record.oldSessionId;
  }
  if (typeof record.rebuiltSessionId === "string" && record.rebuiltSessionId !== "") {
    identity.rebuiltSessionId = record.rebuiltSessionId;
  }
  return identity.oldSessionId === undefined && identity.rebuiltSessionId === undefined ? null : identity;
}

/**
 * The header frame of a legacy input journal, and nothing else. Chunk and state
 * records are never read: what was typed, and whether it was delivered, are not
 * this launch's business.
 */
function journalIdentity(path: string): ArtifactIdentity | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const frame = Buffer.alloc(5);
    if (readSync(fd, frame, 0, 5, 0) !== 5) return null;
    if (frame.readUInt8(0) !== JOURNAL_HEADER_RECORD) return null;
    const length = frame.readUInt32BE(1);
    if (length <= 0 || length > JOURNAL_HEADER_CAP_BYTES) return null;
    const header = Buffer.alloc(length);
    if (readSync(fd, header, 0, length, 5) !== length) return null;
    return identityOf(JSON.parse(header.toString("utf8")));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // best effort
      }
    }
  }
}

function recoveryJsonIdentity(path: string): ArtifactIdentity | null {
  try {
    return identityOf(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

/** Every native session this thread is known to have held. */
function ownedSessions(input: ConsumeLegacyHandoffStateInput): Set<string> {
  const owned = new Set<string>(input.knownSessionIds ?? []);
  try {
    for (const row of threadSessionRows(input.lineageDbPath, input.threadId, input.lineageDeps)) {
      owned.add(row.sessionId);
    }
  } catch {
    // Host-local lineage that cannot be read narrows what this launch can
    // claim; it never widens it, and it never holds the launch up.
  }
  owned.delete("");
  return owned;
}

function consumeRecoveryFiles(
  input: ConsumeLegacyHandoffStateInput,
  owned: Set<string>,
): { found: number; note: string | null } {
  const dir = join(input.home, "recovery");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // No directory, or it cannot be listed. Either way there is nothing this
    // launch must act on, and an unreadable directory never holds it up.
    return { found: 0, note: null };
  }

  const mine: string[] = [];
  for (const name of names) {
    const isJournal = LEGACY_JOURNAL_FILE.test(name);
    if (!isJournal && !LEGACY_RECOVERY_JSON.test(name)) continue;
    const path = join(dir, name);
    const identity = isJournal ? journalIdentity(path) : recoveryJsonIdentity(path);
    // No readable identity means no claim: another thread's wrapper, live or
    // dead, may still be the only party that can say what it was.
    if (identity === null) continue;
    const claimed =
      (identity.oldSessionId !== undefined && owned.has(identity.oldSessionId)) ||
      (identity.rebuiltSessionId !== undefined && owned.has(identity.rebuiltSessionId));
    if (claimed) mine.push(path);
  }
  if (mine.length === 0) return { found: 0, note: null };

  let cleared = 0;
  for (const path of mine) {
    try {
      unlinkSync(path);
      cleared += 1;
    } catch {
      // A file that will not delete is still consumed: it has no reader left.
    }
  }
  return {
    found: mine.length,
    note:
      `cc-lhc: found ${mine.length} retained-input artifact(s) from an earlier build in ${dir} ` +
      `(${cleared} cleared)`,
  };
}

/** The thread an attempt row belongs to, or null when it does not say. */
function attemptThreadId(payloadJson: unknown): string | null {
  if (typeof payloadJson !== "string") return null;
  try {
    const parsed = JSON.parse(payloadJson) as { artifacts?: { threadId?: unknown } };
    const threadId = parsed.artifacts?.threadId;
    return typeof threadId === "string" && threadId !== "" ? threadId : null;
  } catch {
    return null;
  }
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

    const rows = db.prepare(`SELECT receipt_id, payload_json FROM ${LEGACY_ATTEMPTS_TABLE}`).all() as Array<{
      receipt_id: string;
      payload_json: unknown;
    }>;
    // A row whose payload does not name this thread is not this thread's to
    // settle — including a row that names no thread at all.
    const mine = rows.filter((row) => attemptThreadId(row.payload_json) === input.threadId);
    if (mine.length === 0) return { found: 0, note: null };

    const remove = db.prepare(`DELETE FROM ${LEGACY_ATTEMPTS_TABLE} WHERE receipt_id = ?`);
    for (const row of mine) remove.run(row.receipt_id);
    return {
      found: mine.length,
      note: `cc-lhc: settled ${mine.length} interrupted handoff attempt row(s) from an earlier build`,
    };
  } catch {
    // Bookkeeping this launch cannot read is bookkeeping it cannot attribute,
    // so it stays where it is. The durable facts a launch actually needs are
    // the registry pointer and the files on disk, never this table.
    return { found: 0, note: null };
  } finally {
    try {
      db.close();
    } catch {
      // best effort
    }
  }
}

/**
 * Consume the pre-rewrite handoff state belonging to the thread this wrapper
 * owns. Must be called only after the thread lease is held: the stores are
 * shared, and the lease is the sole authority over a thread's state.
 */
export function consumeLegacyHandoffState(input: ConsumeLegacyHandoffStateInput): LegacyHandoffStateOutcome {
  const owned = ownedSessions(input);
  const files = consumeRecoveryFiles(input, owned);
  const rows = consumeAttemptRows(input);
  const notices: string[] = [];
  if (files.note !== null) notices.push(files.note);
  if (rows.note !== null) notices.push(rows.note);
  if (notices.length > 0) notices.push(TYPED_AHEAD_RESEND_NOTICE);
  return { notices, legacyRecoveryFiles: files.found, legacyAttemptRows: rows.found };
}
