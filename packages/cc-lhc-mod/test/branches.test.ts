import { afterEach, beforeEach, expect, it } from "vitest";
import { mapEntries, SETTLED } from "../sidecar/src/capture/map.ts";
import { rowOf, type TranscriptLine } from "../sidecar/src/capture/transcript.ts";
import { events, type Harness, harness, messages, recorder, Script, writeTranscript } from "./fixture.ts";

let h: Harness;
beforeEach(() => {
  h = harness();
});
afterEach(() => h.cleanup());
const rollbacks = async (r: Awaited<ReturnType<typeof recorder>>) =>
  [...(await events(r)).keys()].filter((k) => k.endsWith(":rollback"));
const human = async (r: Awaited<ReturnType<typeof recorder>>) =>
  (await messages(r)).filter((x) => x.includes("user_prompt"));
it("round2: rewind to first prompt removes all prior turns", async () => {
  const s = new Script();
  s.toolTurn("a", "old first", "a");
  s.toolTurn("b", "old second", "b");
  const _old = s.entries.length;
  const r = await recorder(h);
  writeTranscript(h, s.lines);
  await r.capture(s.entries);
  const newer = new Script();
  newer.toolTurn("c", "replacement first", "c");
  writeTranscript(h, [...s.lines, ...newer.lines]);
  await r.capture(newer.entries);
  expect(await human(r)).toEqual(["t3 user_prompt replacement first"]);
  expect((await events(r)).get(`claude-code:${newer.lines[0]?.uuid}:rollback`)).toMatchObject({
    keepThroughEventOrder: 0,
  });
});
it("round2: two rewinds in succession keep only the final replacement", async () => {
  const s = new Script();
  s.toolTurn("a", "first", "a");
  const anchor = s.lines.at(-1)!.uuid;
  s.toolTurn("b", "discarded second", "b");
  const r = await recorder(h);
  writeTranscript(h, s.lines);
  await r.capture(s.entries);
  for (const [i, text] of [
    ["c", "discarded replacement"],
    ["d", "final replacement"],
  ] as const) {
    const n = s.entries.length;
    s.rewindTo(anchor);
    s.toolTurn(i, text, i);
    writeTranscript(h, s.lines);
    await r.capture(s.entries.slice(n));
  }
  expect(await human(r)).toEqual(["t1 user_prompt first", "t4 user_prompt final replacement"]);
  expect(await rollbacks(r)).toHaveLength(2);
  r.release();
  const next = await recorder(h);
  expect(await human(next)).toEqual(await human(r));
  expect(await rollbacks(next)).toHaveLength(2);
});
it("round2: rewind after compact keeps the compacted history and post-compact anchor", async () => {
  const s = new Script();
  s.toolTurn("a", "before compact", "a");
  s.nativeCompaction();
  s.toolTurn("b", "after compact", "b");
  const anchor = s.lines.at(-1)!.uuid;
  s.toolTurn("c", "discarded", "c");
  const n = s.entries.length;
  const r = await recorder(h);
  writeTranscript(h, s.lines);
  await r.capture(s.entries);
  s.rewindTo(anchor);
  s.toolTurn("d", "replacement", "d");
  writeTranscript(h, s.lines);
  await r.capture(s.entries.slice(n));
  expect((await human(r)).map((x) => x.split("user_prompt ")[1])).toEqual([
    "before compact",
    "after compact",
    "replacement",
  ]);
  expect(await rollbacks(r)).toHaveLength(1);
});
it("round2: rewind to first prompt after compact discards that turn", async () => {
  const s = new Script();
  s.toolTurn("a", "before compact", "a");
  s.nativeCompaction();
  const anchor = s.lines.at(-1)!.uuid;
  s.toolTurn("b", "discarded first after compact", "b");
  const n = s.entries.length;
  const r = await recorder(h);
  writeTranscript(h, s.lines);
  await r.capture(s.entries);
  s.rewindTo(anchor);
  s.toolTurn("c", "replacement after compact", "c");
  writeTranscript(h, s.lines);
  await r.capture(s.entries.slice(n));

  expect((await human(r)).map((x) => x.split("user_prompt ")[1])).toEqual([
    "before compact",
    "replacement after compact",
  ]);
});
it("round2: parallel sibling calls do not roll back on the following prompt live or recovered", async () => {
  const s = new Script();
  s.prompt("parallel");
  s.turnStart("a");
  const parent = s.lines.at(-1)!.uuid;
  s.answer({ type: "tool_use", id: "a", name: "Bash", input: { command: "a" } });
  s.results("a");
  s.rewindTo(parent);
  s.answer({ type: "tool_use", id: "b", name: "Bash", input: { command: "b" } });
  s.results("b");
  s.answer({ type: "text", text: "both finished" });
  s.turnEnd("a");
  s.toolTurn("c", "next", "c");
  const r = await recorder(h);
  writeTranscript(h, s.lines);
  await r.capture(s.entries);
  expect(await rollbacks(r)).toEqual([]);
  const want = await messages(r);
  r.release();
  const next = await recorder(h);
  expect(await messages(next)).toEqual(want);
  expect(await rollbacks(next)).toEqual([]);
});
it("round2: accepted recovery-only rewind hides later live rows and replay cannot restore them", async () => {
  const s = new Script();
  s.toolTurn("a", "first", "a");
  const anchor = s.lines.at(-1)!.uuid;
  s.toolTurn("b", "discarded", "b");
  const [linesBefore, n] = [s.lines.length, s.entries.length];
  s.rewindTo(anchor);
  const p = s.prompt("missed replacement");
  s.turnStart("c");
  s.answer({ type: "text", text: "replacement answer" });
  s.turnEnd("c");
  s.toolTurn("d", "later live prompt", "d");
  const r = await recorder(h);
  writeTranscript(h, s.lines.slice(0, linesBefore));
  await r.capture(s.entries.slice(0, n));
  writeTranscript(h, s.lines);
  await r.capture(s.entries.slice(n).filter((e) => e.kind !== "row" || e.uuid !== p));
  r.release();
  const next = await recorder(h);
  expect((await human(next)).map((x) => x.split("user_prompt ")[1])).toEqual(["first", "missed replacement"]);
  expect((await messages(next)).some((x) => x.includes("replacement answer"))).toBe(false);
  const before = await messages(next);
  await next.recover();
  await next.capture(s.entries);
  expect(await messages(next)).toEqual(before);
});
it("round2: linear missing prompt is backfill and preserves later live rows", async () => {
  const s = new Script();
  s.toolTurn("a", "first", "a");
  const n = s.entries.length;
  const p = s.prompt("missed linear");
  s.turnStart("b");
  s.answer({ type: "text", text: "linear answer" });
  s.turnEnd("b");
  s.toolTurn("c", "later live", "c");
  const r = await recorder(h);
  writeTranscript(h, s.lines);
  await r.capture(s.entries.slice(0, n));
  await r.capture(s.entries.slice(n).filter((e) => e.kind !== "row" || e.uuid !== p));
  r.release();
  const next = await recorder(h);
  expect(await rollbacks(next)).toEqual([]);
  expect((await messages(next)).some((x) => x.includes("linear answer"))).toBe(true);
  expect(await human(next)).toHaveLength(3);
});
it("round2: classification distinguishes human quote, delivery metadata, commandMode fallback and slash note", () => {
  const s = new Script();
  s.steer("explain <task-notification>quoted</task-notification> please");
  s.delivery("origin only");
  s.delivery("mode only");
  delete (s.lines[1]?.attachment as Record<string, unknown>).commandMode;
  delete (s.lines[2]?.attachment as Record<string, unknown>).origin;
  s.lines.push({
    uuid: "slash",
    parentUuid: s.lines.at(-1)!.uuid,
    type: "user",
    message: { role: "user", content: "<command-message>help</command-message>\n<command-name>/help</command-name>" },
  });
  const recovered = s.lines.flatMap((x) => rowOf(x as TranscriptLine) ?? []);
  const result = mapEntries(recovered, SETTLED).events;
  expect(result.map((x) => x.eventKind)).toEqual(["user_prompt", "runtime_note", "runtime_note", "runtime_note"]);
  expect(result[0]?.payload).toMatchObject({
    text: "explain <task-notification>quoted</task-notification> please",
    steer: true,
  });
  const live = mapEntries(s.entries, SETTLED).events;
  expect(live.map((x) => x.eventKind)).toEqual(["user_prompt", "runtime_note", "runtime_note"]);
});
it("round2: queue door is omitted; a queued composer prompt is retained once as a steer", () => {
  const s = new Script();
  s.queued("typed during turn");
  s.steer("typed during turn");
  const result = mapEntries(s.entries, { isOpen: true, step: 0 }).events;
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ eventKind: "user_prompt", payload: { steer: true } });
});
it("round2: recovering a missed prompt on an abandoned branch must not resurrect it after a live rewind", async () => {
  const s = new Script();
  s.toolTurn("a", "first", "a");
  const anchor = s.lines.at(-1)!.uuid;
  const missed = s.prompt("missed discarded");
  s.turnStart("b");
  s.answer({ type: "text", text: "discarded answer" });
  s.turnEnd("b");
  const before = s.entries.length;
  const r = await recorder(h);
  writeTranscript(h, s.lines);
  await r.capture(s.entries.filter((e) => e.kind !== "row" || e.uuid !== missed));
  s.rewindTo(anchor);
  s.toolTurn("c", "replacement", "c");
  writeTranscript(h, s.lines);
  await r.capture(s.entries.slice(before));
  expect((await human(r)).map((x) => x.split("user_prompt ")[1])).toEqual(["first", "replacement"]);
  r.release();
  const next = await recorder(h);

  expect((await human(next)).map((x) => x.split("user_prompt ")[1])).toEqual(["first", "replacement"]);
});
it("round2: second live rewind does not let recovery resurrect a missed first replacement", async () => {
  const s = new Script();
  s.toolTurn("a", "first", "a");
  const anchor = s.lines.at(-1)!.uuid;
  s.toolTurn("b", "discarded", "b");
  const n = s.entries.length;
  s.rewindTo(anchor);
  const missed = s.prompt("missed first replacement");
  s.turnStart("c");
  s.answer({ type: "text", text: "first replacement answer" });
  s.turnEnd("c");
  const r = await recorder(h);
  writeTranscript(h, s.lines);
  await r.capture(s.entries.slice(0, n));
  await r.capture(s.entries.slice(n).filter((e) => e.kind !== "row" || e.uuid !== missed));
  const before = s.entries.length;
  s.rewindTo(anchor);
  s.toolTurn("d", "second replacement", "d");
  writeTranscript(h, s.lines);
  await r.capture(s.entries.slice(before));
  expect((await human(r)).map((x) => x.split("user_prompt ")[1])).toEqual(["first", "second replacement"]);
  r.release();
  const next = await recorder(h);

  expect((await human(next)).map((x) => x.split("user_prompt ")[1])).toEqual(["first", "second replacement"]);
});

