/**
 * Content-verifiable rebuilt-prefix boundary.
 *
 * Provenance:
 * - `none`     — positively known native/non-rebuilt; may read from byte zero
 * - `unknown`  — legacy / incomplete / ambiguous; fail closed (no watcher/intake)
 * - `verified` — exact non-negative integers + 64-hex sha256; prove then skip
 *
 * Slice 1 must not infer `none` or `verified` from a missing digest, legacy
 * zero, or lineage read failure. Reconciliation must establish either explicitly.
 */

import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export type PrefixProvenanceKind = "none" | "unknown" | "verified";

/** Known absence of a synthetic rebuilt prefix. */
export interface PrefixBoundaryNone {
  kind: "none";
}

/**
 * Legacy, incomplete, or ambiguous metadata. Capture fails closed until
 * reconciliation establishes `none` or `verified`.
 */
export interface PrefixBoundaryUnknown {
  kind: "unknown";
}

/** Content-addressed fence over the exact serialized rebuilt prefix. */
export interface PrefixBoundaryVerified {
  kind: "verified";
  /** Complete JSONL lines in the prefix (excludes trailing runtime receipt). */
  lineCount: number;
  /** Exact UTF-8 byte length of the serialized prefix (including trailing newlines). */
  byteLength: number;
  /** Lowercase hex sha256 over the exact serialized prefix bytes. */
  sha256: string;
}

export type PrefixBoundary = PrefixBoundaryNone | PrefixBoundaryUnknown | PrefixBoundaryVerified;

/** sha256 of the empty byte string — required when lineCount=byteLength=0. */
export const EMPTY_PREFIX_SHA256 = createHash("sha256").update(Buffer.alloc(0)).digest("hex");

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export function prefixBoundaryNone(): PrefixBoundaryNone {
  return { kind: "none" };
}

export function prefixBoundaryUnknown(): PrefixBoundaryUnknown {
  return { kind: "unknown" };
}

/**
 * Canonical known-none DB encoding: provenance=none, lines/bytes zero or NULL,
 * sha256 NULL/empty. Contradictory columns are not trusted as none.
 */
export function isCanonicalNoneRow(row: {
  prefix_provenance?: string | null;
  replayed_prefix_lines?: number | null;
  replayed_prefix_bytes?: number | null;
  replayed_prefix_sha256?: string | null;
}): boolean {
  if ((row.prefix_provenance ?? "") !== "none") return false;
  const lines = row.replayed_prefix_lines;
  const bytes = row.replayed_prefix_bytes;
  const sha = row.replayed_prefix_sha256;
  const linesOk = lines === null || lines === undefined || lines === 0;
  const bytesOk = bytes === null || bytes === undefined || bytes === 0;
  const shaOk = sha === null || sha === undefined || sha === "";
  return linesOk && bytesOk && shaOk;
}

export function isSafeNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}

export function isValidSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX_RE.test(value);
}

/**
 * Validate stored verified metadata without clamping/normalization.
 * Invalid or inconsistent rows become unknown (caller maps that way).
 */
export function parseStoredVerifiedPrefix(
  lines: unknown,
  bytes: unknown,
  sha: unknown,
): PrefixBoundaryVerified | null {
  if (!isSafeNonNegativeInteger(lines) || !isSafeNonNegativeInteger(bytes)) {
    return null;
  }
  if (!isValidSha256Hex(sha)) return null;
  const sha256 = sha.toLowerCase();
  // Zero consistency: empty fence iff empty bytes iff empty digest.
  if (lines === 0) {
    if (bytes !== 0 || sha256 !== EMPTY_PREFIX_SHA256) return null;
  } else if (bytes === 0) {
    return null;
  }
  return { kind: "verified", lineCount: lines, byteLength: bytes, sha256 };
}

/**
 * Build a verified boundary from the exact serialized prefix string that will
 * (or did) occupy the leading bytes of the rebuilt rollout file.
 */
