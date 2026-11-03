import { afterEach, beforeEach, expect, it } from "vitest";
import { events, type Harness, harness, messages, recorder, Script, writeTranscript } from "./fixture.ts";

let h: Harness;
beforeEach(() => {
  h = harness();
});
afterEach(() => h.cleanup());

it("rolls back to the last recorded row before the rewound prompt", async () => {
  const script = new Script();
  script.toolTurn("turn-1", "first", "toolu_a");
  const anchor = script.lines.at(-1)?.uuid ?? "";
  script.toolTurn("turn-2", "second", "toolu_b");
  script.rewindTo(anchor);
  const third = script.prompt("third");
  script.turnStart("turn-3");
  script.step("turn-3", 0);
  script.answer({ type: "text", text: "done turn-3" });
  script.turnEnd("turn-3");
  const r = await recorder(h);
  writeTranscript(h, script.lines);

  await r.capture(script.entries);

  expect(await messages(r)).toEqual([
    "t1 user_prompt first",
    "t1 tool_call toolu_a",
    "t1 tool_result toolu_a",
    "t1 assistant_text done turn-1",
    "t3 user_prompt third",
    "t3 assistant_text done turn-3",
  ]);
  const rollback = (await events(r)).get(`claude-code:${third}:rollback`);
  const all = await r.deps.lhc.intakeStream.listEvents(r.thread);
  const firstAnswer = all.ok
    ? all.value.find((event) => event.payload && (event.payload as { text?: string }).text === "done turn-1")
    : undefined;
  expect(rollback).toBeDefined();
  expect(firstAnswer).toBeDefined();
  expect(rollback?.keepThroughEventOrder).toBe(firstAnswer?.eventOrder);
});

it("writes no rollback when the prompt follows the end of the record", async () => {
  const script = new Script();
  script.toolTurn("turn-1", "first", "toolu_a");
  script.toolTurn("turn-2", "second", "toolu_b");
  const r = await recorder(h);
  writeTranscript(h, script.lines);

  await r.capture(script.entries);

  expect([...(await events(r)).keys()].filter((key) => key.endsWith(":rollback"))).toEqual([]);
});

it("rolls back a rewind that only recovery sees, after a restart", async () => {
  const script = new Script();
  script.toolTurn("turn-1", "first", "toolu_a");
  const anchor = script.lines.at(-1)?.uuid ?? "";
  script.toolTurn("turn-2", "second", "toolu_b");
  const live = script.entries.length;
  script.rewindTo(anchor);
  script.prompt("third");
  const first = await recorder(h);
  writeTranscript(h, script.lines);
  await first.capture(script.entries.slice(0, live));
  first.release();

  const restarted = await recorder(h);

  expect(await messages(restarted)).toEqual([
    "t1 user_prompt first",
    "t1 tool_call toolu_a",
    "t1 tool_result toolu_a",
    "t1 assistant_text done turn-1",
    "t3 user_prompt third",
  ]);
});

it("writes no rollback for the first prompt after a native compaction", async () => {
  const script = new Script();
  script.toolTurn("turn-1", "first", "toolu_a");
  script.nativeCompaction();
  script.toolTurn("turn-2", "second", "toolu_b");
  const r = await recorder(h);
  writeTranscript(h, script.lines);

  await r.capture(script.entries);

  expect([...(await events(r)).keys()].filter((key) => key.endsWith(":rollback"))).toEqual([]);
  expect((await messages(r)).some((message) => message.endsWith("runtime_note /compact"))).toBe(true);
  expect(await messages(r)).toHaveLength(9);
});

it("rolls back a rewind whose new prompt only recovery records, though its answer was recorded live", async () => {
  const script = new Script();
  script.toolTurn("turn-1", "first", "toolu_a");
  const anchor = script.lines.at(-1)?.uuid ?? "";
  script.toolTurn("turn-2", "discarded", "toolu_b");
  const original = script.entries.length;
  script.rewindTo(anchor);
  const prompt = script.prompt("replacement");
  script.turnStart("turn-3");
  script.answer({ type: "text", text: "replacement answer" });
  script.turnEnd("turn-3");
  const live = await recorder(h);
  writeTranscript(h, script.lines);
  await live.capture(script.entries.slice(0, original));
  await live.capture(script.entries.slice(original).filter((entry) => entry.kind !== "row" || entry.uuid !== prompt));
  live.release();

  const next = await recorder(h);

  expect([...(await events(next)).keys()]).toContain(`claude-code:${prompt}:rollback`);
  expect((await messages(next)).some((message) => message.includes("discarded"))).toBe(false);
});
