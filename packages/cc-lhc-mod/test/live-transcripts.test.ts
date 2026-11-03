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

const recovered = async (name: string): Promise<string[]> => {
  writeTranscript(h, fixture(name) as never);
  return messages(await recorder(h));
};

it("recovers a claude -p prompt, which carries no origin, as the person's prompt", async () => {
  expect((await recovered("print-mode-transcript.jsonl")).filter((m) => m.includes("user_prompt"))).toEqual([
    "t1 user_prompt Reply with just PONG.",
  ]);
});

it("recovers an old-session prompt with no origin field as the person's prompt", () => {
  const [line] = fixture("old-session-prompt.jsonl");

  const [event] = mapEntries(line === undefined ? [] : [rowOf(line)].flatMap((row) => row ?? []), SETTLED).events;

  expect(event?.eventKind).toBe("user_prompt");
});

it("records /model as one short note, without its caveat or output rows", async () => {
  const notes = (await recovered("model-command-transcript.jsonl")).filter((m) => m.includes("runtime_note"));

  expect(notes.map((m) => m.slice(m.indexOf("runtime_note")))).toEqual(["runtime_note /model sonnet"]);
});

it("records a skill command as one short note, without the skill's expanded body", async () => {
  const notes = (await recovered("skill-command-transcript.jsonl")).filter((m) => m.includes("runtime_note"));

  expect(notes.map((m) => m.slice(m.indexOf("runtime_note")))).toEqual(["runtime_note /bro"]);
});

it("maps live command rows to the same one note as recovery", () => {
  const rows = fixture("model-command-transcript.jsonl").flatMap((line) => rowOf(line) ?? []);
  const live = rows.map((row) => (row.door === "command" ? { ...row, origin: "unclassified" } : row));

  const notes = mapEntries(live, SETTLED).events.filter((event) => event.eventKind === "runtime_note");

  expect(notes.map((event) => (event.payload as { text: string }).text)).toEqual(["/model sonnet"]);
});
