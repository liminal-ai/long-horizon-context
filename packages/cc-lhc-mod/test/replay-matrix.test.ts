import { threads } from "lhc";
import { expect, it, vi } from "vitest";
import { events, harness, messages, recorder, Script, writeTranscript } from "./fixture.ts";

async function setup(tools: number) {
  const h = harness();
  const s = new Script();
  s.toolTurn("a", "first", "a");
  const anchor = s.lines.at(-1)!.uuid;
  const kept = s.entries.length;
  s.prompt("discarded");
  s.turnStart("b");
  s.attachment("date", "context");
  for (let i = 0; i < tools; i++) {
    s.step("b", i);
    s.answer({ type: "tool_use", id: `discarded-${i}`, name: "Bash", input: { command: `echo ${i}` } });
    s.results(`discarded-${i}`);
  }
  s.step("b", tools);
  s.answer({ type: "text", text: "discarded answer" });
  s.turnEnd("b");
  const outbox = s.entries.slice(kept);
  s.rewindTo(anchor);
  s.prompt("replacement");
  s.turnStart("c");
  s.step("c", 0);
  s.answer({ type: "tool_use", id: "c1", name: "Bash", input: { command: "echo retained" } });
  s.results("c1");
  const recoveredLines = s.lines.length,
    later = s.entries.length;
  s.step("c", 1);
  s.answer({ type: "text", text: "replacement done" });
  const r = await recorder(h);
  writeTranscript(h, s.lines.slice(0, recoveredLines));
  await r.capture(s.entries.slice(0, kept));
  r.release();
  const next = await recorder(h);
  return { h, s, next, outbox, later };
}
async function assertContent(next: Awaited<ReturnType<typeof recorder>>) {
  expect(await messages(next)).toEqual([
    "t1 user_prompt first",
    "t1 tool_call a",
    "t1 tool_result a",
    "t1 assistant_text done a",
    "t2 user_prompt replacement",
    "t2 tool_call c1",
    "t2 tool_result c1",
    "t2 assistant_text replacement done",
  ]);
  const history = await threads.exportHistory(next.thread);
  expect(history.ok).toBe(true);
  if (!history.ok) throw new Error(history.error.reason);
  const blocks = history.value.turns.flatMap((t) => t.messages.flatMap((m) => m.blocks));
  const json = JSON.stringify(blocks);
  expect(json).toContain("echo retained");
  expect(json).toContain("out c1");
  expect(json).not.toContain("discarded");
}
for (const tools of [1, 65, 500])
  for (const batch of [1, 7, 50, 200, 1000]) {
    it(`matrix tools=${tools} batch=${batch}`, async () => {
      const { h, s, next, outbox, later } = await setup(tools);
      try {
        for (let i = 0; i < outbox.length; i += batch) await next.capture(outbox.slice(i, i + batch));
        writeTranscript(h, s.lines);
        await next.capture(s.entries.slice(later));
        await assertContent(next);
        expect((await events(next)).has(`claude-code:turn:${s.turnId("b")}:turn_end`)).toBe(false);
      } finally {
        next.release();
        h.cleanup();
      }
    }, 30000);
  }
it("failed write restores true flag before marker-only probe and retry", async () => {
  const { h, s, next, outbox, later } = await setup(65);
  try {
    await next.capture(outbox.slice(0, -1)); // successful replay leaves flag=true
    writeTranscript(h, s.lines);
    const batch = [outbox.at(-1)!, ...s.entries.slice(later)]; // retained row changes flag to false
    const write = vi.spyOn(next.deps.lhc.intakeStream, "messageEvents");
    write.mockRejectedValueOnce(new Error("injected write error"));
    await expect(next.capture(batch)).rejects.toThrow("injected write error");
    expect(next.isTurnOpen).toBe(true);
    await next.capture(outbox.slice(-1)); // flag must still be true; old turn-end must be dropped
    expect(next.isTurnOpen).toBe(true);
    expect((await events(next)).has(`claude-code:turn:${s.turnId("b")}:turn_end`)).toBe(false);
    await next.capture(batch);
    await assertContent(next);
    expect(write.mock.calls.length).toBe(2);
    write.mockRestore();
  } finally {
    next.release();
    h.cleanup();
  }
});
it("failed write restores false flag before live step and retained row retry", async () => {
  const { h, s, next, outbox, later } = await setup(1);
  try {
    writeTranscript(h, s.lines);
    const retained = s.entries.slice(later);
    const abandoned = outbox.filter((e) => e.kind === "row").at(-1)!;
    const write = vi.spyOn(next.deps.lhc.intakeStream, "messageEvents");
    write.mockRejectedValueOnce(new Error("injected write error"));
    await expect(next.capture([...retained, abandoned])).rejects.toThrow("injected write error");
    s.step("c", 9);
    await next.capture(s.entries.slice(-1));
    await next.capture(retained.filter((e) => e.kind === "row"));
    await assertContent(next);
    const answer = [...(await events(next)).values()].find((v) => v.text === "replacement done");
    expect(answer?.stepIndex).toBe(9); // a leaked true flag drops the live step
    write.mockRestore();
  } finally {
    next.release();
    h.cleanup();
  }
});
