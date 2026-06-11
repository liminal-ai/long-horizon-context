// PI session JSONL writer (Story 5, Flow 5): the pure mapping from pull's
// assembled entries to the pinned PI session file format, plus the file
// write. This module never sees a database handle — it renders what the
// surface's pull assembly hands it, which is what makes AC-5.3's
// materialize↔pull parity structural rather than tested-into-existence
// (must-not-own: materialize never reads the record).
//
// Format pin (tech design §External Contracts, from
// repo-ref/pi/packages/coding-agent/src/core/session-manager.ts): JSONL;
// line 1 is the header `{ type: "session", version, id, timestamp, cwd }`;
// each subsequent line is `{ type: "message", id, parentId, timestamp,
// message: { role, content } }` with parentId chaining each entry to the
// previous (first entry's parentId null). Content is encoded as PI text
// blocks: user content may be a bare string in PI, but assistant content
// must be a block array, so both roles use the one block encoding.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ViewMessage } from "../../../shared/view.js";

// CURRENT_SESSION_VERSION at the pin (PI coding agent 0.79.1) — see
// test/fixtures/pi-session-structure.provenance.md.
export const PI_SESSION_VERSION = 3;

// One pull entry with the metadata the file's generated fields derive from:
// the entry id (message id for tail entries, viewId-band for band entries)
// and the record-time timestamp (event recorded_at for tail entries, view
// created-at for band entries). Never a write-time clock anywhere (AC-5.2 —
// byte-identical repeats are the test for any sneaky Date.now()).
export interface MaterializeEntry {
  message: ViewMessage;
  entryId: string;
  timestamp: string;
}

export interface MaterializeInput {
  threadId: string;
  // The view's created-at, or the thread's created-at when never compacted
  // (viewId null — AC-5.4's tail-only file still carries a valid header).
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

export function writePiSessionFile(
  input: MaterializeInput,
  path: string,
): { writtenPath: string } {
  const writtenPath = resolve(path);
  writeFileSync(writtenPath, `${renderPiSessionLines(input).join("\n")}\n`);
  return { writtenPath };
}
