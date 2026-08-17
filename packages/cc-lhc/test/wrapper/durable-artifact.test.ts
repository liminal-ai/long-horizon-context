/**
 * LIM-80 Slice 3B2 (finding 10): the durable, deduplicated artifact writer's
 * durability contract, exercised through an injected fs seam — full write loop +
 * file fsync + directory metadata barrier; partial-failure unlink + directory sync;
 * EEXIST identical re-sync (recovering a prior directory-fsync failure); and a
 * differing-content collision surfaced to the caller.
 */
import { describe, expect, it } from "vitest";

import { type DurableFsSeam, writeDurableArtifact } from "../../src/wrapper/durable-artifact.js";

interface Op {
  op: string;
  path: string;
}

class FakeSeam implements DurableFsSeam {
  files = new Map<string, string>();
  dirs = new Set<string>();
  private fds = new Map<number, { path: string; buf: string }>();
  private nextFd = 10;
  log: Op[] = [];
  platform: NodeJS.Platform = "linux";
  failWrite = false;
  failFileFsync = false;
  failDirFsync = false;
  failUnlink = false;
  failSecondCreate = false;
  private wxCount = 0;

  mkdirSync(dir: string): void {
    this.dirs.add(dir);
    this.log.push({ op: "mkdir", path: dir });
  }
  openSync(path: string, flags: string): number {
    if (flags === "wx") {
      this.wxCount += 1;
      if (this.failSecondCreate && this.wxCount === 2) {
        // A concurrent creator won the race for the freed path.
        const e = new Error("EEXIST") as NodeJS.ErrnoException;
        e.code = "EEXIST";
        throw e;
      }
      if (this.files.has(path)) {
        const e = new Error("EEXIST") as NodeJS.ErrnoException;
        e.code = "EEXIST";
        throw e;
      }
      this.files.set(path, "");
    }
    const fd = this.nextFd++;
    this.fds.set(fd, { path, buf: this.files.get(path) ?? "" });
    this.log.push({ op: `open:${flags}`, path });
    return fd;
  }
  writeSync(fd: number, buffer: Buffer, offset: number, length: number): number {
    if (this.failWrite) throw new Error("simulated write failure");
    const f = this.fds.get(fd);
    if (f === undefined) throw new Error("bad fd");
    f.buf += buffer.subarray(offset, offset + length).toString("utf8");
    this.files.set(f.path, f.buf);
    return length;
  }
  fsyncSync(fd: number): void {
    const f = this.fds.get(fd);
    if (f === undefined) throw new Error("bad fd");
    if (this.dirs.has(f.path)) {
      this.log.push({ op: "fsync-dir", path: f.path });
      if (this.failDirFsync) throw new Error("simulated dir fsync failure");
      return;
    }
    this.log.push({ op: "fsync-file", path: f.path });
    if (this.failFileFsync) throw new Error("simulated file fsync failure");
  }
  closeSync(fd: number): void {
    this.fds.delete(fd);
  }
  unlinkSync(path: string): void {
    if (this.failUnlink) throw new Error("simulated unlink failure");
    this.files.delete(path);
    this.log.push({ op: "unlink", path });
  }
  readFileSync(path: string): string {
    return this.files.get(path) ?? "";
  }
  count(op: string): number {
    return this.log.filter((o) => o.op === op).length;
  }
}

const PATH = "/rec/restart-r1-abc.json";

