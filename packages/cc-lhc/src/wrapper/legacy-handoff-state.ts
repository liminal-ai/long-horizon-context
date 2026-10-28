import { closeSync, openSync, readdirSync, readFileSync, readSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { type LineageDbDeps, openLineageDatabase, threadSessionRows } from "../intake/lineage-db.js";
import { TYPED_AHEAD_RESEND_NOTICE } from "./typed-ahead-input.js";

const LEGACY_JOURNAL_FILE = /^input-.*\.journal$/;
const LEGACY_RECOVERY_JSON = /^handoff-.*\.json$/;
const LEGACY_ATTEMPTS_TABLE = "cc_governor_attempts";
const JOURNAL_HEADER_RECORD = 0x01;
const JOURNAL_HEADER_CAP_BYTES = 64 * 1024;

export interface ConsumeLegacyHandoffStateInput {
  home: string;
  lineageDbPath: string;
  threadId: string;
  knownSessionIds?: readonly string[];
  lineageDeps?: LineageDbDeps;
}

export interface LegacyHandoffStateOutcome {
  notices: string[];
  legacyRecoveryFiles: number;
  legacyAttemptRows: number;
}

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
      } catch {}
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

function ownedSessions(input: ConsumeLegacyHandoffStateInput): Set<string> {
  const owned = new Set<string>(input.knownSessionIds ?? []);
  try {
    for (const row of threadSessionRows(input.lineageDbPath, input.threadId, input.lineageDeps)) {
      if (row.accepted) owned.add(row.sessionId);
    }
  } catch {}
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
    return { found: 0, note: null };
  }

  const mine: string[] = [];
  for (const name of names) {
    const isJournal = LEGACY_JOURNAL_FILE.test(name);
    if (!isJournal && !LEGACY_RECOVERY_JSON.test(name)) continue;
    const path = join(dir, name);
    const identity = isJournal ? journalIdentity(path) : recoveryJsonIdentity(path);
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
    } catch {}
  }
  return {
    found: mine.length,
    note:
      `cc-lhc: found ${mine.length} retained-input artifact(s) from an earlier build in ${dir} ` +
      `(${cleared} cleared)`,
  };
}

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
    const mine = rows.filter((row) => attemptThreadId(row.payload_json) === input.threadId);
    if (mine.length === 0) return { found: 0, note: null };

    const remove = db.prepare(`DELETE FROM ${LEGACY_ATTEMPTS_TABLE} WHERE receipt_id = ?`);
    for (const row of mine) remove.run(row.receipt_id);
    return {
      found: mine.length,
      note: `cc-lhc: settled ${mine.length} interrupted handoff attempt row(s) from an earlier build`,
    };
  } catch {
    return { found: 0, note: null };
  } finally {
    try {
      db.close();
    } catch {}
  }
}

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
