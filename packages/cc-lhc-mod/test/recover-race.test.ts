import { afterEach, beforeEach, expect, it } from "vitest";
import { type Harness, harness, messages, Script, SESSION, type Served, serve, writeTranscript } from "./fixture.ts";

let h: Harness;
let s: Served;
beforeEach(async () => {
  h = harness();
  s = await serve(h);
});
afterEach(async () => {
  await s.close();
  h.cleanup();
});

// From a live run: Prune pressed mid-turn runs /compact the instant the turn ends, and its
// recover() reads a transcript that does not yet hold the turn's last response or turn_duration.
it("a recover that reads a transcript behind live capture leaves a turn the recorder ended settled", async () => {
  writeTranscript(h, []);
  await s.call("/bind", { sessionId: SESSION, transcriptPath: h.transcript, source: "startup" });
  const script = new Script();
  script.prompt("read the files");
  script.turnStart("turn-1");
  script.step("turn-1", 0);
  script.answer({ type: "tool_use", id: "toolu_a", name: "Read", input: { file_path: "f1.txt" } });
  script.results("toolu_a");
  const written = script.lines.length;
  script.step("turn-1", 1);
  script.answer({ type: "text", text: "last words" });
  script.turnEnd("turn-1");
  await s.call("/capture", { entries: script.entries });
  if (s.state.recording?.kind !== "recording") throw new Error("not recording");
  const recorder = s.state.recording.recorder;
  expect(recorder.isTurnOpen).toBe(false);

  writeTranscript(h, script.lines.slice(0, written));
  await recorder.recover();
  expect(recorder.isTurnOpen).toBe(false);

  const from = script.entries.length;
  script.toolTurn("turn-2", "reply with ok", "toolu_b");
  writeTranscript(h, script.lines);
  await s.call("/capture", { entries: script.entries.slice(from) });
  expect((await messages(recorder)).filter((line) => line.includes("reply with ok"))).toEqual([
    "t2 user_prompt reply with ok",
  ]);
});
