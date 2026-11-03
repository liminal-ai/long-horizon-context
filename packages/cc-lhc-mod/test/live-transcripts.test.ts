import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { mapEntries, SETTLED } from "../sidecar/src/capture/map.ts";
import { rowOf, type TranscriptLine } from "../sidecar/src/capture/transcript.ts";
import { events, type Harness, harness, messages, recorder, writeTranscript } from "./fixture.ts";

const fixture = (name: string): TranscriptLine[] =>
  readFileSync(join(import.meta.dirname, "fixtures", name), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as TranscriptLine);

const text = (line: TranscriptLine): string => {
  const content = line.message?.content;
  if (typeof content === "string") return content;
  const first = Array.isArray(content) ? (content[0] as { text?: unknown } | undefined) : undefined;
  return typeof first?.text === "string" ? first.text : "";
};

let h: Harness;
beforeEach(() => {
  h = harness();
});
afterEach(() => h.cleanup());

it("recovers the native /compact line as the runtime note live capture records", () => {
  const lines = fixture("native-compact-transcript.jsonl");
  const exported = JSON.parse(
    readFileSync(join(import.meta.dirname, "fixtures", "native-compact-export.json"), "utf8"),
  ) as {
    turns: Array<{ messages: Array<{ kind: string; blocks: Array<{ content: { text: string | null } }> }> }>;
  };
  const line = lines.find((candidate) => text(candidate) === "/compact");
  const live = exported.turns.flatMap((turn) => turn.messages).find((m) => m.blocks[0]?.content.text === "/compact");
  expect(line).toBeDefined();
  expect(live?.kind).toBe("runtime_note");

  const recovered = mapEntries(line === undefined ? [] : [rowOf(line)].flatMap((row) => row ?? []), SETTLED).events;

  expect(recovered[0]?.eventKind).toBe(live?.kind);
});

it("rolls back the discarded turn when the sidecar dies between a rewind after /compact and the new prompt", async () => {
  const lines = fixture("compact-rewind-kill-transcript.jsonl");
  const replacement = lines.findIndex(
    (line) => line.origin?.kind === "human" && text(line).includes("CLEAN_REPLACEMENT"),
  );
  const before = lines.slice(0, replacement);
  // What the hooks saw before the kill: every row but the summary and the command rows a native compaction writes.
  const summary = before.findIndex((line) => line.isCompactSummary === true);
  const live = before
    .filter((_line, index) => index < summary || index > summary + 3)
    .flatMap((line) => rowOf(line) ?? []);
  const r = await recorder(h);
  writeTranscript(h, before as never);
  await r.capture(live);
  r.release();

  writeTranscript(h, lines as never);
  const next = await recorder(h);

  const prompts = (await messages(next)).filter((message) => message.includes("user_prompt"));
  expect(prompts.some((message) => message.includes("CLEAN_DISCARD"))).toBe(false);
  expect(prompts.some((message) => message.includes("CLEAN_REPLACEMENT"))).toBe(true);
  expect([...(await events(next)).keys()].filter((key) => key.endsWith(":rollback"))).toHaveLength(1);
});
