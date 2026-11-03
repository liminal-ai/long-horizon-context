import { afterEach, beforeEach, expect, it } from "vitest";
import { events, type Harness, harness, recorder, Script, SESSION, writeTranscript } from "./fixture.ts";

let h: Harness;
beforeEach(() => {
  h = harness();
});
afterEach(() => h.cleanup());

function runningTurn(steps: number): Script {
  const script = new Script();
  script.prompt("read these files and continue working");
  script.turnStart("running");
  for (let index = 0; index < steps; index++) {
    script.step("running", index);
    script.answer({ type: "tool_use", id: `toolu_${index}`, name: "Read", input: { file_path: `${index}.txt` } });
    script.results(`toolu_${index}`);
  }
  return script;
}

const stepIndices = async (r: Awaited<ReturnType<typeof recorder>>) =>
  Object.fromEntries(
    [...(await events(r))]
      .filter(([, payload]) => typeof payload.toolCallId === "string")
      .map(([key, payload]) => [key, payload.stepIndex]),
  );

it("a hot-reloaded sidecar knows the turn it recovers is still open", async () => {
  const script = runningTurn(1);
  writeTranscript(h, script.lines);

  const r = await recorder(h);

  expect(r.isTurnOpen).toBe(true);
});

it("a recovered turn that ended is not open", async () => {
  const script = runningTurn(1);
  script.answer({ type: "text", text: "done" });
  script.turnEnd("running");
  writeTranscript(h, script.lines);

  expect((await recorder(h)).isTurnOpen).toBe(false);
});

it("a recovered open turn gets the step indices live capture would have given it", async () => {
  const script = runningTurn(4);
  const live = await recorder(h);
  writeTranscript(h, script.lines);
  await live.capture(script.entries);
  const want = await stepIndices(live);
  live.release();
  const reloaded = harness();
  try {
    writeTranscript(reloaded, script.lines);
    const recovered = await recorder(reloaded);
    await recovered.capture([{ kind: "step", sessionId: SESSION, turnId: "running", index: 4, at: Date.now() }]);

    expect(Object.values(want)).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
    expect(await stepIndices(recovered)).toEqual(want);
    expect(recovered.isTurnOpen).toBe(true);
  } finally {
    reloaded.cleanup();
  }
});
