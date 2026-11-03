import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Entry, Row } from "./capture/map.ts";
import { entriesOf, rowOf, TranscriptTail } from "./capture/transcript.ts";

export type Recovered = { scanned: number; recorded: number; offset: number };

const cursorPath = (home: string, sessionId: string): string => join(home, "cursors", `${sessionId}.json`);

function readCursor(home: string, sessionId: string): number {
  try {
    const { offset } = JSON.parse(readFileSync(cursorPath(home, sessionId), "utf8")) as { offset?: unknown };
    return typeof offset === "number" ? offset : 0;
  } catch {
    return 0;
  }
}

export async function recoverTranscript(input: {
  home: string;
  sessionId: string;
  transcriptPath: string;
  capture: (entries: Entry[]) => Promise<number>;
  isInstalled: (uuid: string) => boolean;
  claimInstalled: (rows: Row[]) => void;
}): Promise<Recovered> {
  const cursor = readCursor(input.home, input.sessionId);
  const tail = new TranscriptTail(input.transcriptPath);
  const lines = tail.read();
  // A row on a branch a rewind left yields no entry, not even its turn's markers.
  const abandoned = new Set([...tail.abandoned().values()].flat());
  // A native compaction's command rows stay out; its summary is recorded as live capture would label it.
  const summaries = new Set(lines.flatMap(({ line }) => (line.isCompactSummary === true ? [line.uuid] : [])));
  const isCommandRow = (uuid: string): boolean => tail.compactionRows.has(uuid) && !summaries.has(uuid);
  // Claim new install rows first, so turns and step indices are rebuilt without them.
  input.claimInstalled(
    lines.flatMap(({ line, end }) => (end > cursor && !abandoned.has(line.uuid) ? (rowOf(line) ?? []) : [])),
  );
  // A row an install receipt claimed, behind the cursor or from an earlier compact, opens no turn either.
  const skip = (uuid: string): boolean => isCommandRow(uuid) || abandoned.has(uuid) || input.isInstalled(uuid);
  const recorded = await input.capture(entriesOf(lines, skip, cursor));
  mkdirSync(join(input.home, "cursors"), { recursive: true });
  writeFileSync(cursorPath(input.home, input.sessionId), JSON.stringify({ offset: tail.offset }));
  return { scanned: lines.filter(({ end }) => end > cursor).length, recorded, offset: tail.offset };
}
