import { afterEach, beforeEach, expect, it } from "vitest";
import { answerCompact } from "../sidecar/src/compact.ts";
import { type Harness, harness, messages, recorder, Script, SESSION, writeTranscript } from "./fixture.ts";

let h: Harness;
beforeEach(() => {
  h = harness();
});
afterEach(() => h.cleanup());

async function prepared() {
  const script = new Script();
  script.toolTurn("turn-1", "check the build", "toolu_a");
  writeTranscript(h, script.lines);
  const r = await recorder(h);
  await r.capture(script.entries);
  const answer = await answerCompact(r, { sessionId: SESSION, trigger: "manual", target: 10_000 }, () => {});
  if (answer.kind !== "view") throw new Error(answer.reason);
  expect(answer.messages[0]?.text).toBe("check the build");
  return { script, r, built: answer.messages };
}

it("keeps a repeated real prompt when a compact answer was never installed", async () => {
  const { script, r } = await prepared();
  const from = script.entries.length;
  const repeated = script.prompt("check the build");
  writeTranscript(h, script.lines);
  await r.capture(script.entries.slice(from));
  await r.recover();
  const after = await messages(r);
  expect(r.receipts.current?.claimed ?? []).not.toContain(repeated);
  expect(after.filter((m) => m.includes("user_prompt"))).toEqual([
    "t1 user_prompt check the build",
    "t2 user_prompt check the build",
  ]);
});

it("keeps a repeated real prompt delivered before manual install append hooks", async () => {
  const { script, r, built } = await prepared();
  const from = script.entries.length;
  script.compactBoundary();
  script.installed(built);
  const repeated = script.prompt("check the build");
  writeTranscript(h, script.lines);
  const raised = script.entries.slice(from);
  await r.capture([...raised.slice(-1), ...raised.slice(0, -1)]);
  await r.recover();
  const after = await messages(r);
  expect(r.receipts.current?.claimed ?? []).not.toContain(repeated);
  expect(after.filter((m) => m.includes("user_prompt"))).toEqual([
    "t1 user_prompt check the build",
    "t2 user_prompt check the build",
  ]);
});

it("claims an unmarked installed row in recovery, and never a claude -p prompt repeating it", async () => {
  const { script, r, built } = await prepared();
  r.release();
  script.compactBoundary();
  script.installed(built);
  const typed = script.prompt("check the build");
  const line = script.lines.find((candidate) => candidate.uuid === typed);
  if (line === undefined) throw new Error("prompt line missing");
  line.promptSource = "sdk";
  writeTranscript(h, script.lines);

  const restarted = await recorder(h);

  expect(restarted.receipts.current?.claimed).toHaveLength(built.length);
  expect(restarted.receipts.current?.claimed).not.toContain(typed);
  expect((await messages(restarted)).filter((m) => m.includes("user_prompt"))).toEqual([
    "t1 user_prompt check the build",
    "t2 user_prompt check the build",
  ]);
});
