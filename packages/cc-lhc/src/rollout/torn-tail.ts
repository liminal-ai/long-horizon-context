/**
 * Pre-launch repair of a torn transcript tail.
 *
 * A Claude session file whose last line has no newline (a writer killed
 * mid-append) is poison on resume: Claude appends its next record onto the
 * fragment, the fused line never parses, and every later capture of the
 * session degrades. Before a launch resumes an existing session file:
 *   - fragment parses as one complete JSON record → append "\n", keep it
 *   - otherwise → save the fragment bytes to
 *     $CC_LHC_HOME/torn-lines/<sessionId>-<timestamp>.fragment and truncate
 *     the transcript to just after its last newline
 * Only when no other process holds the file open; a held (or unprovable)
 * file is left untouched and the launch continues.
 */

import {
  closeSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

import { type FileHolder, type FileHoldersResult, findFileHolders } from "../runtime/file-holders.js";

export type TornTailRepair =
  | { kind: "missing" }
  | { kind: "clean" }
  | { kind: "newline_appended"; recordBytes: number }
  | { kind: "fragment_trimmed"; fragmentBytes: number; sideFile: string; truncatedTo: number }
  | { kind: "held_open"; fragmentBytes: number; holders: FileHolder[] }
  | { kind: "holder_check_unavailable"; fragmentBytes: number; reason: string }
  | { kind: "failed"; reason: string };

export interface RepairTornTailInput {
  path: string;
  sessionId: string;
  home: string;
  nowMs?: number;
  findHolders?: (path: string) => FileHoldersResult;
}

const CHUNK = 64 * 1024;

/** Byte offset just after the last "\n" (0 when there is none). */
function completeEnd(fd: number, size: number): number {
  let end = size;
  const buf = Buffer.alloc(CHUNK);
  while (end > 0) {
    const start = Math.max(0, end - CHUNK);
    const length = end - start;
    let got = 0;
    while (got < length) {
      const n = readSync(fd, buf, got, length - got, start + got);
      if (n <= 0) throw new Error(`short read at ${String(start + got)}`);
      got += n;
    }
    const idx = buf.subarray(0, length).lastIndexOf(0x0a);
    if (idx !== -1) return start + idx + 1;
    end = start;
  }
  return 0;
}

function readRange(fd: number, from: number, to: number): Buffer {
  const out = Buffer.alloc(to - from);
  let got = 0;
  while (got < out.byteLength) {
    const n = readSync(fd, out, got, out.byteLength - got, from + got);
    if (n <= 0) throw new Error(`short read at ${String(from + got)}`);
    got += n;
  }
  return out;
}

function isCompleteRecord(fragment: Buffer): boolean {
  try {
    const value: unknown = JSON.parse(fragment.toString("utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value);
  } catch {
    return false;
  }
}

export function tornLinesDir(home: string): string {
  return join(home, "torn-lines");
}

export function repairTornTranscriptTail(input: RepairTornTailInput): TornTailRepair {
  try {
    statSync(input.path);
  } catch {
    return { kind: "missing" };
  }
  // Read with our own handle, and close it before asking who holds the file:
  // on Windows the holder check includes a share-none open, which our own
  // open handle would refuse.
  let size: number;
  let end: number;
  let fragment: Buffer;
  try {
    const fd = openSync(input.path, "r");
    try {
      size = fstatSync(fd).size;
      end = completeEnd(fd, size);
      fragment = end === size ? Buffer.alloc(0) : readRange(fd, end, size);
    } finally {
      closeSync(fd);
    }
  } catch (cause) {
    return { kind: "failed", reason: `open failed: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  if (end === size) return { kind: "clean" };

  const holders = (input.findHolders ?? findFileHolders)(input.path);
  if (!holders.ok) {
    return { kind: "holder_check_unavailable", fragmentBytes: fragment.byteLength, reason: holders.reason };
  }
  if (holders.holders.length > 0) {
    return { kind: "held_open", fragmentBytes: fragment.byteLength, holders: holders.holders };
  }

  let fd: number;
  try {
    fd = openSync(input.path, "r+");
  } catch (cause) {
    return { kind: "failed", reason: `open failed: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  try {
    // Anything written between the read and here means someone holds it after all.
    if (fstatSync(fd).size !== size || !readRange(fd, end, size).equals(fragment)) {
      return {
        kind: "holder_check_unavailable",
        fragmentBytes: fragment.byteLength,
        reason: "transcript changed during the holder check",
      };
    }

    if (isCompleteRecord(fragment)) {
      writeSync(fd, "\n", size);
      fsyncSync(fd);
      return { kind: "newline_appended", recordBytes: fragment.byteLength };
    }

    const dir = tornLinesDir(input.home);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date(input.nowMs ?? Date.now()).toISOString().replace(/[:.]/g, "-");
    const sideFile = join(dir, `${input.sessionId}-${stamp}.fragment`);
    // Fragment is durable before the transcript loses it.
    writeFileSync(sideFile, fragment, { mode: 0o600, flag: "wx" });
    ftruncateSync(fd, end);
    fsyncSync(fd);
    return { kind: "fragment_trimmed", fragmentBytes: fragment.byteLength, sideFile, truncatedTo: end };
  } catch (cause) {
    return { kind: "failed", reason: cause instanceof Error ? cause.message : String(cause) };
  } finally {
    closeSync(fd);
  }
}
