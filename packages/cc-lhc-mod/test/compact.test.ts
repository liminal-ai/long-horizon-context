import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INSTRUCTIONS_LABEL } from "../sidecar/src/capture/map.ts";
import type { BuiltMessage } from "../src/compact.ts";
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

describe("the compact route", () => {
  it("answers with the view from a sidecar that restarted and never got a policy", async () => {
    const script = new Script();
    script.toolTurn("turn-1", "first", "toolu_a");
    writeTranscript(h, script.lines);
    await s.call("/bind", { sessionId: SESSION, transcriptPath: h.transcript, source: "restart" });
    await s.call("/capture", { entries: script.entries });

    const { json } = await s.call("/compact", { sessionId: SESSION, trigger: "auto", target: 10_000 });

    expect(json.kind).toBe("view");
    expect(json.isMidTurn).toBe(false);
    expect((json.messages as Array<{ text: string }>).map((m) => m.text)).toContain("first");
  });

  it("leaves no receipt for a view the guard refuses, so recovery has nothing stale to match", async () => {
    const script = new Script();
    script.toolTurn("turn-1", "first", "toolu_a");
    writeTranscript(h, script.lines);
    await s.call("/bind", { sessionId: SESSION, transcriptPath: h.transcript, source: "startup" });
    await s.call("/capture", { entries: script.entries });
    const guard = { trigger: 10_000, fixed: 10_000 };

    const { json } = await s.call("/compact", { sessionId: SESSION, trigger: "manual", target: 10_000, guard });

    expect(json.kind).toBe("native");
    expect(json.reason).toMatch(/would not get below the 10k trigger/);
    const path = join(h.home, "receipts", `${SESSION}.json`);
    const expected = existsSync(path)
      ? (JSON.parse(readFileSync(path, "utf8")) as { expected: string[] }).expected
      : [];
    expect(expected).toEqual([]);

    const accepted = await s.call("/compact", {
      sessionId: SESSION,
      trigger: "manual",
      target: 10_000,
      guard: { ...guard, fixed: 0 },
    });
    expect(accepted.json.kind).toBe("view");
    expect((JSON.parse(readFileSync(path, "utf8")) as { expected: string[] }).expected).not.toEqual([]);
  });

  it("answers native for a session it is not bound to", async () => {
    await s.call("/bind", { sessionId: SESSION, transcriptPath: h.transcript, source: "startup" });

    const { json } = await s.call("/compact", { sessionId: "other", trigger: "manual", target: 10_000 });

    expect(json).toEqual({ kind: "native", reason: `the sidecar is bound to ${SESSION}` });
  });
});

describe("a typed /compact with instructions", () => {
  it("is one labeled note, live and after recovery", async () => {
    const script = new Script();
    script.toolTurn("turn-1", "first", "toolu_a");
    script.note("/compact keep the plan");
    writeTranscript(h, script.lines);
    await s.call("/bind", { sessionId: SESSION, transcriptPath: h.transcript, source: "startup" });
    await s.call("/capture", { entries: script.entries });
    await s.call("/compact", { sessionId: SESSION, trigger: "manual", target: 10_000 });
    await s.call("/bind", { sessionId: SESSION, transcriptPath: h.transcript, source: "compact" });

    if (s.state.recording?.kind !== "recording") throw new Error("not recording");
    const notes = (await messages(s.state.recording.recorder)).filter((m) => m.includes("keep the plan"));
    expect(notes).toEqual([`t1 runtime_note ${INSTRUCTIONS_LABEL}keep the plan`]);
  });
});

describe("two manual compacts then a restart", () => {
  it("stays settled: the older install's rows open no turn", async () => {
    const path = join(h.home, `${SESSION}.jsonl`);
    const other = "22222222-2222-3333-4444-555555555555";
    await s.call("/bind", { sessionId: SESSION, transcriptPath: path, source: "startup" });
    const script = new Script();
    script.toolTurn("a", "original user request", "toolu_a");
    writeTranscript(h, script.lines);
    await s.call("/capture", { entries: script.entries });
    for (let n = 0; n < 2; n++) {
      const { json } = await s.call("/compact", { sessionId: SESSION, trigger: "manual", target: 10_000 });
      expect(json.kind).toBe("view");
      const from = script.entries.length;
      script.compactBoundary();
      script.installed(json.messages as BuiltMessage[]);
      writeTranscript(h, script.lines);
      await s.call("/capture", { entries: script.entries.slice(from) });
    }
    await s.call("/bind", { sessionId: SESSION, transcriptPath: path, source: "resume" });
    await s.call("/bind", { sessionId: other, transcriptPath: join(h.home, `${other}.jsonl`), source: "clear" });
    await s.call("/bind", { sessionId: SESSION, transcriptPath: path, source: "resume" });

    if (s.state.recording?.kind !== "recording") throw new Error("not recording");
    expect(s.state.recording.recorder.isTurnOpen).toBe(false);
  });
});
