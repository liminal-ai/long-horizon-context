import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Recorder } from "../sidecar/src/capture/recorder.ts";
import { answerCompact } from "../sidecar/src/compact.ts";
import type { BuiltMessage } from "../src/compact.ts";
import { type Harness, harness, messages, recorder, Script, SESSION, writeTranscript } from "./fixture.ts";

let h: Harness;
beforeEach(() => {
  h = harness();
});
afterEach(() => h.cleanup());

/** A role-less system row (turn_duration, informational) as live `session.append` delivers it. */
function liveSystem(script: Script, subtype: string): string {
  const uuid = script.system(subtype);
  script.entries.push({
    kind: "row",
    sessionId: SESSION,
    uuid,
    door: "system",
    origin: "engine",
    message: { type: "system", content: [] },
    at: Date.now(),
  });
  return uuid;
}

async function compacted(script: Script): Promise<{ r: Recorder; built: BuiltMessage[] }> {
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

describe("install receipt claims", () => {
  it("claims only installed rows, not role-less rows that follow the install", async () => {
    const script = new Script();
    const { r, built } = await compacted(script);
    const from = script.entries.length;
    script.compactBoundary();
    script.installed(built);
    script.step("turn-3", 1);
    const after = liveSystem(script, "informational");
    await r.capture(script.entries.slice(from));

    expect(r.receipts.current?.claimed).toHaveLength(built.length);
    expect(r.receipts.current?.claimed).not.toContain(after);
  });

  it("a rewind to the prompt after a post-install turn keeps that turn's post-compact work", async () => {
    const script = new Script();
    const { r, built } = await compacted(script);
    const from = script.entries.length;
    script.compactBoundary();
    script.installed(built);
    script.step("turn-3", 1);
    script.answer({ type: "tool_use", id: "toolu_d", name: "Bash", input: { command: "d" } });
    script.results("toolu_d");
    script.answer({ type: "text", text: "third done" });
    script.entries.push({
      kind: "turn-end",
      sessionId: SESSION,
      turnId: "turn-3",
      isAborted: false,
      reason: "answer",
      at: Date.now(),
    });
    const endOfThird = liveSystem(script, "turn_duration");
    script.prompt("fourth");
    script.turnStart("turn-4");
    script.answer({ type: "text", text: "fourth done" });
    script.turnEnd("turn-4");
    script.rewindTo(endOfThird);
    script.prompt("fourth, again");
    writeTranscript(h, script.lines);
    await r.capture(script.entries.slice(from));

    const kept = await messages(r);
    expect(kept).not.toContain("t4 user_prompt fourth");
    expect(kept).toContain("t3 tool_call toolu_d");
    expect(kept).toContain("t3 assistant_text third done");
  });

  it("rolls back the first prompt after a manual install when the installed rows reach only the transcript", async () => {
    // Live 2.1.317: after a manual /compact the installed rows are in the transcript but no session.append carries them.
    const script = new Script();
    script.toolTurn("turn-1", "first", "toolu_a");
    const r = await recorder(h);
    writeTranscript(h, script.lines);
    await r.capture(script.entries);
    const answer = await answerCompact(r, { sessionId: SESSION, trigger: "manual", target: 10_000 }, (line) =>
      h.log.push(line),
    );
    if (answer.kind !== "view") throw new Error(answer.reason);
    script.compactBoundary();
    const rows = script.installed(answer.messages);
    const live = script.entries.length;
    script.prompt("second");
    script.turnStart("turn-2");
    script.answer({ type: "text", text: "second done" });
    script.turnEnd("turn-2");
    const last = rows.at(-1);
    if (last === undefined) throw new Error("no install rows");
    script.rewindTo(last);
    script.prompt("second, again");
    writeTranscript(h, script.lines);
    await r.capture(script.entries.slice(live));

    const kept = await messages(r);
    expect(kept).not.toContain("t2 user_prompt second");
    expect(kept.at(-1)).toMatch(/ user_prompt second, again$/);
  });
});