export function computeVerifiedPrefixBoundary(
  prefixSerialized: string,
  lineCount: number,
): PrefixBoundaryVerified {
  if (!isSafeNonNegativeInteger(lineCount)) {
    throw new Error(`computeVerifiedPrefixBoundary: invalid lineCount ${String(lineCount)}`);
  }
  const buf = Buffer.from(prefixSerialized, "utf8");
  return {
    kind: "verified",
    lineCount,
    byteLength: buf.byteLength,
    sha256: createHash("sha256").update(buf).digest("hex"),
  };
}

export type PrefixVerifyResult =
  | { ok: true; boundary: PrefixBoundaryVerified }
  | { ok: false; reason: string };

/** Open file identity for continuity across proof and watch. */
export interface RolloutFileIdentity {
  dev: number | bigint;
  ino: number | bigint;
}

/**
 * Held open across prefix proof and watching so a path replacement cannot
 * swap contents between the two. Closed by the watcher (or caller on failure).
 */
export interface ContinuityHandle {
  fd: number;
  path: string;
  identity: RolloutFileIdentity;
  /** Close the underlying descriptor (idempotent). */
  close: () => void;
}

export function openContinuityHandle(filePath: string): ContinuityHandle {
  const fd = openSync(filePath, "r");
  try {
    const st = fstatSync(fd);
    let closed = false;
    return {
      fd,
      path: filePath,
      identity: { dev: st.dev, ino: st.ino },
      close: () => {
        if (closed) return;
        closed = true;
        try {
          closeSync(fd);
        } catch {
          // best effort
        }
      },
    };
  } catch (cause) {
    try {
      closeSync(fd);
    } catch {
      // best effort
    }
    throw cause;
  }
}

export function identityOfFd(fd: number): RolloutFileIdentity & { size: number } {
  const st = fstatSync(fd);
  return { dev: st.dev, ino: st.ino, size: st.size };
}

export function identitiesEqual(a: RolloutFileIdentity, b: RolloutFileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * Exact digest over all bytes already consumed [0, offset).
 *
 * Cost: every growth/change re-reads and re-hashes the full consumed region
 * (O(offset) bytes per change event). Idle polls may skip via metadata cache.
 * Acceptable for Slice 1 host certification; not free for multi-GB rollouts.
 */
export function digestConsumedRegion(fd: number, consumedEnd: number): string {
  if (consumedEnd <= 0) return EMPTY_PREFIX_SHA256;
  const bytes = readFdRange(fd, 0, consumedEnd);
  if (bytes.byteLength !== consumedEnd) {
    throw new Error(`consumed digest short read: have=${bytes.byteLength} need=${consumedEnd}`);
  }
  return createHash("sha256").update(bytes).digest("hex");
}

export function verifyConsumedRegionDigest(
  fd: number,
  consumedEnd: number,
  expectedSha256: string,
): boolean {
  try {
    return digestConsumedRegion(fd, consumedEnd) === expectedSha256;
  } catch {
    return false;
  }
}

/** @deprecated Use exact consumed-region digest; retained name for import churn. */
export const CONSUMED_END_ANCHOR_MAX_BYTES = 0;

/**
 * Prove that the continuity handle's file begins with the exact persisted
 * prefix bytes. Uses the open fd only (no re-open by path).
 */
export function verifyPrefixBoundaryOnHandle(
  handle: ContinuityHandle,
  boundary: PrefixBoundaryVerified,
): PrefixVerifyResult {
  const parsed = parseStoredVerifiedPrefix(boundary.lineCount, boundary.byteLength, boundary.sha256);
  if (parsed === null) {
    return { ok: false, reason: "prefix_boundary:invalid_stored_boundary" };
  }

  let st: ReturnType<typeof fstatSync>;
  try {
    st = fstatSync(handle.fd);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, reason: `prefix_boundary:stat_failed:${message}` };
  }
  if (!identitiesEqual({ dev: st.dev, ino: st.ino }, handle.identity)) {
    return { ok: false, reason: "prefix_boundary:identity_changed" };
  }

  if (boundary.lineCount === 0) {
    return { ok: true, boundary: parsed };
  }

  if (st.size < boundary.byteLength) {
    return {
      ok: false,
      reason: `prefix_boundary:short_file:have=${st.size}:need=${boundary.byteLength}`,
    };
  }

  let prefixBytes: Buffer;
  try {
    prefixBytes = readFdRange(handle.fd, 0, boundary.byteLength);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, reason: `prefix_boundary:read_failed:${message}` };
  }

  if (prefixBytes.byteLength !== boundary.byteLength) {
    return {
      ok: false,
      reason: `prefix_boundary:short_read:have=${prefixBytes.byteLength}:need=${boundary.byteLength}`,
    };
  }

  const digest = createHash("sha256").update(prefixBytes).digest("hex");
  if (digest !== boundary.sha256) {
    return { ok: false, reason: "prefix_boundary:digest_mismatch" };
  }

  const text = prefixBytes.toString("utf8");
  if (!text.endsWith("\n")) {
    return { ok: false, reason: "prefix_boundary:missing_trailing_newline" };
  }
  const lines = text.slice(0, -1).split("\n");
  if (lines.length !== boundary.lineCount) {
    return {
      ok: false,
      reason: `prefix_boundary:line_count_mismatch:have=${lines.length}:need=${boundary.lineCount}`,
    };
  }
  for (const line of lines) {
    if (line.trim() === "") {
      return { ok: false, reason: "prefix_boundary:empty_prefix_line" };
    }
    try {
      JSON.parse(line);
    } catch {
      return { ok: false, reason: "prefix_boundary:malformed_prefix_json" };
    }
  }

  return { ok: true, boundary: parsed };
}

