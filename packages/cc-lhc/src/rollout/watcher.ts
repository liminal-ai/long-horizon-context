import {
  closeSync,
  fstatSync,
  type FSWatcher,
  lstatSync,
  openSync,
  readSync,
  watch,
} from "node:fs";
import { createHash } from "node:crypto";

import {
  type ContinuityHandle,
  EMPTY_PREFIX_SHA256,
  identitiesEqual,
  type RolloutFileIdentity,
} from "../intake/prefix-boundary.js";
import type { RolloutLineItem, WatcherEmission } from "./types.js";

const POLL_MS = 500;
export const MAX_PARTIAL_BYTES = 10 * 1024 * 1024;
/** Bounded retries when snapshot metadata changes mid-read. */
export const SNAPSHOT_MAX_RETRIES = 3;

/** Injectable I/O seam for deterministic short-read / failure / mutation tests. */
export interface WatcherIo {
  fstat: (fd: number) => {
    size: number;
    dev: number | bigint;
    ino: number | bigint;
    mtimeMs?: number;
    ctimeMs?: number;
  };
  lstat: (path: string) => { dev: number | bigint; ino: number | bigint };
  read: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => number;
  /** Close an fd opened by the watcher (not continuity-owned handles). */
  close: (fd: number) => void;
}

export type PartialWatcherIo = Partial<WatcherIo>;

export interface FileMeta {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  dev: number | bigint;
  ino: number | bigint;
}

export interface RolloutWatcher {
  stop(): void;
  /**
   * Settles after a coherent initial snapshot is fully validated and onBatch
   * (if any) resolves. Rejects on incomplete initial evidence. Terminal after
   * rejection — no later onBatch.
   */
  initialCatchUp: Promise<void>;
  isTerminal?: () => boolean;
}

export interface WatchRolloutOptions {
  pollMs?: number;
  maxPartialBytes?: number;
  /**
   * Byte offset where live suffix begins. When > 0, `expectedConsumedDigest`
   * is required — the watcher never re-reads [0, startOffset) to invent a
   * baseline.
   */
  startOffset?: number;
  /**
   * Proven sha256 of exact bytes [0, startOffset). Session must transfer the
   * already-verified rebuilt-prefix digest (or EMPTY when startOffset=0).
   * Positive offset without a valid 64-hex digest fails closed at construct.
   */
  expectedConsumedDigest?: string;
  continuity?: ContinuityHandle;
  filePath?: string;
  io?: Partial<WatcherIo>;
  /**
   * Test seam: after candidate bytes are fully copied (local), before commit/
   * delivery. May mutate the underlying file. Snapshot post-check must reject.
   */
  afterCandidateRead?: (info: { bytes: Buffer; snapshotEnd: number }) => void;
  onBatch: (emissions: WatcherEmission[]) => void | Promise<void>;
  onBufferCap?: (message: string) => void;
  onInitialFailure?: (message: string) => void;
  onFileShrink?: (message: string) => void;
  onContinuityFailure?: (message: string) => void;
  onRuntimeFailure?: (message: string) => void;
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * Resolve the owned consumed-region baseline. Never re-reads the file to
 * establish trust — positive offset requires an explicit proven digest.
 */
export function resolveInitialConsumedDigest(
  startOffset: number,
  expectedConsumedDigest: string | undefined,
): { ok: true; digest: string } | { ok: false; reason: string } {
  const offset = Math.max(0, startOffset);
  if (offset === 0) {
    if (
      expectedConsumedDigest !== undefined &&
      expectedConsumedDigest !== EMPTY_PREFIX_SHA256
    ) {
      return {
        ok: false,
        reason: `startOffset=0 requires empty digest or omit; got ${expectedConsumedDigest.slice(0, 16)}…`,
      };
    }
    return { ok: true, digest: EMPTY_PREFIX_SHA256 };
  }
  if (expectedConsumedDigest === undefined || expectedConsumedDigest === "") {
    return {
      ok: false,
      reason: "positive startOffset requires expectedConsumedDigest (no re-baseline from disk)",
    };
  }
  if (!SHA256_HEX_RE.test(expectedConsumedDigest)) {
    return {
      ok: false,
      reason: "expectedConsumedDigest must be lowercase 64-hex sha256",
    };
  }
  return { ok: true, digest: expectedConsumedDigest };
}

function parseLine(raw: string): WatcherEmission {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { kind: "parse_error", raw, error: "empty line" };
  }
  try {
    const item = JSON.parse(trimmed) as RolloutLineItem;
    return { kind: "line", item, raw: trimmed };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { kind: "parse_error", raw: trimmed, error: message };
  }
}

