import { appendFile } from "node:fs/promises";

import type { InputState } from "./modal.js";

function chunkHex(chunk: Buffer): string {
  return [...chunk].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
}

function chunkPrintable(chunk: Buffer): string {
  return [...chunk].map((byte) => (byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ".")).join("");
}

export function summarizeInputState(state: InputState): string {
  const escapeKind = state.escape === null ? "none" : state.escape.kind;
  return `mode=${state.mode} line=${JSON.stringify(state.line)} inPaste=${state.inPaste} escape=${escapeKind} panelRows=${state.panelRows.length}`;
}

export function createInputDebugLogger(logPath: string | undefined): (chunk: Buffer, state: InputState) => void {
  if (logPath === undefined || logPath === "") {
    return () => {};
  }

  return (chunk, state) => {
    const line = `${new Date().toISOString()} hex=${chunkHex(chunk)} printable=${JSON.stringify(chunkPrintable(chunk))} ${summarizeInputState(state)}\n`;
    void appendFile(logPath, line).catch(() => {});
  };
}
