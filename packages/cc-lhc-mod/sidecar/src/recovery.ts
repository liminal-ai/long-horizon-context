import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Entry } from "./capture/map.ts";
import { entriesOf, TranscriptTail } from "./capture/transcript.ts";

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
}): Promise<Recovered> {
  const cursor = readCursor(input.home, input.sessionId);
  const tail = new TranscriptTail(input.transcriptPath);
  const lines = tail.read();
  // A row a native compaction wrote, or one on a branch a rewind left, yields no entry, not even its turn's markers.
  const abandoned = new Set([...tail.abandoned().values()].flat());
  const skip = (uuid: string): boolean => tail.compactionRows.has(uuid) || abandoned.has(uuid);
  const recorded = await input.capture(entriesOf(lines, skip, cursor));
  mkdirSync(join(input.home, "cursors"), { recursive: true });
  writeFileSync(cursorPath(input.home, input.sessionId), JSON.stringify({ offset: tail.offset }));
  return { scanned: lines.filter(({ end }) => end > cursor).length, recorded, offset: tail.offset };
}