function enforcePartialCap(
  partial: string,
  maxPartialBytes: number,
  onBufferCap: ((message: string) => void) | undefined,
): { partial: string; capBreach: WatcherEmission | null } {
  if (Buffer.byteLength(partial, "utf8") <= maxPartialBytes) {
    return { partial, capBreach: null };
  }
  const message = `partial line exceeded ${maxPartialBytes} byte cap`;
  onBufferCap?.(message);
  return {
    partial: "",
    capBreach: { kind: "parse_error", raw: partial.slice(0, 200), error: message },
  };
}

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function defaultIo(): WatcherIo {
  return {
    fstat: (fd) => {
      const st = fstatSync(fd);
      return {
        size: st.size,
        dev: st.dev,
        ino: st.ino,
        mtimeMs: st.mtimeMs,
        ctimeMs: st.ctimeMs,
      };
    },
    lstat: (path) => {
      const st = lstatSync(path);
      return { dev: st.dev, ino: st.ino };
    },
    read: (fd, buffer, offset, length, position) => readSync(fd, buffer, offset, length, position),
    close: (fd) => closeSync(fd),
  };
}

function metaEqual(a: FileMeta, b: FileMeta): boolean {
  return (
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.dev === b.dev &&
    a.ino === b.ino
  );
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Coherent snapshot continuity watcher.
 *
 * For each actual change/growth:
 * 1. Capture pre-read fd identity/size/mtime/ctime
 * 2. Read [0, snapshotEnd) into local candidate bytes (local cursor; short-read safe)
 * 3. Capture post-read metadata; if changed, bounded retry or reject
 * 4. Prove candidate[0, oldOffset) matches prior consumed digest
 * 5. Derive suffix + new digest from those exact candidate bytes
 * 6. Initial: validate full parse + trailing newline before commit/onBatch
 * 7. Commit offset/digest/meta, then deliver
 *
 * Idle polls with unchanged metadata skip work. fs.watch marks continuity dirty
 * so a watcher event cannot be skipped solely because coarse stats compare equal.
 *
 * Cost: O(snapshotEnd) bytes read+hash per change (full prefix re-prove).
 */
export function watchRolloutFile(
  filePathOrOptions: string | WatchRolloutOptions,
  maybeOptions?: WatchRolloutOptions,
): RolloutWatcher {
  const options: WatchRolloutOptions =
    typeof filePathOrOptions === "string"
      ? { ...maybeOptions!, filePath: filePathOrOptions }
      : filePathOrOptions;

  const pollMs = options.pollMs ?? POLL_MS;
  const maxPartialBytes = options.maxPartialBytes ?? MAX_PARTIAL_BYTES;
  const io: WatcherIo = { ...defaultIo(), ...options.io };

  let offset = Math.max(0, options.startOffset ?? 0);
  let partial = "";
  let stopped = false;
  let invalidated = false;
  let runtimeFailureEmitted = false;
  let continuityFailureEmitted = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let fsWatcher: FSWatcher | undefined;
  let initialSettled = false;
  let resolveInitial: () => void = () => {};
  let rejectInitial: (cause: Error) => void = () => {};
  const initialCatchUp = new Promise<void>((resolve, reject) => {
    resolveInitial = resolve;
    rejectInitial = reject;
  });
  void initialCatchUp.catch(() => {});

  let lastMeta: FileMeta | undefined;
  /** Set by fs.watch; forces a full continuity pass even if stats compare equal. */
  let continuityDirty = true;

  const finishInitialOk = (): void => {
    if (initialSettled) return;
    initialSettled = true;
    resolveInitial();
  };

  let fd: number;
  let identity: RolloutFileIdentity;
  let path: string;
  let closeHandle: () => void = () => {};
  let closed = false;

  const doClose = (): void => {
    if (closed) return;
    closed = true;
    try {
      closeHandle();
    } catch {
      // best effort
    }
  };

  const stopPolling = (): void => {
    if (pollTimer !== undefined) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
    if (fsWatcher !== undefined) {
      try {
        fsWatcher.close();
      } catch {
        // best effort
      }
      fsWatcher = undefined;
    }
  };

  const terminate = (
    kind: "initial" | "shrink" | "continuity" | "runtime",
    message: string,
  ): void => {
    if (invalidated && kind !== "initial") return;
    invalidated = true;
    partial = "";
    stopPolling();
    doClose();
    if (kind === "shrink") options.onFileShrink?.(message);
    else if (kind === "continuity") {
      if (!continuityFailureEmitted) {
        continuityFailureEmitted = true;
        options.onContinuityFailure?.(message);
      }
    } else if (kind === "runtime") {
      if (!runtimeFailureEmitted) {
        runtimeFailureEmitted = true;
        options.onRuntimeFailure?.(message);
      }
    }
    if (!initialSettled) {
      initialSettled = true;
      options.onInitialFailure?.(message);
      rejectInitial(new Error(message));
    }
  };

  // --- Open with idempotent closer before fstat (no leak on fstat throw) ---
  if (options.continuity !== undefined) {
    fd = options.continuity.fd;
    identity = options.continuity.identity;
    path = options.continuity.path;
    closeHandle = options.continuity.close;
  } else {
    const filePath = options.filePath;
    if (filePath === undefined || filePath === "") {
      throw new Error("watchRolloutFile: filePath or continuity required");
    }
    path = filePath;
    try {
      fd = openSync(filePath, "r");
    } catch (cause) {
      terminate("initial", `initial open failed: ${detail(cause)}`);
      return {
        initialCatchUp,
        isTerminal: () => true,
        stop(): void {
          stopped = true;
          if (!initialSettled) finishInitialOk();
        },
      };
    }
    // Idempotent closer immediately after successful open — before fstat.
    let localClosed = false;
    closeHandle = () => {
      if (localClosed) return;
      localClosed = true;
      try {
        io.close(fd);
      } catch {
        // best effort
      }
    };
    try {
      const st = io.fstat(fd);
      identity = { dev: st.dev, ino: st.ino };
    } catch (cause) {
      doClose();
      terminate("initial", `initial fstat failed: ${detail(cause)}`);
      return {
        initialCatchUp,
        isTerminal: () => true,
        stop(): void {
          stopped = true;
          if (!initialSettled) finishInitialOk();
        },
      };
    }
  }

  // Owned baseline: caller-supplied proven digest only. Never re-read disk to
  // establish trust (handoff-gap rewrites must fail the first candidate proof).
  const resolvedDigest = resolveInitialConsumedDigest(offset, options.expectedConsumedDigest);
  if (!resolvedDigest.ok) {
    terminate("initial", resolvedDigest.reason);
    return {
      initialCatchUp,
      isTerminal: () => true,
      stop(): void {
        stopped = true;
        if (!initialSettled) finishInitialOk();
      },
    };
  }
  let consumedDigest: string = resolvedDigest.digest;

  let flushingOnStop = false;

  const deliver = (emissions: WatcherEmission[], isInitial: boolean): void => {
    if (invalidated) return;
    if (stopped && !flushingOnStop) return;
    if (emissions.length === 0) {
      if (isInitial) finishInitialOk();
      return;
    }
    const result = options.onBatch(emissions);
    if (isInitial) {
      void Promise.resolve(result).then(
        () => {
          if (!invalidated) finishInitialOk();
        },
        (cause: unknown) => terminate("initial", `initial onBatch failed: ${detail(cause)}`),
      );
    }
  };

  function readRangeLocal(
    from: number,
    targetSize: number,
  ): { ok: true; chunk: Buffer } | { ok: false; reason: string } {
    if (targetSize < from) {
      return { ok: false, reason: `target size ${targetSize} < from ${from}` };
    }
    if (targetSize === from) {
      return { ok: true, chunk: Buffer.alloc(0) };
    }
    const pieces: Buffer[] = [];
    let cursor = from;
    while (cursor < targetSize) {
      const toRead = targetSize - cursor;
      const buf = Buffer.alloc(Math.min(toRead, 1024 * 1024));
      let bytesRead: number;
      try {
        bytesRead = io.read(fd, buf, 0, buf.byteLength, cursor);
      } catch (cause) {
        return { ok: false, reason: `read failed: ${detail(cause)}` };
      }
      if (bytesRead <= 0) {
        return {
          ok: false,
          reason: `short read: got ${bytesRead} with ${toRead} remaining at cursor=${cursor}`,
        };
      }
      pieces.push(buf.subarray(0, bytesRead));
      cursor += bytesRead;
    }
    return { ok: true, chunk: Buffer.concat(pieces) };
  }

  const captureMeta = (): FileMeta | { error: string } => {
    try {
      const st = io.fstat(fd);
      if (!identitiesEqual({ dev: st.dev, ino: st.ino }, identity)) {
        return { error: "fd identity changed" };
      }
      return {
        size: st.size,
        mtimeMs: st.mtimeMs ?? 0,
        ctimeMs: st.ctimeMs ?? 0,
        dev: st.dev,
        ino: st.ino,
      };
    } catch (cause) {
      return { error: `stat failed: ${detail(cause)}` };
    }
  };

  /**
   * Parse a complete snapshot text for initial delivery. Requires trailing
   * newline on non-empty content. Returns emissions or a rejection reason.
   * Does not touch global partial/offset.
   */
  const parseCompleteSnapshot = (
    fullText: string,
    suffixFrom: number,
  ): { ok: true; emissions: WatcherEmission[] } | { ok: false; reason: string } => {
    if (fullText.length === 0) {
      return { ok: true, emissions: [] };
    }
    if (!fullText.endsWith("\n")) {
      return { ok: false, reason: "unterminated initial partial line" };
    }
    // Only deliver the suffix portion (bytes after oldOffset as text).
    // Candidate is raw bytes; suffix is UTF-8 of candidate.subarray(suffixFrom).
    const suffixBytes = Buffer.from(fullText, "utf8").subarray(suffixFrom);
    const suffixText = suffixBytes.toString("utf8");
    // For initial full-file validation: every line in the whole file must be complete
    // (already ensured by trailing \n). Emit only suffix lines.
    const lines = suffixText === "" ? [] : suffixText.slice(0, -1).split("\n");
    const emissions: WatcherEmission[] = [];
    for (const line of lines) {
      if (line.length === 0) continue;
      emissions.push(parseLine(line));
    }
    // Also validate prefix lines parse if present (full file integrity).
    if (suffixFrom > 0) {
      const prefixText = fullText.slice(0, fullText.length - suffixText.length);
      const prefixLines = prefixText.endsWith("\n")
        ? prefixText.slice(0, -1).split("\n")
        : prefixText.split("\n");
      for (const line of prefixLines) {
        if (line.length === 0) continue;
        try {
          JSON.parse(line);
        } catch {
          return { ok: false, reason: "malformed prefix line in initial snapshot" };
        }
      }
    }
    return { ok: true, emissions };
  };

  /**
   * Live (post-initial) suffix parse may leave a trailing partial in local
   * state until the next growth completes it.
   */
  const parseLiveSuffix = (
    suffixText: string,
  ): { emissions: WatcherEmission[]; nextPartial: string } => {
    const combined = partial + suffixText;
    const lines = combined.split("\n");
    const nextPartial = lines.pop() ?? "";
    const capped = enforcePartialCap(nextPartial, maxPartialBytes, options.onBufferCap);
    const emissions: WatcherEmission[] = [];
    if (capped.capBreach !== null) emissions.push(capped.capBreach);
    for (const line of lines) {
      if (line.length === 0) continue;
      emissions.push(parseLine(line));
    }
    return { emissions, nextPartial: capped.partial };
  };

  const attemptCoherentSnapshot = (
    isInitial: boolean,
  ): "idle" | "ok" | { fail: string; kind: "initial" | "shrink" | "continuity" | "runtime" } => {
    // Path identity
    try {
      const lst = io.lstat(path);
      if (!identitiesEqual({ dev: lst.dev, ino: lst.ino }, identity)) {
        return {
          fail: "path replaced or retargeted (dev/ino mismatch)",
          kind: isInitial ? "initial" : "continuity",
        };
      }
    } catch {
      return {
        fail: "path missing or unreadable (identity check)",
        kind: isInitial ? "initial" : "continuity",
      };
    }

    let retries = 0;
    while (retries <= SNAPSHOT_MAX_RETRIES) {
      const pre = captureMeta();
      if ("error" in pre) {
        return { fail: pre.error, kind: isInitial ? "initial" : "runtime" };
      }

      if (pre.size < offset) {
        return {
          fail: `file truncated/rewritten: size=${pre.size} < offset=${offset}`,
          kind: isInitial ? "initial" : "shrink",
        };
      }

      // Idle: unchanged metadata and not dirty from fs.watch → skip.
      if (
        !isInitial &&
        !continuityDirty &&
        lastMeta !== undefined &&
        metaEqual(pre, lastMeta) &&
        pre.size === offset
      ) {
        return "idle";
      }

      const snapshotEnd = pre.size;
      // Read coherent candidate [0, snapshotEnd)
      const readResult = readRangeLocal(0, snapshotEnd);
      if (!readResult.ok) {
        return { fail: readResult.reason, kind: isInitial ? "initial" : "runtime" };
      }
      let candidate = readResult.chunk;

      // Test seam: mutate after copy, before post-check / commit.
      options.afterCandidateRead?.({ bytes: candidate, snapshotEnd });

      const post = captureMeta();
      if ("error" in post) {
        return { fail: post.error, kind: isInitial ? "initial" : "runtime" };
      }
      if (!metaEqual(pre, post)) {
        retries += 1;
        if (retries > SNAPSHOT_MAX_RETRIES) {
          return {
            fail: `snapshot changed during read after ${SNAPSHOT_MAX_RETRIES} retries`,
            kind: isInitial ? "initial" : "continuity",
          };
        }
        // Bounded retry with a fresh candidate.
        continue;
      }

      if (candidate.byteLength !== snapshotEnd) {
        return {
          fail: `candidate length mismatch: have=${candidate.byteLength} need=${snapshotEnd}`,
          kind: isInitial ? "initial" : "runtime",
        };
      }

      // Prove [0, oldOffset) from **candidate bytes** matches prior digest.
      const oldOffset = offset;
      const priorRegion = candidate.subarray(0, oldOffset);
      const priorHash = oldOffset === 0 ? EMPTY_PREFIX_SHA256 : sha256(priorRegion);
      if (priorHash !== consumedDigest) {
        return {
          fail: "consumed region digest mismatch (rewrite of already-read bytes)",
          kind: isInitial ? "initial" : "continuity",
        };
      }

      // Derive new digest and suffix from the same candidate.
      const newDigest = snapshotEnd === 0 ? EMPTY_PREFIX_SHA256 : sha256(candidate);
      const suffixBuf = candidate.subarray(oldOffset);
      const suffixText = suffixBuf.toString("utf8");

      if (snapshotEnd === oldOffset) {
        // No growth: still update lastMeta (and clear dirty).
        lastMeta = pre;
        continuityDirty = false;
        if (isInitial) {
          // Empty or already-at-startOffset: must not leave partial.
          if (partial.trim() !== "") {
            return { fail: "unterminated initial partial line", kind: "initial" };
          }
          // Initial with no suffix to deliver.
          finishInitialOk();
        }
        return "ok";
      }

      if (isInitial) {
        // Validate complete initial candidate (including final newline) before
        // any commit or onBatch.
        const fullText = candidate.toString("utf8");
        const parsed = parseCompleteSnapshot(fullText, oldOffset);
        if (!parsed.ok) {
          return { fail: parsed.reason, kind: "initial" };
        }
        // Commit then deliver.
        offset = snapshotEnd;
        consumedDigest = newDigest;
        lastMeta = pre;
        continuityDirty = false;
        partial = "";
        if (parsed.emissions.length === 0) {
          finishInitialOk();
        } else {
          deliver(parsed.emissions, true);
        }
        return "ok";
      }

      // Live: may leave trailing partial; still commit only after proof on candidate.
      const live = parseLiveSuffix(suffixText);
      offset = snapshotEnd;
      consumedDigest = newDigest;
      lastMeta = pre;
      continuityDirty = false;
      partial = live.nextPartial;
      if (live.emissions.length > 0) {
        deliver(live.emissions, false);
      }
      return "ok";
    }

    return {
      fail: `snapshot changed during read after ${SNAPSHOT_MAX_RETRIES} retries`,
      kind: isInitial ? "initial" : "continuity",
    };
  };

  const readMore = (isInitial = false, allowWhileStopping = false): void => {
    if (invalidated || closed) {
      if (isInitial && !initialSettled) terminate("initial", "file invalidated before initial catch-up");
      return;
    }
    if (stopped && !allowWhileStopping) return;

    const result = attemptCoherentSnapshot(isInitial);
    if (result === "idle" || result === "ok") return;
    terminate(result.kind, result.fail);
  };

  const tick = (): void => {
    if (stopped || invalidated) return;
    readMore(false);
  };

  try {
    fsWatcher = watch(path, () => {
      continuityDirty = true;
      tick();
    });
  } catch {
    // polling only
  }

  pollTimer = setInterval(tick, pollMs);
  readMore(true);

  return {
    initialCatchUp,
    isTerminal: () => invalidated || stopped,
    stop(): void {
      if (stopped) return;
      stopped = true;
      stopPolling();
      if (!invalidated) {
        try {
          flushingOnStop = true;
          continuityDirty = true;
          readMore(false, true);
        } catch {
          // best effort
        } finally {
          flushingOnStop = false;
        }
      }
      partial = "";
      if (!initialSettled) finishInitialOk();
      doClose();
    },
  };
}
