import { closeSync, type FSWatcher, openSync, readSync, statSync, watch } from "node:fs";

import type { RolloutLineItem, WatcherEmission } from "./types.js";

const POLL_MS = 500;
export const MAX_PARTIAL_BYTES = 10 * 1024 * 1024;

export interface RolloutWatcher {
  stop(): void;
}

export interface WatchRolloutOptions {
  pollMs?: number;
  maxPartialBytes?: number;
  onBatch: (emissions: WatcherEmission[]) => void;
  onBufferCap?: (message: string) => void;
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

export function watchRolloutFile(filePath: string, options: WatchRolloutOptions): RolloutWatcher {
  const pollMs = options.pollMs ?? POLL_MS;
  const maxPartialBytes = options.maxPartialBytes ?? MAX_PARTIAL_BYTES;
  let offset = 0;
  let partial = "";
  let stopped = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let fsWatcher: FSWatcher | undefined;

  const readMore = (): void => {
    let size: number;
    try {
      size = statSync(filePath).size;
    } catch {
      return;
    }

    if (size < offset) {
      offset = 0;
      partial = "";
    }
    if (size <= offset) return;

    const fd = openSync(filePath, "r");
    try {
      const toRead = size - offset;
      const buf = Buffer.alloc(toRead);
      const bytesRead = readSync(fd, buf, 0, toRead, offset);
      if (bytesRead <= 0) return;

      offset += bytesRead;
      const chunk = partial + buf.subarray(0, bytesRead).toString("utf8");
      const lines = chunk.split("\n");
      partial = lines.pop() ?? "";

      const capped = enforcePartialCap(partial, maxPartialBytes, options.onBufferCap);
      partial = capped.partial;

      const emissions: WatcherEmission[] = [];
      if (capped.capBreach !== null) emissions.push(capped.capBreach);
      for (const line of lines) {
        if (line.length === 0) continue;
        emissions.push(parseLine(line));
      }
      if (emissions.length > 0) {
        options.onBatch(emissions);
      }
    } finally {
      closeSync(fd);
    }
  };

  const tick = (): void => {
    if (stopped) return;
    readMore();
  };

  const flushPartial = (): void => {
    if (partial.trim() === "") return;
    const capped = enforcePartialCap(partial, maxPartialBytes, options.onBufferCap);
    if (capped.capBreach !== null) {
      options.onBatch([capped.capBreach]);
    } else {
      options.onBatch([parseLine(partial)]);
    }
    partial = "";
  };

  try {
    fsWatcher = watch(filePath, () => {
      tick();
    });
  } catch {
    // File may not exist yet; polling covers it.
  }

  pollTimer = setInterval(tick, pollMs);
  tick();

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (pollTimer !== undefined) clearInterval(pollTimer);
      if (fsWatcher !== undefined) fsWatcher.close();
      readMore();
      flushPartial();
    },
  };
}