it("recovery rolls back a rewind made before the latest compaction", async () => {
  const s = new Script();
  s.toolTurn("a", "first", "a");
  const anchor = s.lines.at(-1)?.uuid ?? "";
  s.toolTurn("b", "discarded", "b");
  const [linesBefore, discarded] = [s.lines.length, s.entries.length];
  s.rewindTo(anchor);
  s.toolTurn("c", "replacement", "c");
  s.nativeCompaction();
  s.toolTurn("d", "after compact", "d");
  const r = await recorder(h);
  writeTranscript(h, s.lines.slice(0, linesBefore));
  await r.capture(s.entries.slice(0, discarded));
  r.release();
  writeTranscript(h, s.lines);

  const next = await recorder(h);

  expect((await human(next)).map((x) => x.split("user_prompt ")[1])).toEqual(["first", "replacement", "after compact"]);
  expect(await rollbacks(next)).toHaveLength(1);
});

it("a replayed outbox cannot record a turn that a rewind discarded while the sidecar was down", async () => {
  const s = new Script();
  s.toolTurn("a", "first", "a");
  const anchor = s.lines.at(-1)?.uuid ?? "";
  const kept = s.entries.length;
  s.toolTurn("b", "discarded", "b");
  const outbox = s.entries.slice(kept);
  s.rewindTo(anchor);
  s.toolTurn("c", "replacement", "c");
  const r = await recorder(h);
  writeTranscript(h, s.lines);
  await r.capture(s.entries.slice(0, kept));
  r.release();

  const next = await recorder(h);
  await next.capture(outbox);

  expect((await human(next)).map((x) => x.split("user_prompt ")[1])).toEqual(["first", "replacement"]);
  expect((await messages(next)).some((x) => x.includes("discarded"))).toBe(false);
});
