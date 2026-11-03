import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  events,
  type Harness,
  harness,
  messages,
  record,
  recorder,
  Script,
  SESSION,
  writeTranscript,
} from "./fixture.ts";

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

it("a recovered claude -p turn, which has no duration row, is settled so the next prompt opens a turn", async () => {
  const lines = readFileSync(join(import.meta.dirname, "fixtures", "print-mode-transcript.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown> & { uuid: string; parentUuid: string | null });
  writeTranscript(h, lines);
  const r = await recorder(h);
  const next = new Script();
  next.rewindTo(lines.at(-1)?.uuid ?? "");
  next.prompt("an independent next prompt");
  writeTranscript(h, [...lines, ...next.lines]);

  await r.capture(next.entries);

  expect(r.isTurnOpen).toBe(false);
  expect(await messages(r)).toEqual([
    "t1 user_prompt Reply with just PONG.",
    "t1 assistant_text PONG",
    "t2 user_prompt an independent next prompt",
  ]);
});

it("recovery settles a turn a crash interrupted before the next prompt opens its own", async () => {
  const script = runningTurn(1);
  script.prompt("after the crash");
  writeTranscript(h, script.lines);

  const r = await recorder(h);

  expect((await messages(r)).filter((m) => m.includes("user_prompt"))).toEqual([
    "t1 user_prompt read these files and continue working",
    "t2 user_prompt after the crash",
  ]);
});

for (const via of ["typed", "print"] as const) {
  it(`a ${via} prompt after exiting mid-tool and resuming opens its own turn`, async () => {
    const script = new Script();
    script.prompt("run the long command");
    script.turnStart("running");
    script.step("running", 0);
    script.answer({ type: "tool_use", id: "toolu_long", name: "Bash", input: { command: "sleep 600" } });
    script.results("toolu_long");
    (script.lines.at(-1)?.message as { content: Array<{ content: string; is_error?: boolean }> }).content[0] = {
      type: "tool_result",
      tool_use_id: "toolu_long",
      content: "Exit code 137",
      is_error: true,
    } as never;
    writeTranscript(h, script.lines);
    const recording = await record(h, "resume");
    if (recording.kind !== "recording") throw new Error(recording.notice);
    const r = recording.recorder;
    expect(r.isTurnOpen).toBe(false);
    const next = new Script();
    next.rewindTo(script.lines.at(-1)?.uuid ?? "");
    const uuid = next.prompt("New task, reply with only NEW-OK.");
    const entries = next.entries.map((entry) =>
      entry.kind === "row" && entry.uuid === uuid && via === "print" ? { ...entry, origin: "unclassified" } : entry,
    );
    writeTranscript(h, [...script.lines, ...next.lines]);

    await r.capture(entries);

    expect((await messages(r)).filter((m) => m.includes("user_prompt"))).toEqual([
      "t1 user_prompt run the long command",
      "t2 user_prompt New task, reply with only NEW-OK.",
    ]);
    const end = (await events(r)).get(`claude-code:turn:${script.turnId("running")}:turn_end`);
    expect(end).toMatchObject({ outcome: "aborted" });
  });
}

it("a hot reload mid-turn keeps the recovered turn open", async () => {
  const script = runningTurn(1);
  writeTranscript(h, script.lines);

  const recording = await record(h, "reload");

  expect(recording.kind === "recording" && recording.recorder.isTurnOpen).toBe(true);
});
