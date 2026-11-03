import { afterEach, expect, it } from "vitest";
import { answerCompact } from "../sidecar/src/compact.ts";
import { type Harness, harness, messages, recorder, Script, SESSION, writeTranscript } from "./fixture.ts";

const homes: Harness[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) h.cleanup();
});
async function prepared() {
  const h = harness();
  homes.push(h);
  const script = new Script();
  script.toolTurn("one", "check the build", "toolu_a");
  writeTranscript(h, script.lines);
  const r = await recorder(h);
  const before = await messages(r);
  const answer = await answerCompact(r, { sessionId: SESSION, trigger: "manual", target: 140000 }, () => {});
  if (answer.kind !== "view") throw new Error(answer.reason);
  return { h, script, r, before, built: answer.messages };
}
it("two interactive compacts with a compact bind and no prompt between", async () => {
  const { h, script, r, before, built } = await prepared();
  script.compactBoundary();
  script.installed(built);
  writeTranscript(h, script.lines);
  await r.recover(); // classic.SessionStart source=compact
  expect(r.isTurnOpen).toBe(false);
  const second = await answerCompact(r, { sessionId: SESSION, trigger: "manual", target: 140000 }, () => {});
  expect(await messages(r)).toEqual(before);
  expect(second.kind).toBe("view");
  expect(second.kind === "view" && second.isMidTurn).toBe(false);
});
it("crash between persist and install preserves a repeated -p prompt on resume", async () => {
  const { h, script, r } = await prepared();
  r.release();
  const id = script.prompt("check the build");
  const line = script.lines.find((x) => x.uuid === id)!;
  delete line.origin;
  line.promptSource = "sdk";
  writeTranscript(h, script.lines);
  const resumed = await recorder(h);
  expect(resumed.receipts.current?.claimed).not.toContain(id);
  expect((await messages(resumed)).filter((x) => x.includes("user_prompt"))).toHaveLength(2);
});
it("legacy unmarked prompts after an installed view stay prompts", async () => {
  const { h, script, r, built } = await prepared();
  script.compactBoundary();
  script.installed(built);
  script.toolTurn("two", "old unmarked next prompt", "toolu_b");
  script.toolTurn("three", "check the build", "toolu_c");
  for (const line of script.lines) {
    delete line.origin;
    delete line.promptSource;
  }
  writeTranscript(h, script.lines);
  r.release();
  const resumed = await recorder(h);
  expect(resumed.receipts.current?.claimed).toHaveLength(built.length);
  expect(
    (await messages(resumed)).filter((x) => x.includes("user_prompt")).map((x) => x.split("user_prompt ")[1]),
  ).toEqual(["check the build", "old unmarked next prompt", "check the build"]);
});
it("repeated -p prompt is not installed even if it arrives before install hooks", async () => {
  const { h, script, r, built } = await prepared();
  script.compactBoundary();
  script.installed(built);
  const id = script.prompt("check the build");
  const line = script.lines.find((x) => x.uuid === id)!;
  delete line.origin;
  line.promptSource = "sdk";
  writeTranscript(h, script.lines);
  r.release();
  const resumed = await recorder(h);
  expect(resumed.receipts.current?.claimed).not.toContain(id);
  expect(resumed.receipts.current?.claimed).toHaveLength(built.length);
  expect((await messages(resumed)).filter((x) => x.includes("user_prompt"))).toHaveLength(2);
});
it("a prompt after two compacts is not a steer into an already settled turn", async () => {
  const { h, script, r, built } = await prepared();
  script.compactBoundary();
  script.installed(built);
  writeTranscript(h, script.lines);
  await r.recover();
  await r.recover();
  const from = script.entries.length;
  script.toolTurn("two", "ordinary next question", "toolu_b");
  writeTranscript(h, script.lines);
  await r.capture(script.entries.slice(from));
  expect((await messages(r)).filter((x) => x.includes("ordinary next question"))).toEqual([
    "t2 user_prompt ordinary next question",
  ]);
});
