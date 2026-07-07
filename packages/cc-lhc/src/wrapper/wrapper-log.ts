// The wrapper's own log file. Doctrine: the wrapper NEVER writes raw bytes
// into a UI it does not own — Claude Code owns the terminal during
// passthrough, so diagnostics that fire while the child is alive go here
// (surface (c)), never to stdout/stderr. `status` surfaces the warning count
// so nothing is silently lost. POC-honest: append-only, no rotation.

import { mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ccLhcHome } from "../intake/paths.js";

export function defaultWrapperLogPath(): string {
  return join(ccLhcHome(), "wrapper.log");
}

export interface WrapperLog {
  readonly path: string;
  info(message: string): void;
  /** Logged like info, and counted — `status` reports the count since launch. */
  warn(message: string): void;
  warningCount(): number;
}

export function createWrapperLog(path: string = defaultWrapperLogPath()): WrapperLog {
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // Appends below fail silently too — logging must never take the wrapper down.
  }
  let warnings = 0;
  const append = (level: "info" | "warn", message: string): void => {
    void appendFile(path, `${new Date().toISOString()} [${level}] ${message}\n`).catch(() => {});
  };
  return {
    path,
    info(message: string): void {
      append("info", message);
    },
    warn(message: string): void {
      warnings += 1;
      append("warn", message);
    },
    warningCount(): number {
      return warnings;
    },
  };
}
