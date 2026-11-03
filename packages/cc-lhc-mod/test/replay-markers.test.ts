import { expect, it } from "vitest";
import { events, harness, messages, recorder, Script, writeTranscript } from "./fixture.ts";

for (const slow of [false, true])
  it(`legitimate ordinary end survives ${slow ? "slow flush after next prompt is filed" : "ordinary flush"}`, async () => {
    const h = harness();
    const s = new Script();
    const r = await recorder(h);
    try {
      s.toolTurn("a", "first", "a");
      const end = s.entries.at(-1)!;
      writeTranscript(h, s.lines);
      await r.capture(s.entries.slice(0, -1));
      if (slow) {
        s.prompt("next");
        writeTranscript(h, s.lines);
      }
      await r.capture([end]);
      expect(r.isTurnOpen).toBe(false);
      expect((await events(r)).has(`claude-code:turn:${s.turnId("a")}:turn_end`)).toBe(true);
    } finally {
      r.release();
      h.cleanup();
    }
  });
it("legitimate current turn end without resent rows after mid-turn recovery", async () => {
  const h = harness();
  const s = new Script();
  let r = await recorder(h);
  try {
    s.prompt("first");
    s.turnStart("a");
    s.step("a", 0);
    s.answer({ type: "text", text: "done a" });
    writeTranscript(h, s.lines);
    await r.capture(s.entries);
    r.release();
    r = await recorder(h);
    expect(r.isTurnOpen).toBe(true);
    const n = s.entries.length;
    s.turnEnd("a");
    writeTranscript(h, s.lines);
    await r.capture(s.entries.slice(n));
    const acceptedEnd = (await events(r)).has(`claude-code:turn:${s.turnId("a")}:turn_end`);
    const _wasOpen = r.isTurnOpen;
    const later = s.entries.length;
    s.toolTurn("b", "second", "b");
    writeTranscript(h, s.lines);
    await r.capture(s.entries.slice(later));
    const recorded = await messages(r);
    expect(recorded).toContain("t2 user_prompt second");
    expect(acceptedEnd).toBe(true);
  } finally {
    r.release();
    h.cleanup();
  }
});
for (const shape of ["whole-turn", "rows-and-end", "end-only"] as const)
  it(`linear replay ${shape} preserves later recovered turn`, async () => {
    const h = harness();
    const s = new Script();
    let r = await recorder(h);
    try {
      s.toolTurn("a", "first", "a");
      const first = s.entries.length;
      writeTranscript(h, s.lines);
      await r.capture(s.entries);
      s.prompt("second");
      s.turnStart("b");
      s.step("b", 0);
      const afterStart = s.entries.length;
      s.answer({ type: "text", text: "second done" });
      s.turnEnd("b");
      const oldEnd = s.entries.length;
      s.prompt("third");
      s.turnStart("c");
      s.step("c", 0);
      s.answer({ type: "tool_use", id: "c1", name: "Bash", input: {} });
      s.results("c1");
      writeTranscript(h, s.lines);
      r.release();
      r = await recorder(h);
      const outbox = s.entries.slice(
        shape === "whole-turn" ? first : shape === "rows-and-end" ? afterStart : oldEnd - 1,
        oldEnd,
      );
      await r.capture(outbox);
      const _wasOpen = r.isTurnOpen;
      const later = s.entries.length;
      s.step("c", 1);
      s.answer({ type: "text", text: "third done" });
      writeTranscript(h, s.lines);
      await r.capture(s.entries.slice(later));
      const recorded = await messages(r);
      const turnOf = (suffix: string) => recorded.find((m) => m.endsWith(suffix))?.split(" ")[0];
      expect(turnOf("assistant_text third done")).toBe(turnOf("user_prompt third"));
      expect(recorded.some((m) => m.includes("steer"))).toBe(false);
    } finally {
      r.release();
      h.cleanup();
    }
  });
