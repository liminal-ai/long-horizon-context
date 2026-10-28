import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AssembledContextMessage } from "./render.js";

export const PI_SESSION_VERSION = 3;

export interface MaterializeEntry {
  message: AssembledContextMessage;
  entryId: string;
  timestamp: string;
}

export interface MaterializeInput {
  threadId: string;
  headerTimestamp: string;
  cwd: string;
  entries: readonly MaterializeEntry[];
}

export function renderPiSessionLines(input: MaterializeInput): string[] {
  const lines: string[] = [
    JSON.stringify({
      type: "session",
      version: PI_SESSION_VERSION,
      id: `${input.threadId}:${input.headerTimestamp}`,
      timestamp: input.headerTimestamp,
      cwd: input.cwd,
    }),
  ];
  let parentId: string | null = null;
  for (const entry of input.entries) {
    lines.push(
      JSON.stringify({
        type: "message",
        id: entry.entryId,
        parentId,
        timestamp: entry.timestamp,
        message: {
          role: entry.message.role,
          content: [{ type: "text", text: entry.message.content }],
        },
      }),
    );
    parentId = entry.entryId;
  }
  return lines;
}

export function writePiSessionFile(input: MaterializeInput, path: string): { writtenPath: string } {
  const writtenPath = resolve(path);
  writeFileSync(writtenPath, `${renderPiSessionLines(input).join("\n")}\n`);
  return { writtenPath };
}
