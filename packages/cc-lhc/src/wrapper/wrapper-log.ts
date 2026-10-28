import { mkdirSync, readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ccLhcHome } from "../intake/paths.js";

export function defaultWrapperLogPath(): string {
  return join(ccLhcHome(), "wrapper.log");
}

export const WRAPPER_LOG_WARN_RECORD = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[warn\] /;

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
  warn(message: string): void;
  warningCount(): number;
  drain?(): Promise<void>;
}

export function createWrapperLog(path: string = defaultWrapperLogPath()): WrapperLog {
  let currentRunWarnings = 0;
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {}
  const pending = new Set<Promise<void>>();
  const append = (level: "info" | "warn", message: string): void => {
    const write = appendFile(path, `${new Date().toISOString()} [${level}] ${message}\n`)
      .then(() => {
        if (level === "warn") currentRunWarnings += 1;
      })
      .catch(() => {})
      .finally(() => pending.delete(write));
    pending.add(write);
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
      return currentRunWarnings;
    },
    async drain(): Promise<void> {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
  };
}
