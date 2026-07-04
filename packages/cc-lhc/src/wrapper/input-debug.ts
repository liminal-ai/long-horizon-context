import { appendFile } from "node:fs/promises";

import type { InterceptState } from "./intercept.js";

function chunkHex(chunk: Buffer): string {
  return [...chunk].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
}

function chunkPrintable(chunk: Buffer): string {
  return [...chunk]
    .map((byte) => (byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : "."))
    .join("");
}

export function summarizeInterceptState(state: InterceptState): string {
  const escape = state.escapePassthrough === null ? "none" : state.escapePassthrough.kind;
  return `withholding=${state.withholding} buffer=${JSON.stringify(state.buffer)} freshLine=${state.freshLine} escape=${escape}`;
}

export function createInputDebugLogger(logPath: string | undefined): (chunk: Buffer, state: InterceptState) => void {
  if (logPath === undefined || logPath === "") {
    return () => {};
  }

  return (chunk, state) => {
    const line = `${new Date().toISOString()} hex=${chunkHex(chunk)} printable=${JSON.stringify(chunkPrintable(chunk))} ${summarizeInterceptState(state)}\n`;
    void appendFile(logPath, line).catch(() => {});
  };
}
