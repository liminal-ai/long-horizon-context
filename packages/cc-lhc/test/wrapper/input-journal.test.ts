/**
 * LIM-80 Slice 3B1: durable input-journal module.
 *
 * Binary-safe framed append log, durable header + directory fsync, ordered
 * chunks (including NUL / high bytes / newlines), and the pending -> delivering
 * -> delivered state machine recovered from the last durable STATE record.
 * `delivering` on read is the send ambiguity and is NEVER auto-replayed here
 * (3B1 only inspects; 3B2 continuation consumes it).
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createInputJournal,
  INPUT_JOURNAL_VERSION,
  type InputJournalBinding,
  type InputJournalDeps,
  readInputJournal,
  removeInputJournal,
} from "../../src/wrapper/input-journal.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cc-lhc-journal-"));
  dirs.push(dir);
  return dir;
}

const BINDING: InputJournalBinding = {
  receiptId: "r1",
  attemptId: "a1",
  oldSessionId: "old-1",
  rebuiltSessionId: "new-1",
};

describe("input journal (LIM-80 Slice 3B1)", () => {
  it("creates a durable mode-0600 header file; an empty barrier still has a durable header", () => {
    const dir = freshDir();
    const journal = createInputJournal({ dir, binding: BINDING, journalId: "jid-1" });
    expect(existsSync(journal.path)).toBe(true);
    // Windows protects this user-scoped file through ACLs and does not expose
    // meaningful POSIX creation-mode bits through stat().
    if (process.platform !== "win32") expect(statSync(journal.path).mode & 0o777).toBe(0o600);
    expect(journal.currentState()).toBe("pending");
    expect(journal.byteCount()).toBe(0);
    journal.close();

    const read = readInputJournal(journal.path, BINDING);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.header.version).toBe(INPUT_JOURNAL_VERSION);
      expect(read.header.journalId).toBe("jid-1");
      expect(read.header.receiptId).toBe("r1");
      expect(read.chunks.length).toBe(0);
      expect(read.state).toBe("pending");
    }
  });

  it("retains exact byte order across multiple chunks, including binary bytes", () => {
    const dir = freshDir();
    const journal = createInputJournal({ dir, binding: BINDING });
    const c1 = Buffer.from([0x00, 0x01, 0x02, 0xff]);
    const c2 = Buffer.from("hello\nworld", "utf8");
    const c3 = Buffer.from([0x0a, 0x00, 0x7f, 0x80, 0xfe]);
    journal.appendChunk(c1);
    journal.appendChunk(c2);
    journal.appendChunk(c3);
    expect(journal.byteCount()).toBe(c1.length + c2.length + c3.length);
    journal.close();

    const read = readInputJournal(journal.path);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.chunks.equals(Buffer.concat([c1, c2, c3]))).toBe(true);
      expect(read.state).toBe("pending");
    }
  });

  it("records the pending -> delivering -> delivered state machine durably", () => {
    const dir = freshDir();
    const journal = createInputJournal({ dir, binding: BINDING });
    journal.appendChunk(Buffer.from("x"));
    expect(journal.currentState()).toBe("pending");
    journal.markDelivering();
    expect(journal.currentState()).toBe("delivering");
    // A crash HERE is the send ambiguity: reopen shows `delivering`.
    const midRead = readInputJournal(journal.path);
    expect(midRead.ok && midRead.state).toBe("delivering");
    journal.markDelivered();
    expect(journal.currentState()).toBe("delivered");
    journal.close();

    const read = readInputJournal(journal.path);
    expect(read.ok && read.state).toBe("delivered");
    expect(read.ok && read.chunks.toString("utf8")).toBe("x");
  });

  it("a journal left `delivering` is the read-only INDETERMINATE state (never auto-replayed)", () => {
    const dir = freshDir();
    const journal = createInputJournal({ dir, binding: BINDING });
    journal.appendChunk(Buffer.from("typed but ambiguous"));
    journal.markDelivering();
    // Simulate a crash mid-send: no markDelivered, file stays on disk.
    journal.close();

    const read = readInputJournal(journal.path, BINDING);
    expect(read.ok).toBe(true);
    if (read.ok) {
      // 3B1 surfaces the ambiguity; it does not decide to replay. The bytes are
      // available for a human/3B2 to inspect, but delivery is unknown.
      expect(read.state).toBe("delivering");
      expect(read.chunks.toString("utf8")).toBe("typed but ambiguous");
    }
  });

  it("a chunk append failure is loud (throws) and stops before mutating byte count", () => {
    const dir = freshDir();
    let fail = false;
    const journal = createInputJournal({
      dir,
      binding: BINDING,
      hooks: {
        beforeAppend: (kind) => {
          if (fail && kind === "chunk") throw new Error("injected fsync failure");
        },
      },
    });
    journal.appendChunk(Buffer.from("ok"));
    expect(journal.byteCount()).toBe(2);
    fail = true;
    expect(() => journal.appendChunk(Buffer.from("lost"))).toThrow(/injected fsync failure/);
    // The failed append did not advance the durable byte count.
    expect(journal.byteCount()).toBe(2);
    journal.close();

    const read = readInputJournal(journal.path);
    expect(read.ok && read.chunks.toString("utf8")).toBe("ok");
  });

  it("readInputJournal rejects a binding mismatch (correlation failure)", () => {
    const dir = freshDir();
    const journal = createInputJournal({ dir, binding: BINDING });
    journal.close();
    const read = readInputJournal(journal.path, { ...BINDING, rebuiltSessionId: "WRONG" });
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toMatch(/binding/);
  });

  it("tolerates a torn trailing record (crash mid-append) as 'not durably present'", () => {
    const dir = freshDir();
    const journal = createInputJournal({ dir, binding: BINDING });
    journal.appendChunk(Buffer.from("durable"));
    journal.close();
    // Append a truncated frame header (type + partial length) to simulate a torn
    // write that never fsynced fully.
    appendFileSync(journal.path, Buffer.from([0x02, 0x00, 0x00]));
    const read = readInputJournal(journal.path);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.chunks.toString("utf8")).toBe("durable");
      expect(read.state).toBe("pending");
    }
  });

  // ── durability primitives (findings 1-3) ─────────────────────────────
  function realDeps(overrides: Partial<InputJournalDeps> = {}): InputJournalDeps {
    return {
      openSync: (p, f, m) => openSync(p, f, m),
      writeSync: (fd, b, o, l) => writeSync(fd, b, o, l),
      fsyncSync,
      closeSync,
      mkdirSync: (dir) => mkdirSync(dir, { recursive: true, mode: 0o700 }),
      ...overrides,
    };
  }

  it("loops until the whole frame is written even with 1-byte short writes", () => {
    const dir = freshDir();
    const journal = createInputJournal({
      dir,
      binding: BINDING,
      deps: realDeps({ writeSync: (fd, b, o, _l) => writeSync(fd, b, o, 1) }),
    });
    journal.appendChunk(Buffer.from("multi-byte chunk with \0 bytes"));
    journal.close();
    const read = readInputJournal(journal.path);
    expect(read.ok && read.chunks.toString("utf8")).toBe("multi-byte chunk with \0 bytes");
  });

  it("a zero-length (stalled) write fails creation and cleans up the incomplete file", () => {
    const dir = freshDir();
    let unlinked: string | null = null;
    expect(() =>
      createInputJournal({
        dir,
        binding: BINDING,
        journalId: "jid-zero",
        deps: realDeps({
          writeSync: () => 0,
          unlinkSync: (p) => {
            unlinked = p;
          },
        }),
      }),
    ).toThrow(/creation failed/);
    expect(unlinked).toBe(join(dir, "input-jid-zero.journal"));
  });

  it("a directory fsync failure fails creation (durability is not silently downgraded) and cleans up", () => {
    const dir = freshDir();
    let unlinked: string | null = null;
    expect(() =>
      createInputJournal({
        dir,
        binding: BINDING,
        journalId: "jid-dir",
        deps: realDeps({
          syncDir: () => {
            throw new Error("directory fsync EIO");
          },
          unlinkSync: (p) => {
            unlinked = p;
          },
        }),
      }),
    ).toThrow(/directory fsync EIO/);
    expect(unlinked).toBe(join(dir, "input-jid-dir.journal"));
  });

  it("uses file-fsync metadata durability on win32 without a POSIX directory fsync", () => {
    const dir = freshDir();
    let fsyncs = 0;
    const journal = createInputJournal({
      dir,
      binding: BINDING,
      deps: realDeps({
        platform: "win32",
        fsyncSync: (fd) => {
          fsyncs += 1;
          fsyncSync(fd);
        },
      }),
    });
    expect(fsyncs).toBeGreaterThan(0);
    journal.appendChunk(Buffer.from("windows"));
    journal.close();
    const read = readInputJournal(journal.path, BINDING);
    expect(read.ok && read.chunks.toString()).toBe("windows");
  });

  it("rejects a writer that over-reports beyond the remaining frame", () => {
    const dir = freshDir();
    expect(() =>
      createInputJournal({
        dir,
        binding: BINDING,
        deps: realDeps({ writeSync: (_fd, _b, _o, length) => length + 1 }),
      }),
    ).toThrow(/creation failed/);
  });

  // ── strict writer state machine (finding 4) ──────────────────────────
  it("writer rejects illegal transitions", () => {
    const dir = freshDir();
    const j1 = createInputJournal({ dir, binding: BINDING });
    j1.markDelivering();
    expect(() => j1.appendChunk(Buffer.from("late"))).toThrow(/appendChunk illegal in state delivering/);
    expect(() => j1.markDelivering()).toThrow(/markDelivering illegal in state delivering/);
    j1.markDelivered();
    expect(() => j1.markDelivered()).toThrow(/markDelivered illegal in state delivered/);
    expect(() => j1.appendChunk(Buffer.from("later"))).toThrow(/appendChunk illegal in state delivered/);
    j1.close();

    const j2 = createInputJournal({ dir, binding: BINDING });
    expect(() => j2.markDelivered()).toThrow(/markDelivered illegal in state pending/);
    j2.close();
  });

  it("cleanup is idempotent for an already-removed journal but propagates other unlink failures", () => {
    const dir = freshDir();
    const journal = createInputJournal({ dir, binding: BINDING });
    journal.close();
    removeInputJournal(journal.path);
    expect(() => removeInputJournal(journal.path)).not.toThrow();
    expect(() =>
      removeInputJournal(join(dir, "forced-error.journal"), {
        unlinkSync: () => {
          const error = new Error("denied") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        },
      }),
    ).toThrow(/denied/);
  });

  // ── strict reader grammar (finding 4) ────────────────────────────────
  function frameRec(type: number, payload: Buffer): Buffer {
    const head = Buffer.alloc(5);
    head.writeUInt8(type, 0);
    head.writeUInt32BE(payload.length, 1);
    return Buffer.concat([head, payload]);
  }
  const HEADER = (over: Record<string, unknown> = {}) =>
    frameRec(
      0x01,
      Buffer.from(
        JSON.stringify({
          version: INPUT_JOURNAL_VERSION,
          journalId: "jid",
          receiptId: "r1",
          attemptId: "a1",
          oldSessionId: "old-1",
          rebuiltSessionId: "new-1",
          createdAt: "2026-08-17T00:00:00.000Z",
          ...over,
        }),
      ),
    );
  const CHUNK = (s: string) => frameRec(0x02, Buffer.from(s));
  const STATE = (code: number) => frameRec(0x03, Buffer.from([code]));

  function writeRaw(parts: Buffer[]): string {
    const dir = freshDir();
    const path = join(dir, "raw.journal");
    writeFileSync(path, Buffer.concat(parts));
    return path;
  }

  it("reader enforces the append-only grammar", () => {
    // First record must be a header.
    expect(readInputJournal(writeRaw([CHUNK("x")])).ok).toBe(false);
    // Chunk after delivery began is invalid.
    expect(readInputJournal(writeRaw([HEADER(), STATE(0x01), CHUNK("late")])).ok).toBe(false);
    // Delivered before delivering is invalid.
    expect(readInputJournal(writeRaw([HEADER(), STATE(0x02)])).ok).toBe(false);
    // Any record after delivered is invalid.
    expect(readInputJournal(writeRaw([HEADER(), STATE(0x01), STATE(0x02), STATE(0x02)])).ok).toBe(false);
    // Unknown state code is invalid.
    expect(readInputJournal(writeRaw([HEADER(), STATE(0x09)])).ok).toBe(false);
    // Bad header version/shape is invalid.
    expect(readInputJournal(writeRaw([HEADER({ version: 99 })])).ok).toBe(false);
    expect(readInputJournal(writeRaw([HEADER({ receiptId: "" })])).ok).toBe(false);
    expect(readInputJournal(writeRaw([HEADER({ createdAt: "not-a-date" })])).ok).toBe(false);
    // Duplicate header is invalid.
    expect(readInputJournal(writeRaw([HEADER(), HEADER()])).ok).toBe(false);
    // A valid, ordered journal parses.
    const ok = readInputJournal(writeRaw([HEADER(), CHUNK("a"), CHUNK("b"), STATE(0x01), STATE(0x02)]));
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.chunks.toString("utf8")).toBe("ab");
      expect(ok.state).toBe("delivered");
    }
  });
});
