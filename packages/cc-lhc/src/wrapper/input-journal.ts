/**
 * LIM-80 Slice 3B1: durable post-commit input journal.
 *
 * When an automatic handoff commits, the ordered post-commit stdin bytes must
 * survive a crash so a later process can reason about what the operator typed
 * and whether it was delivered. This journal is a mode-0600, append-only,
 * binary-safe framed log in the recovery directory, bound to the exact
 * receiptId + attemptId + oldSessionId + rebuiltSessionId.
 *
 * Durability contract (per platform):
 *  - linux / darwin: the header is written with a loop-until-complete write, the
 *    FILE is fsynced, and the DIRECTORY is fsynced (open O_RDONLY + fsync). Any
 *    of those failing FAILS creation (the incomplete file is closed + unlinked +
 *    the directory removal synced). "Header+directory durable" is only claimed
 *    when the directory fsync succeeded.
 *  - win32: file fsync maps to FlushFileBuffers, which flushes file data and
 *    metadata. That file-metadata barrier replaces the POSIX directory fsync.
 *  - Every accepted stdin chunk is appended (loop-until-complete) and fsynced
 *    BEFORE it exists only in memory or can be acknowledged as buffered.
 *  - Delivery is an append-only state machine recorded IN the journal (never
 *    overwriting SQLite): pending -> delivering (fsynced BEFORE any byte reaches a
 *    child) -> delivered (fsynced after the child write returns). A journal read
 *    as `delivering` is the send ambiguity and must NEVER auto-replay bytes.
 *
 * Bytes never appear in receipt/attempt SQLite payloads or in logs; only the
 * journal path/id and delivery state metadata are surfaced elsewhere.
 */

import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

export const INPUT_JOURNAL_VERSION = 1;

/** Delivery state, recovered from the last STATE record (pending if none). */
export type JournalDeliveryState = "pending" | "delivering" | "delivered";

/** Identity a journal is bound to; a mismatch on read is a correlation failure. */
export interface InputJournalBinding {
  receiptId: string;
  attemptId: string;
  oldSessionId: string;
  rebuiltSessionId: string;
}

export interface InputJournalHeader extends InputJournalBinding {
  version: number;
  journalId: string;
  createdAt: string;
}

// Record framing: [type:1][length:4 BE][payload:length].
const REC_HEADER = 0x01;
const REC_CHUNK = 0x02;
const REC_STATE = 0x03;
const STATE_DELIVERING = 0x01;
const STATE_DELIVERED = 0x02;

export interface InputJournalHooks {
  /** Test seam: called before each durable append; throw to simulate I/O failure. */
  beforeAppend?: (kind: "chunk" | "state") => void;
}

/**
 * Injectable fs/platform primitives (defaults from node:fs). `writeSync` may
 * legitimately do a short write; the journal loops until the whole frame lands.
 * `syncDir` is the platform-correct post-file metadata barrier. Linux/macOS use
 * directory fsync; Windows uses a no-op because file fsync already flushed metadata.
 */
export interface InputJournalDeps {
  openSync?: (path: string, flags: string, mode?: number) => number;
  writeSync?: (fd: number, buffer: Buffer, offset: number, length: number) => number;
  fsyncSync?: (fd: number) => void;
  closeSync?: (fd: number) => void;
  mkdirSync?: (dir: string) => void;
  unlinkSync?: (path: string) => void;
  /** Platform metadata barrier after file fsync (throws on failure). */
  syncDir?: ((dir: string) => void) | null;
  platform?: NodeJS.Platform;
}

interface ResolvedDeps {
  openSync: (path: string, flags: string, mode?: number) => number;
  writeSync: (fd: number, buffer: Buffer, offset: number, length: number) => number;
  fsyncSync: (fd: number) => void;
  closeSync: (fd: number) => void;
  mkdirSync: (dir: string) => void;
  unlinkSync: (path: string) => void;
  syncDir: ((dir: string) => void) | null;
  platform: NodeJS.Platform;
}

function resolveDeps(deps: InputJournalDeps): ResolvedDeps {
  const platform = deps.platform ?? process.platform;
  const openFn = deps.openSync ?? ((p, f, m) => openSync(p, f, m));
  const fsyncFn = deps.fsyncSync ?? fsyncSync;
  const closeFn = deps.closeSync ?? closeSync;
  // Durability is platform-specific. Linux/macOS fsync the containing
  // directory after the file fsync. On Windows, fsyncSync on the file maps to
  // FlushFileBuffers, which flushes file data and metadata; there is no separate
  // POSIX directory-fsync step, so the metadata barrier is already complete.
  const defaultSyncDir =
    platform === "win32"
      ? (_dir: string): void => {}
      : (dir: string): void => {
          const dfd = openFn(dir, "r");
          try {
            fsyncFn(dfd);
          } finally {
            closeFn(dfd);
          }
        };
  return {
    openSync: openFn,
    writeSync: deps.writeSync ?? ((fd, b, o, l) => writeSync(fd, b, o, l)),
    fsyncSync: fsyncFn,
    closeSync: closeFn,
    mkdirSync: deps.mkdirSync ?? ((dir) => mkdirSync(dir, { recursive: true, mode: 0o700 })),
    unlinkSync: deps.unlinkSync ?? unlinkSync,
    syncDir: deps.syncDir === undefined ? defaultSyncDir : deps.syncDir,
    platform,
  };
}