describe("writeDurableArtifact (LIM-80 3B2 finding 10)", () => {
  it("writes, fsyncs the file, then fsyncs the directory (metadata barrier)", () => {
    const s = new FakeSeam();
    writeDurableArtifact(PATH, "hello", s);
    expect(s.files.get(PATH)).toBe("hello");
    // File fsync precedes the directory fsync.
    const fileI = s.log.findIndex((o) => o.op === "fsync-file");
    const dirI = s.log.findIndex((o) => o.op === "fsync-dir");
    expect(fileI).toBeGreaterThanOrEqual(0);
    expect(dirI).toBeGreaterThan(fileI);
  });

  it("partial write → unlinks the incomplete file and syncs the directory removal, then re-throws; a retry recovers", () => {
    const s = new FakeSeam();
    s.failWrite = true;
    expect(() => writeDurableArtifact(PATH, "hello", s)).toThrow(/write failure/);
    // The incomplete file was removed and the removal was directory-synced.
    expect(s.files.has(PATH)).toBe(false);
    expect(s.count("unlink")).toBe(1);
    expect(s.count("fsync-dir")).toBe(1);
    // A retry with a healthy seam recovers cleanly.
    s.failWrite = false;
    writeDurableArtifact(PATH, "hello", s);
    expect(s.files.get(PATH)).toBe("hello");
  });

  it("EEXIST with identical content → re-fsyncs the file AND directory (recovers a prior dir-fsync failure), no re-write", () => {
    const s = new FakeSeam();
    // First attempt writes the file but the directory barrier fails (file is durable).
    s.failDirFsync = true;
    expect(() => writeDurableArtifact(PATH, "hello", s)).toThrow(/dir fsync failure/);
    expect(s.files.get(PATH)).toBe("hello"); // left on disk, not unlinked
    // Second attempt: identical file exists → resync path re-fsyncs file + dir.
    s.failDirFsync = false;
    s.log = [];
    writeDurableArtifact(PATH, "hello", s);
    expect(s.count("fsync-file")).toBe(1); // re-fsynced the existing file
    expect(s.count("fsync-dir")).toBe(1); // and the directory barrier
    // The resync opens the existing file read/write for Windows
    // FlushFileBuffers compatibility, without truncating or rewriting it.
    expect(s.log.some((o) => o.op === "open:r+")).toBe(true);
    expect(s.log.some((o) => o.op === "open:wx")).toBe(false); // create hit EEXIST before logging
  });

  it("EEXIST with a preexisting EMPTY file (crash-torn) → unlink durably + re-create exclusively + write", () => {
    const s = new FakeSeam();
    s.files.set(PATH, ""); // a torn artifact: created but never written
    writeDurableArtifact(PATH, "hello", s);
    expect(s.files.get(PATH)).toBe("hello");
    expect(s.count("unlink")).toBe(1);
    expect(s.count("open:wx")).toBe(1); // the successful second exclusive create (first hit EEXIST)
    // The unlink is directory-synced before the retry create.
    const unlinkI = s.log.findIndex((o) => o.op === "unlink");
    const dirAfterUnlink = s.log.findIndex((o, i) => i > unlinkI && o.op === "fsync-dir");
    expect(dirAfterUnlink).toBeGreaterThan(unlinkI);
  });

  it("EEXIST with a strict-prefix PARTIAL file (crash-torn) → unlink + re-create + write the full content", () => {
    const s = new FakeSeam();
    s.files.set(PATH, "hel"); // a strict prefix of the intended "hello"
    writeDurableArtifact(PATH, "hello", s);
    expect(s.files.get(PATH)).toBe("hello");
    expect(s.count("unlink")).toBe(1);
  });

  it("torn artifact + unlink failure → loud/open (never a silent overwrite)", () => {
    const s = new FakeSeam();
    s.files.set(PATH, "torn");
    s.failUnlink = true;
    expect(() => writeDurableArtifact(PATH, "hello", s)).toThrow(/unlink failure/);
    expect(s.files.get(PATH)).toBe("torn"); // untouched
  });

  it("torn artifact + a lost race on the second exclusive create → loud/open", () => {
    const s = new FakeSeam();
    s.files.set(PATH, "torn");
    s.failSecondCreate = true;
    expect(() => writeDurableArtifact(PATH, "hello", s)).toThrow(/EEXIST/);
  });

  it("dedup: the same stable content written twice converges on ONE durable file, no flood", () => {
    const s = new FakeSeam();
    writeDurableArtifact(PATH, "hello", s);
    writeDurableArtifact(PATH, "hello", s); // second call hits EEXIST-identical → resync
    expect(s.files.size).toBe(1);
  });
});
