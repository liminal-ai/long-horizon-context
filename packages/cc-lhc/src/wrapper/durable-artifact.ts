/**
 * LIM-80 Slice 3B2 (finding 10): a durable, deduplicated byte-free artifact writer.
 *
 * The path is chosen by the caller as a STABLE hash of the artifact's condition, so
 * bounded retries of the same condition converge on one file rather than flooding
 * the directory. Durability is fail-closed:
 *
 *  - Exclusive create (O_CREAT|O_EXCL, mode 0600); a full write loop; file fsync;
 *    then the platform metadata barrier (POSIX directory fsync; on Windows the file
 *    fsync maps to FlushFileBuffers, which already flushes data + metadata).
 *  - A partial create/write/fsync failure closes, UNLINKS the incomplete file, and
 *    syncs the directory removal — so a retry starts from a clean slate.
 *  - If the file already exists with IDENTICAL content, a prior attempt created it
 *    but may have died before the durability barrier: re-fsync the file AND the
 *    directory, never returning without the barrier.
 *  - If the file already exists with DIFFERING content (empty / strict-prefix partial
 *    / torn / tampered) at this content-addressed path, it is a crash-torn artifact,
 *    not a legitimate collision (the caller uses a full SHA-256 path): unlink it
 *    durably (directory sync) and retry exclusive creation exactly ONCE. Any failure
 *    of the unlink, the sync, or the second exclusive create is loud/open.
 *
 * All fs primitives are injectable so the durability contract is unit-testable.
 */
import {
  closeSync as fsCloseSync,
  existsSync as fsExistsSync,
  fsyncSync as fsFsyncSync,
  mkdirSync as fsMkdirSync,
  openSync as fsOpenSync,
  readFileSync as fsReadFileSync,
  unlinkSync as fsUnlinkSync,
  writeSync as fsWriteSync,
} from "node:fs";
import { dirname } from "node:path";

export interface DurableFsSeam {
  openSync(path: string, flags: string, mode?: number): number;
  writeSync(fd: number, buffer: Buffer, offset: number, length: number): number;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  mkdirSync(dir: string): void;
  unlinkSync(path: string): void;
  readFileSync(path: string): string;
  platform: NodeJS.Platform;
}

export function defaultDurableFsSeam(): DurableFsSeam {
  return {
    openSync: (p, f, m) => fsOpenSync(p, f, m),
    writeSync: (fd, b, o, l) => fsWriteSync(fd, b, o, l),
    fsyncSync: (fd) => fsFsyncSync(fd),
    closeSync: (fd) => fsCloseSync(fd),
    mkdirSync: (dir) => {
      fsMkdirSync(dir, { recursive: true, mode: 0o700 });
    },
    unlinkSync: (p) => fsUnlinkSync(p),
    readFileSync: (p) => (fsExistsSync(p) ? fsReadFileSync(p, "utf8") : ""),
    platform: process.platform,
  };
}

function writeFull(fd: number, buf: Buffer, seam: DurableFsSeam): void {
  let off = 0;
  while (off < buf.length) {
    const n = seam.writeSync(fd, buf, off, buf.length - off);
    if (typeof n !== "number" || n <= 0 || n > buf.length - off) throw new Error("durable artifact short write");
    off += n;
  }
}

/** POSIX directory metadata barrier; a no-op on Windows (file fsync flushed metadata). */
function syncDir(dir: string, seam: DurableFsSeam): void {
  if (seam.platform === "win32") return;
  const dfd = seam.openSync(dir, "r");
  try {
    seam.fsyncSync(dfd);
  } finally {
    seam.closeSync(dfd);
  }
}

/** Re-flush an already-created identical file's data + directory metadata. */
function resyncExisting(path: string, dir: string, seam: DurableFsSeam): void {
  // Windows FlushFileBuffers requires a writable handle. The artifact is
  // owner-writable (0600), so r+ works on every supported platform without
  // truncating or rewriting the existing bytes.
  const fd = seam.openSync(path, "r+");
  try {
    seam.fsyncSync(fd);
  } finally {
    seam.closeSync(fd);
  }
  syncDir(dir, seam);
}

export function writeDurableArtifact(
  path: string,
  content: string,
  seam: DurableFsSeam = defaultDurableFsSeam(),
): void {
  const dir = dirname(path);
  seam.mkdirSync(dir);
  let fd: number;
  try {
    fd = seam.openSync(path, "wx", 0o600);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    const existing = seam.readFileSync(path);
    if (existing === content) {
      resyncExisting(path, dir, seam); // prior create without a proven barrier: re-sync
      return;
    }
    // Crash-torn / tampered artifact at a content-addressed (full SHA-256) path:
    // remove it durably and retry exclusive creation exactly once. A failure of the
    // unlink, the directory sync, or the second exclusive create is loud/open — never
    // a silent overwrite and never a return without a proven durable file.
    seam.unlinkSync(path);
    syncDir(dir, seam);
    fd = seam.openSync(path, "wx", 0o600);
  }
  try {
    writeFull(fd, Buffer.from(content, "utf8"), seam);
    seam.fsyncSync(fd);
  } catch (cause) {
    // Partial create/write/fsync: leave nothing half-written for a future dedup to
    // mistake for a durable artifact — unlink and sync the removal, then re-throw.
    try {
      seam.closeSync(fd);
    } catch {
      // fd may already be invalid
    }
    try {
      seam.unlinkSync(path);
    } catch {
      // best effort — the retry will re-create
    }
    try {
      syncDir(dir, seam);
    } catch {
      // best effort — the removal barrier is advisory on the failure path
    }
    throw cause;
  }
  seam.closeSync(fd);
  syncDir(dir, seam);
}
