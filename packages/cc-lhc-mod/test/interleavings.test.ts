import { expect, it } from "vitest";
import { events, harness, messages, recorder, Script, writeTranscript } from "./fixture.ts";

it("lagging sidecar accepts new opener after transcript already has its next turn", async () => {
  const h = harness();
  const s = new Script();
  const r = await recorder(h);
  try {
    s.toolTurn("a", "first", "a");
    const n = s.entries.length;
    s.toolTurn("b", "second", "b");
    writeTranscript(h, s.lines);
    await r.capture(s.entries.slice(0, n));
    await r.capture(s.entries.slice(n));
    expect(await messages(r)).toEqual([
      "t1 user_prompt first",
      "t1 tool_call a",
      "t1 tool_result a",
      "t1 assistant_text done a",
      "t2 user_prompt second",
      "t2 tool_call b",
      "t2 tool_result b",
      "t2 assistant_text done b",
    ]);
    expect(r.isTurnOpen).toBe(false);
  } finally {
    r.release();
    h.cleanup();
  }
});
it("after a reload the mod still names markers by the opener, so they attach to the recovered turn", async () => {
  const h = harness();
  const s = new Script();
  let r = await recorder(h);
  try {
    s.prompt("first");
    s.turnStart("a");
    s.step("a", 0);
    s.answer({ type: "tool_use", id: "a", name: "Bash", input: {} });
    s.results("a");
    writeTranscript(h, s.lines);
    await r.capture(s.entries);
    r.release();
    r = await recorder(h);
    const n = s.entries.length;
    s.step("a", 1);
    s.answer({ type: "text", text: "done a" });
    s.turnEnd("a");
    writeTranscript(h, s.lines);
    await r.capture(s.entries.slice(n));
    expect(r.isTurnOpen).toBe(false);
    expect((await events(r)).has(`claude-code:turn:${s.turnId("a")}:turn_end`)).toBe(true);
    const j = s.entries.length;
    s.toolTurn("b", "second", "b");
    writeTranscript(h, s.lines);
    await r.capture(s.entries.slice(j));
    expect(await messages(r)).toContain("t2 user_prompt second");
    expect(await messages(r)).toContain("t1 assistant_text done a");
  } finally {
    r.release();
    h.cleanup();
  }
});
for (const name of ["opener", "engine-id"] as const)
  for (const shape of ["end-only", "step-and-end"] as const)
    it(`stale ${name} ${shape} after reload cannot close a later recovered turn`, async () => {
      const h = harness();
      const s = new Script();
      let r = await recorder(h);
      try {
        s.prompt("first");
        s.turnStart("a");
        s.step("a", 0);
        s.answer({ type: "tool_use", id: "a", name: "Bash", input: {} });
        s.results("a");
        writeTranscript(h, s.lines);
        await r.capture(s.entries);
        r.release();
        r = await recorder(h); // hot reload mid-turn loses mod's name map
        const n = s.entries.length;
        s.step("a", 1);
        s.answer({ type: "text", text: "done a" });
        s.turnEnd("a");
        const stale = s.entries
          .slice(n)
          .map((e) => (e.kind === "row" || name === "opener" ? e : { ...e, turnId: "old-engine-id" }));
        const _j = s.entries.length;
        s.prompt("second");
        s.turnStart("b");
        s.step("b", 0);
        s.answer({ type: "tool_use", id: "b", name: "Bash", input: {} });
        s.results("b");
        writeTranscript(h, s.lines);
        r.release();
        r = await recorder(h); // restarted sidecar recovers later open turn
        await r.capture(shape === "end-only" ? stale.slice(-1) : stale);
        const keptOpen = r.isTurnOpen;
        const k = s.entries.length;
        s.step("b", 1);
        s.answer({ type: "text", text: "done b" });
        s.turnEnd("b");
        writeTranscript(h, s.lines);
        await r.capture(s.entries.slice(k));
        const got = await messages(r);
        expect(got).toContain("t2 assistant_text done b");
        expect(keptOpen).toBe(true);
      } finally {
        r.release();
        h.cleanup();
      }
    });

it("recovery keeps a notification turn open when it has no prompt row", async () => {
  const h = harness();
  const s = new Script();
  let r = await recorder(h);
  try {
    s.toolTurn("a", "first", "a");
    const _n = s.entries.length;
    s.delivery("<task-notification>background finished</task-notification>");
    s.turnStart("notification-engine");
    s.step("notification-engine", 0);
    s.answer({ type: "tool_use", id: "notification-tool", name: "Bash", input: {} });
    s.results("notification-tool");
    writeTranscript(h, s.lines);
    await r.capture(s.entries);
    r.release();
    r = await recorder(h);
    const wasOpen = r.isTurnOpen;
    const k = s.entries.length;
    s.step("notification-engine", 1);
    s.answer({ type: "text", text: "notification done" });
    s.turnEnd("notification-engine");
    writeTranscript(h, s.lines);
    await r.capture(s.entries.slice(k));
    const acceptedEnd = (await events(r)).has(`claude-code:turn:${s.turnId("notification-engine")}:turn_end`);
    const j = s.entries.length;
    s.toolTurn("c", "next person prompt", "c");
    writeTranscript(h, s.lines);
    await r.capture(s.entries.slice(j));
    expect(wasOpen).toBe(true);
    expect(acceptedEnd).toBe(true);
  } finally {
    r.release();
    h.cleanup();
  }
});
