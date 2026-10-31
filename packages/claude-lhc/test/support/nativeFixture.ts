import { readFileSync } from "node:fs";
import type { NativeEntry } from "../../src/projection/project.ts";

const RESTAMPED_FIELDS = new Set([
  "parentUuid",
  "isSidechain",
  "userType",
  "entrypoint",
  "cwd",
  "sessionId",
  "version",
  "gitBranch",
  "timestamp",
  "uuid",
]);

export interface FixtureGeneration {
  readonly sessionId: string;
  readonly lines: NativeEntry[];
}

export function fixtureGenerations(): { first: FixtureGeneration; resumed: FixtureGeneration } {
  const generations: FixtureGeneration[] = [];
  const body = readFileSync(new URL("../fixtures/native-attachments.jsonl", import.meta.url), "utf8");
  for (const raw of body.split("\n").filter(Boolean)) {
    const line = JSON.parse(raw) as NativeEntry;
    const sessionId = String(line["sessionId"]);
    if (generations.at(-1)?.sessionId !== sessionId) generations.push({ sessionId, lines: [] });
    generations.at(-1)?.lines.push(line);
  }
  const [first, second] = generations;
  if (generations.length !== 2 || first === undefined || second === undefined)
    throw new Error(`native-attachments.jsonl holds ${generations.length} generations, not 2`);
  return { first, resumed: second };
}

export function withoutRestampedFields(line: NativeEntry): NativeEntry {
  return Object.fromEntries(Object.entries(line).filter(([key]) => !RESTAMPED_FIELDS.has(key)));
}

export const jsonl = (lines: readonly NativeEntry[]): string =>
  lines.map((line) => `${JSON.stringify(line)}\n`).join("");
