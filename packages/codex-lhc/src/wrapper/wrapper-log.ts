// The wrapper's own log file. Doctrine: the wrapper NEVER writes raw bytes
// into a UI it does not own — Codex owns the terminal during passthrough, so
// diagnostics that fire while the child is alive go here (surface (c)), never
// to stdout/stderr. `status` surfaces the warning count so nothing is silently
// lost. POC-honest: append-only, no rotation.

import { mkdirSync, readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { codexLhcHome } from "../intake/paths.js";

export function defaultWrapperLogPath(): string {
  return join(codexLhcHome(), "wrapper.log");
}

/** Matches a single warn record line as written by `append` — not message-body tokens. */
export const WRAPPER_LOG_WARN_RECORD =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[warn\] /;

/** Count warn records in the log file — durable across wrapper relaunches. */
export function countWarnLinesInLog(path: string): number {
  try {
    const contents = readFileSync(path, "utf8");
    if (contents.length === 0) return 0;
    let count = 0;
    for (const line of contents.split("\n")) {
      if (WRAPPER_LOG_WARN_RECORD.test(line)) count += 1;
    }
    return count;
  } catch {
    return 0;
  }
}

export interface WrapperLog {
  readonly path: string;
  info(message: string): void;
  /** Logged like info, and counted — `status` reports the durable warn-line count. */
  warn(message: string): void;
  warningCount(): number;
}

export function createWrapperLog(path: string = defaultWrapperLogPath()): WrapperLog {
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // Appends below fail silently too — logging must never take the wrapper down.
  }
  const append = (level: "info" | "warn", message: string): void => {
    void appendFile(path, `${new Date().toISOString()} [${level}] ${message}\n`).catch(() => {});
  };
  return {
    path,
    info(message: string): void {
      append("info", message);
    },
    warn(message: string): void {
      append("warn", message);
    },
    warningCount(): number {
      return countWarnLinesInLog(path);
    },
  };
}
