import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CaptureEntry } from "../../src/capture.ts";
import { rowOf, TranscriptTail } from "./capture/transcript.ts";

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
  capture: (rows: CaptureEntry[]) => Promise<number>;
}): Promise<Recovered> {
  const tail = new TranscriptTail(input.transcriptPath, readCursor(input.home, input.sessionId));
  const lines = tail.read();
  const rows = lines.flatMap(({ line }) => (tail.compactionRows.has(line.uuid) ? [] : (rowOf(line) ?? [])));
  const recorded = await input.capture(rows);
  mkdirSync(join(input.home, "cursors"), { recursive: true });
  writeFileSync(cursorPath(input.home, input.sessionId), JSON.stringify({ offset: tail.offset }));
  return { scanned: lines.length, recorded, offset: tail.offset };
}
