import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Row } from "../sidecar/src/capture/map.ts";
import { NATIVE_SUMMARY_LABEL } from "../sidecar/src/capture/map.ts";
import type { Recorder } from "../sidecar/src/capture/recorder.ts";
import { answerCompact } from "../sidecar/src/compact.ts";
import { fingerprintOf, Receipts } from "../sidecar/src/receipts.ts";
import type { BuiltMessage } from "../src/compact.ts";
import { events, type Harness, harness, messages, recorder, Script, SESSION, writeTranscript } from "./fixture.ts";

let h: Harness;
beforeEach(() => {
  h = harness();
});
afterEach(() => h.cleanup());

async function threeTurnsCompactedMidTurn(script: Script): Promise<{ r: Recorder; built: BuiltMessage[] }> {
  script.toolTurn("turn-1", "first", "toolu_a");
  script.toolTurn("turn-2", "second", "toolu_b");
  script.prompt("third");
  script.turnStart("turn-3");
  script.step("turn-3", 0);
  script.answer({ type: "tool_use", id: "toolu_c", name: "Bash", input: { command: "c" } });
  script.results("toolu_c");
  const r = await recorder(h);
  writeTranscript(h, script.lines);
  await r.capture(script.entries);
  const answer = await answerCompact(r, { sessionId: SESSION, trigger: "auto", target: 10_000 }, (line) =>
    h.log.push(line),
  );
  if (answer.kind !== "view") throw new Error(answer.reason);
  return { r, built: answer.messages };
}

describe("install receipts", () => {
  it("records none of the installed rows, and keeps a task delivery that lands between them", async () => {
    const script = new Script();
    const { r, built } = await threeTurnsCompactedMidTurn(script);
    const before = await messages(r);
    const from = script.entries.length;

    script.compactBoundary();
    script.installed(built.slice(0, 1));
    script.notification("<task-notification>job 7 done</task-notification>");
    script.installed(built.slice(1));
    writeTranscript(h, script.lines);
    await r.capture(script.entries.slice(from));
    await r.recover();

    expect(r.receipts.current?.claimed).toHaveLength(built.length);
    const after = await messages(r);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(before.length)).toEqual(["t3 runtime_note <task-notification>job 7 done</task-notification>"]);
  });

  it("finds the installed rows in the transcript when the sidecar died between persisting and capturing them", async () => {
    const script = new Script();
    const { r, built } = await threeTurnsCompactedMidTurn(script);
    const before = await messages(r);
    r.release();

    script.compactBoundary();
    script.installed(built);
    script.answer({ type: "text", text: "third done" });
    script.turnEnd("turn-3");
    script.prompt("fourth");
    writeTranscript(h, script.lines);
    const restarted = await recorder(h);

    expect(restarted.receipts.current?.claimed).toHaveLength(built.length);
    expect(await messages(restarted)).toEqual([...before, "t3 assistant_text third done", "t4 user_prompt fourth"]);
  });

  it("claims nothing when the install never reached the transcript", async () => {
    const script = new Script();
    const { r } = await threeTurnsCompactedMidTurn(script);
    const before = await messages(r);
    const from = script.entries.length;

    script.answer({ type: "text", text: "carrying on" });
    writeTranscript(h, script.lines);
    await r.capture(script.entries.slice(from));
    await r.recover();

    expect(r.receipts.current?.claimed).toEqual([]);
    expect(await messages(r)).toEqual([...before, "t3 assistant_text carrying on"]);
  });

  it("leaves a later unrelated boundary to normal capture, and records a native summary as a labeled note", async () => {
    const script = new Script();
    const { r, built } = await threeTurnsCompactedMidTurn(script);
    let from = script.entries.length;
    script.compactBoundary();
    script.installed(built);
    await r.capture(script.entries.slice(from));
    const before = await messages(r);

    from = script.entries.length;
    script.turnEnd("turn-3");
    writeTranscript(h, script.lines);
    await r.capture(script.entries.slice(from));
    from = script.entries.length;
    script.compactBoundary();
    script.nativeSummary("Summary: the user asked for three things.");
    script.installed(built.slice(0, 1));
    script.prompt("fifth");
    writeTranscript(h, script.lines);
    await r.capture(script.entries.slice(from));
    await r.recover();

    const after = await messages(r);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(before.length)).toEqual([
      `t4 runtime_note ${NATIVE_SUMMARY_LABEL}Summary: the user asked for three things.`,
      `t4 runtime_note ${built[0]?.text}`,
      "t5 user_prompt fifth",
    ]);
  });

  it("does not read a prompt after a manual compact as a rewind, though Claude Code raises the installed rows after it", async () => {
    const script = new Script();
    script.toolTurn("turn-1", "first", "toolu_a");
    script.toolTurn("turn-2", "second", "toolu_b");
    const r = await recorder(h);
    writeTranscript(h, script.lines);
    await r.capture(script.entries);
    const answer = await answerCompact(r, { sessionId: SESSION, trigger: "manual", target: 10_000 }, (line) =>
      h.log.push(line),
    );
    if (answer.kind !== "view") throw new Error(answer.reason);
    const before = await messages(r);
    const from = script.entries.length;

    script.compactBoundary();
    script.installed(answer.messages);
    script.prompt("third");
    writeTranscript(h, script.lines);
    const raised = script.entries.slice(from);
    await r.capture([...raised.slice(-1), ...raised.slice(0, -1)]);

    expect(h.log.filter((line) => line.includes("rollback"))).toEqual([]);
    expect(await messages(r)).toEqual([...before, "t3 user_prompt third"]);
  });

  it("never reads a prompt right after a native compaction as a rewind", async () => {
    const script = new Script();
    script.toolTurn("turn-1", "first", "toolu_a");
    const r = await recorder(h);
    writeTranscript(h, script.lines);
    await r.capture(script.entries);
    const from = script.entries.length;

    script.compactBoundary();
    script.nativeSummary("Summary: one turn so far.");
    script.prompt("second");
    writeTranscript(h, script.lines);
    const raised = script.entries.slice(from);
    await r.capture([...raised.slice(-1), ...raised.slice(0, -1)]);

    expect(h.log.filter((line) => line.includes("rollback"))).toEqual([]);
    expect((await messages(r)).filter((m) => m.startsWith("t1 "))).toHaveLength(4);
  });

  it("never reads a prompt after a later native compaction as a rewind to the last LHC view", async () => {
    const script = new Script();
    const { r, built } = await threeTurnsCompactedMidTurn(script);
    let from = script.entries.length;
    script.compactBoundary();
    script.installed(built);
    script.answer({ type: "text", text: "third done" });
    script.turnEnd("turn-3");
    writeTranscript(h, script.lines);
    await r.capture(script.entries.slice(from));
    from = script.entries.length;
    script.prompt("fourth");
    script.turnStart("turn-4");
    script.answer({ type: "text", text: "fourth done" });
    script.turnEnd("turn-4");
    writeTranscript(h, script.lines);
    await r.capture(script.entries.slice(from));
    const before = await messages(r);

    from = script.entries.length;
    script.compactBoundary();
    script.nativeSummary("Summary: four turns.");
    script.prompt("fifth");
    writeTranscript(h, script.lines);
    await r.capture(script.entries.slice(from).filter((entry) => entry.kind !== "row" || entry.door !== "compaction"));

    expect(h.log.filter((line) => line.includes("rollback"))).toEqual([]);
    expect(await messages(r)).toEqual([...before, "t5 user_prompt fifth"]);
  });

  it("rolls back what followed an install when a rewind returns to it", async () => {
    const script = new Script();
    const { r, built } = await threeTurnsCompactedMidTurn(script);
    const from = script.entries.length;
    script.compactBoundary();
    const rows = script.installed(built);
    script.answer({ type: "text", text: "third done" });
    script.turnEnd("turn-3");
    writeTranscript(h, script.lines);
    await r.capture(script.entries.slice(from));
    const later = script.entries.length;
    script.prompt("fourth");
    script.turnStart("turn-4");
    script.answer({ type: "text", text: "fourth done" });
    script.turnEnd("turn-4");
    writeTranscript(h, script.lines);
    await r.capture(script.entries.slice(later));
    expect(await messages(r)).toContain("t4 user_prompt fourth");
    const last = rows.at(-1);
    if (last === undefined) throw new Error("no install rows");
    const rewound = script.entries.length;
    script.rewindTo(last);
    script.prompt("fourth, again");
    writeTranscript(h, script.lines);
    await r.capture(script.entries.slice(rewound));

    const after = await messages(r);
    expect(h.log.some((line) => line.includes("rollback keeps through"))).toBe(true);
    expect(after).not.toContain("t4 user_prompt fourth");
    expect(after.at(-1)).toMatch(/ user_prompt fourth, again$/);
  });
});