export interface InputJournal {
  readonly path: string;
  readonly journalId: string;
  /** Durably append one ordered input chunk (loop-write + fsync). Only while pending. */
  appendChunk(bytes: Buffer): void;
  /** Atomic durable transition pending -> delivering (fsynced) BEFORE writing to a child. */
  markDelivering(): void;
  /** Durable transition delivering -> delivered (fsynced) AFTER the child write returns. */
  markDelivered(): void;
  /** Current delivery state (in-memory mirror of the last durable STATE record). */
  currentState(): JournalDeliveryState;
  /** Total input bytes durably appended so far (metadata; never the bytes). */
  byteCount(): number;
  /** Close the file descriptor. Does NOT delete the file. */
  close(): void;
}

function frame(type: number, payload: Buffer): Buffer {
  const head = Buffer.allocUnsafe(5);
  head.writeUInt8(type, 0);
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

/**
 * Create a fresh durable journal for one handoff. Fails closed on any missing
 * platform barrier and on ANY header/file/metadata durability failure (the
 * incomplete file is closed + unlinked + the directory removal synced, and the
 * original error is preserved). The header is fsynced, then the directory is
 * fsynced, before returning — so an empty barrier already has a durable file.
 */
export function createInputJournal(args: {
  dir: string;
  binding: InputJournalBinding;
  journalId?: string;
  now?: () => Date;
  hooks?: InputJournalHooks;
  deps?: InputJournalDeps;
}): InputJournal {
  const d = resolveDeps(args.deps ?? {});
  // A null test seam explicitly means unsupported. Production supplies a
  // platform-correct barrier on every supported platform.
  if (d.syncDir === null) throw new Error(`input journal: durability barrier unavailable on ${d.platform}`);
  const syncDir = d.syncDir;

  const journalId = args.journalId ?? randomUUID();
  const now = args.now ?? (() => new Date());
  const hooks = args.hooks;
  d.mkdirSync(args.dir);
  const path = join(args.dir, `input-${journalId}.journal`);
  // O_CREAT|O_EXCL|O_WRONLY, mode 0600. A collision is a real defect (throws).
  const fd = d.openSync(path, "wx", 0o600);

  // Loop until the whole frame is durable; a zero/short write is a failure, never
  // a silently-partial frame.
  const writeFull = (buf: Buffer): void => {
    let off = 0;
    while (off < buf.length) {
      const n = d.writeSync(fd, buf, off, buf.length - off);
      if (typeof n !== "number" || n <= 0 || n > buf.length - off) {
        throw new Error(`input journal write stalled: wrote ${String(n)} at offset ${off}/${buf.length}`);
      }
      off += n;
    }
  };
  const writeRecord = (rec: Buffer): void => {
    writeFull(rec);
    d.fsyncSync(fd);
  };

  // Any failure during creation must not leak the fd/file: close, unlink, and
  // sync the removal (best-effort), then rethrow the ORIGINAL error with cleanup
  // diagnostics appended (never hidden).
  const failCreation = (cause: unknown): never => {
    const notes: string[] = [];
    try {
      d.closeSync(fd);
    } catch (e) {
      notes.push(`close: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      d.unlinkSync(path);
    } catch (e) {
      notes.push(`unlink: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      syncDir(args.dir);
    } catch (e) {
      notes.push(`dir-sync: ${e instanceof Error ? e.message : String(e)}`);
    }
    const original = cause instanceof Error ? cause.message : String(cause);
    const suffix = notes.length > 0 ? ` [cleanup: ${notes.join("; ")}]` : "";
    throw new Error(`input journal creation failed: ${original}${suffix}`, { cause });
  };

  const header: InputJournalHeader = {
    version: INPUT_JOURNAL_VERSION,
    journalId,
    receiptId: args.binding.receiptId,
    attemptId: args.binding.attemptId,
    oldSessionId: args.binding.oldSessionId,
    rebuiltSessionId: args.binding.rebuiltSessionId,
    createdAt: now().toISOString(),
  };
  try {
    writeRecord(frame(REC_HEADER, Buffer.from(JSON.stringify(header), "utf8")));
    syncDir(args.dir);
  } catch (cause) {
    return failCreation(cause);
  }

  let closed = false;
  let bytes = 0;
  let state: JournalDeliveryState = "pending";
  const ensureOpen = (): void => {
    if (closed) throw new Error("input journal is closed");
  };

  return {
    path,
    journalId,
    appendChunk(chunk: Buffer): void {
      ensureOpen();
      if (state !== "pending") throw new Error(`input journal: appendChunk illegal in state ${state}`);
      hooks?.beforeAppend?.("chunk");
      writeRecord(frame(REC_CHUNK, Buffer.from(chunk)));
      bytes += chunk.length;
    },
    markDelivering(): void {
      ensureOpen();
      if (state !== "pending") throw new Error(`input journal: markDelivering illegal in state ${state}`);
      hooks?.beforeAppend?.("state");
      writeRecord(frame(REC_STATE, Buffer.from([STATE_DELIVERING])));
      state = "delivering";
    },
    markDelivered(): void {
      ensureOpen();
      if (state !== "delivering") throw new Error(`input journal: markDelivered illegal in state ${state}`);
      hooks?.beforeAppend?.("state");
      writeRecord(frame(REC_STATE, Buffer.from([STATE_DELIVERED])));
      state = "delivered";
    },
    currentState: () => state,
    byteCount: () => bytes,
    close(): void {
      if (closed) return;
      closed = true;
      try {
        d.closeSync(fd);
      } catch {
        // already closed by the OS
      }
    },
  };
}

/**
 * Unlink a journal and durably sync its directory removal where supported
 * (LIM-80 3B1). Best-effort: a missing file / unsupported dir-sync is not fatal.
 */
export function removeInputJournal(path: string, deps: InputJournalDeps = {}): void {
  const d = resolveDeps(deps);
  try {
    d.unlinkSync(path);
  } catch (cause) {
    // Best-effort missing-file contract: a journal already removed by generic
    // handoff journal settlement (idempotent cleanup) is not an error. Anything
    // other than ENOENT is a real failure and propagates to the caller.
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    return; // already gone — its directory entry no longer needs a removal sync
  }
  if (d.syncDir !== null) {
    try {
      d.syncDir(path.slice(0, path.lastIndexOf("/")) || "/");
    } catch {
      // directory-removal sync is best-effort on cleanup
    }
  }
}

/** Restart delivery handle: the SAME strict pending -> delivering -> delivered protocol. */
export interface DeliveryHandle {
  /** Ordered bytes to deliver EXACTLY ONCE (never logged, never in SQLite). */
  readonly chunks: Buffer;
  /** Durable pending -> delivering, fsynced BEFORE any byte reaches the child. */
  markDelivering(): void;
  /** Durable delivering -> delivered, fsynced AFTER the child write returns. */
  markDelivered(): void;
  currentState(): JournalDeliveryState;
  close(): void;
}

/**
 * Reopen an EXISTING pending journal on restart to deliver its buffered bytes to
 * a proven-live child, using the identical durable state machine (LIM-80 3B2). A
 * non-pending, mismatched, or unreadable journal is refused — the caller keeps
 * the attempt open. Never creates a new journal, never appends chunks.
 */
export function reopenInputJournalForDelivery(
  path: string,
  binding: InputJournalBinding,
  deps: InputJournalDeps = {},
): { ok: true; handle: DeliveryHandle } | { ok: false; reason: string } {
  const read = readInputJournal(path, binding);
  if (!read.ok) return { ok: false, reason: read.reason };
  if (read.state !== "pending") {
    return { ok: false, reason: `journal state is ${read.state}; delivery may only begin from pending` };
  }
  const d = resolveDeps(deps);
  if (d.syncDir === null) return { ok: false, reason: `durability barrier unavailable on ${d.platform}` };
  let fd: number;
  try {
    fd = d.openSync(path, "a"); // append; the journal keeps its append-only grammar
  } catch (cause) {
    return { ok: false, reason: `cannot reopen journal: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  let state: JournalDeliveryState = "pending";
  let closed = false;
  const writeState = (code: number): void => {
    const rec = frame(REC_STATE, Buffer.from([code]));
    let off = 0;
    while (off < rec.length) {
      const n = d.writeSync(fd, rec, off, rec.length - off);
      if (typeof n !== "number" || n <= 0 || n > rec.length - off) {
        throw new Error(`journal delivery write stalled: wrote ${String(n)} at ${off}/${rec.length}`);
      }
      off += n;
    }
    d.fsyncSync(fd);
  };
  return {
    ok: true,
    handle: {
      chunks: read.chunks,
      markDelivering(): void {
        if (closed) throw new Error("delivery handle closed");
        if (state !== "pending") throw new Error(`markDelivering illegal in state ${state}`);
        writeState(STATE_DELIVERING);
        state = "delivering";
      },
      markDelivered(): void {
        if (closed) throw new Error("delivery handle closed");
        if (state !== "delivering") throw new Error(`markDelivered illegal in state ${state}`);
        writeState(STATE_DELIVERED);
        state = "delivered";
      },
      currentState: () => state,
      close(): void {
        if (closed) return;
        closed = true;
        try {
          d.closeSync(fd);
        } catch {
          // already closed
        }
      },
    },
  };
}

export type InputJournalReadResult =
  | {
      ok: true;
      header: InputJournalHeader;
      /** Concatenated CHUNK payloads in exact append order. */
      chunks: Buffer;
      state: JournalDeliveryState;
    }
  | { ok: false; reason: string };

function validateHeader(raw: unknown): InputJournalHeader | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.version !== INPUT_JOURNAL_VERSION) return null;
  for (const k of ["journalId", "receiptId", "attemptId", "oldSessionId", "rebuiltSessionId", "createdAt"] as const) {
    if (typeof o[k] !== "string" || o[k] === "") return null;
  }
  if (Number.isNaN(Date.parse(o.createdAt as string))) return null;
  return {
    version: o.version,
    journalId: o.journalId as string,
    receiptId: o.receiptId as string,
    attemptId: o.attemptId as string,
    oldSessionId: o.oldSessionId as string,
    rebuiltSessionId: o.rebuiltSessionId as string,
    createdAt: o.createdAt as string,
  };
}

/**
 * Read-only strict inspection of a journal on disk (restart / recovery-artifact
 * use; 3B2 continuation consumes this — 3B1 only inspects). Enforces the exact
 * append-only grammar: HEADER first and once; CHUNK only while pending; one
 * pending->delivering; one delivering->delivered; nothing after delivered.
 * A truncated TRAILING record (torn write at EOF) is tolerated as an absent final
 * record; any internal corruption is invalid.
 */
export function readInputJournal(path: string, binding?: InputJournalBinding): InputJournalReadResult {
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch (cause) {
    return { ok: false, reason: `unreadable: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  let offset = 0;
  let header: InputJournalHeader | null = null;
  const chunks: Buffer[] = [];
  let state: JournalDeliveryState = "pending";
  let recordIndex = 0;
  while (offset < buf.length) {
    if (offset + 5 > buf.length) break; // torn trailing frame header
    const type = buf.readUInt8(offset);
    const len = buf.readUInt32BE(offset + 1);
    const start = offset + 5;
    const end = start + len;
    if (end > buf.length) break; // torn trailing record payload (absent final)
    const payload = buf.subarray(start, end);

    if (recordIndex === 0) {
      if (type !== REC_HEADER) return { ok: false, reason: "first record is not a header" };
    }
    if (state === "delivered") return { ok: false, reason: "record after delivered" };

    if (type === REC_HEADER) {
      if (header !== null) return { ok: false, reason: "duplicate header record" };
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload.toString("utf8"));
      } catch {
        return { ok: false, reason: "header is not valid JSON" };
      }
      const validated = validateHeader(parsed);
      if (validated === null) return { ok: false, reason: "header shape/version/ids/timestamp invalid" };
      header = validated;
    } else if (type === REC_CHUNK) {
      if (state !== "pending") return { ok: false, reason: "chunk after delivery began" };
      chunks.push(Buffer.from(payload));
    } else if (type === REC_STATE) {
      if (len !== 1) return { ok: false, reason: "malformed state record" };
      const code = payload.readUInt8(0);
      if (code === STATE_DELIVERING) {
        if (state !== "pending") return { ok: false, reason: "delivering out of order" };
        state = "delivering";
      } else if (code === STATE_DELIVERED) {
        if (state !== "delivering") return { ok: false, reason: "delivered before delivering" };
        state = "delivered";
      } else {
        return { ok: false, reason: `unknown state code ${code}` };
      }
    } else {
      return { ok: false, reason: `unknown record type ${type}` };
    }
    offset = end;
    recordIndex += 1;
  }
  if (header === null) return { ok: false, reason: "no header record" };
  if (
    binding !== undefined &&
    (header.receiptId !== binding.receiptId ||
      header.attemptId !== binding.attemptId ||
      header.oldSessionId !== binding.oldSessionId ||
      header.rebuiltSessionId !== binding.rebuiltSessionId)
  ) {
    return { ok: false, reason: "journal binding does not match the expected identities" };
  }
  return { ok: true, header, chunks: Buffer.concat(chunks), state };
}