/**
 * Path-based verify for unit tests; production capture uses ContinuityHandle.
 */
export function verifyPrefixBoundaryOnDisk(
  filePath: string,
  boundary: PrefixBoundaryVerified,
): PrefixVerifyResult {
  let handle: ContinuityHandle;
  try {
    handle = openContinuityHandle(filePath);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, reason: `prefix_boundary:open_failed:${message}` };
  }
  try {
    return verifyPrefixBoundaryOnHandle(handle, boundary);
  } finally {
    handle.close();
  }
}

export function readFdRange(fd: number, position: number, byteLength: number): Buffer {
  if (byteLength === 0) return Buffer.alloc(0);
  const buf = Buffer.alloc(byteLength);
  let filled = 0;
  while (filled < byteLength) {
    const n = readSync(fd, buf, filled, byteLength - filled, position + filled);
    if (n <= 0) break;
    filled += n;
  }
  return filled === byteLength ? buf : buf.subarray(0, filled);
}

/** Split full serialized rebuild into prefix bytes (for boundary) given line count. */
export function splitSerializedPrefix(
  fullSerialized: string,
  prefixLineCount: number,
): { prefixSerialized: string; suffixSerialized: string } {
  if (prefixLineCount <= 0) {
    return { prefixSerialized: "", suffixSerialized: fullSerialized };
  }
  const withoutFinal = fullSerialized.endsWith("\n")
    ? fullSerialized.slice(0, -1)
    : fullSerialized;
  const allLines = withoutFinal === "" ? [] : withoutFinal.split("\n");
  const prefixLines = allLines.slice(0, prefixLineCount);
  const suffixLines = allLines.slice(prefixLineCount);
  const prefixSerialized =
    prefixLines.length === 0 ? "" : `${prefixLines.join("\n")}\n`;
  const suffixSerialized =
    suffixLines.length === 0 ? "" : `${suffixLines.join("\n")}\n`;
  return { prefixSerialized, suffixSerialized };
}