describe("recovered install rows and step indices", () => {
  it("number the turn's next response after its earlier steps when the sidecar restarts before capturing the install", async () => {
    const script = new Script();
    script.prompt("read these files and continue working");
    script.turnStart("running");
    for (let index = 0; index < 4; index++) {
      script.step("running", index);
      script.answer({ type: "tool_use", id: `toolu_${index}`, name: "Read", input: { file_path: `${index}.txt` } });
      script.results(`toolu_${index}`);
      const row = script.lines.at(-1);
      (row?.message as { content: Array<{ content: string }> }).content[0]!.content =
        "alpha beta gamma delta epsilon ".repeat(2_000);
    }
    const r = await recorder(h);
    writeTranscript(h, script.lines);
    await r.capture(script.entries);
    const answer = await answerCompact(r, { sessionId: SESSION, trigger: "auto", target: 10_000 }, () => {});
    if (answer.kind !== "view") throw new Error(answer.reason);
    r.release();
    script.compactBoundary();
    script.installed(answer.messages);
    script.answer({ type: "tool_use", id: "toolu_next", name: "Read", input: { file_path: "next.txt" } });
    script.results("toolu_next");
    writeTranscript(h, script.lines);

    const restarted = await recorder(h);

    const call = [...(await events(restarted)).values()].find((payload) => payload.toolCallId === "toolu_next");
    expect(restarted.receipts.current?.claimed).toHaveLength(answer.messages.length);
    expect(call?.stepIndex).toBe(4);
  });
});

describe("rows an earlier install claimed", () => {
  it("stay projection when live capture delivers them after the next install begins", () => {
    const receipts = new Receipts(h.home, SESSION);
    const row = (uuid: string, text: string): Row => ({
      kind: "row",
      sessionId: SESSION,
      uuid,
      door: "note",
      origin: "engine",
      message: { type: "user", role: "user", content: [{ type: "text", text }] },
      at: 0,
    });
    const view = (text: string): BuiltMessage => ({ role: "user", text, toolUses: [] });
    receipts.begin({ sessionId: SESSION, cursor: 0, expected: [fingerprintOf(view("[context · brief]\nfirst view"))] });
    expect(receipts.isProjection(row("install-1", "[context · brief]\nfirst view"))).toBe(true);
    receipts.begin({
      sessionId: SESSION,
      cursor: 0,
      expected: [fingerprintOf(view("[context · brief]\nsecond view"))],
    });

    expect(receipts.isProjection(row("install-1", "[context · brief]\nfirst view"))).toBe(true);
    expect(receipts.current?.claimed).toEqual([]);
  });
});
