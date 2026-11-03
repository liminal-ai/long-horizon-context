import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mapEntries, SETTLED } from "../sidecar/src/capture/map.ts";
import { events, type Harness, harness, messages, record, recorder, Script, writeTranscript } from "./fixture.ts";

let h: Harness;
beforeEach(() => {
  h = harness();
});
afterEach(() => h.cleanup());

describe("capture", () => {
  it("records rows in order, one turn per prompt", async () => {
    const script = new Script();
    script.toolTurn("turn-1", "first", "toolu_a");
    script.toolTurn("turn-2", "second", "toolu_b");
    const r = await recorder(h);
    writeTranscript(h, script.lines);

    await r.capture(script.entries);

    expect(await messages(r)).toEqual([
      "t1 user_prompt first",
      "t1 tool_call toolu_a",
      "t1 tool_result toolu_a",
      "t1 assistant_text done turn-1",
      "t2 user_prompt second",
      "t2 tool_call toolu_b",
      "t2 tool_result toolu_b",
      "t2 assistant_text done turn-2",
    ]);
  });

  it("drops queue rows, mechanical attachments, notices and the compact boundary, and keeps notes, notifications and steers", async () => {
    const script = new Script();
    script.queued("typed ahead");
    script.prompt("go");
    script.attachment("skill_listing", "<system-reminder>skills</system-reminder>");
    script.attachment("hook_success", "", "hook-context");
    script.turnStart("turn-1");
    script.step("turn-1", 0);
    script.steer("also this");
    script.attachment("todo_reminder", "<system-reminder>a todo</system-reminder>");
    script.answer({ type: "text", text: "ok" });
    script.compactBoundary();
    script.turnEnd("turn-1");
    script.notification("<task-notification>job done</task-notification>");
    const r = await recorder(h);
    writeTranscript(h, script.lines);

    await r.capture(script.entries);

    expect(await messages(r)).toEqual([
      "t1 user_prompt go",
      "t1 user_prompt steer <system-reminder>The user sent: also this</system-reminder>",
      "t1 runtime_note <system-reminder>a todo</system-reminder>",
      "t1 assistant_text ok",
      "t2 runtime_note <task-notification>job done</task-notification>",
    ]);
  });

  it("records a resent batch once", async () => {
    const script = new Script();
    script.toolTurn("turn-1", "first", "toolu_a");
    const r = await recorder(h);
    writeTranscript(h, script.lines);

    const first = await r.capture(script.entries);
    const again = await r.capture(script.entries);

    expect(first).toBe(5);
    expect(again).toBe(0);
    expect(await messages(r)).toHaveLength(4);
  });

  it("puts parallel tool calls and their results in the step that made them", async () => {
    const script = new Script();
    script.toolTurn("turn-1", "parallel", "toolu_a", "toolu_b");
    const r = await recorder(h);
    writeTranscript(h, script.lines);

    await r.capture(script.entries);

    const steps = [...(await events(r)).values()]
      .filter((payload) => typeof payload.toolCallId === "string" || payload.text === "done turn-1")
      .map((payload) => `${String(payload.toolCallId ?? payload.text)}@${String(payload.stepIndex)}`);
    expect(steps).toEqual(["toolu_a@0", "toolu_b@0", "toolu_a@0", "toolu_b@0", "done turn-1@1"]);
  });

  it("refuses a second live Claude process on the same thread", async () => {
    await recorder(h);

    const second = await record(h, "resume", process.ppid);

    expect(second).toMatchObject({ kind: "refused", notice: expect.stringContaining(`process ${process.pid}`) });
  });

  it("keeps the lease across a sidecar restart under the same Claude process", async () => {
    await recorder(h);

    expect((await record(h, "restart")).kind).toBe("recording");
  });

  it("refuses a forked session until fork is supported, across a sidecar restart and a mod reload", async () => {
    expect(await record(h, "fork")).toMatchObject({ kind: "refused", notice: expect.stringContaining("forked") });
    expect(await record(h, "restart")).toMatchObject({ kind: "refused", notice: expect.stringContaining("forked") });
    expect(await record(h, "reload")).toMatchObject({ kind: "refused", notice: expect.stringContaining("forked") });
  });

  it("records a task notification delivered mid-turn as a runtime note, live and recovered alike", async () => {
    const notification =
      "<task-notification>\n<task-id>b2iz2kpm0</task-id>\n<status>completed</status>\n</task-notification>";
    const script = new Script();
    script.prompt("go");
    script.turnStart("turn-1");
    script.step("turn-1", 0);
    script.delivery(notification);
    script.steer("also this");
    script.answer({ type: "text", text: "ok" });
    script.turnEnd("turn-1");
    const live = await recorder(h);
    writeTranscript(h, script.lines);
    await live.capture(script.entries);
    const liveMessages = await messages(live);
    live.release();
    h.cleanup();
    h = harness();
    writeTranscript(h, script.lines);

    const recovered = await recorder(h);

    const expected = [
      "t1 user_prompt go",
      `t1 runtime_note ${notification}`,
      "t1 user_prompt steer <system-reminder>The user sent: also this</system-reminder>",
      "t1 assistant_text ok",
    ];
    expect(liveMessages).toEqual(expected);
    expect((await messages(recovered)).slice(0, 2)).toEqual(expected.slice(0, 2));
  });

  it("keeps a steer that quotes a task-notification element as the person's request", () => {
    const script = new Script();
    script.steer("Explain why <task-notification>hello</task-notification> appears in the logs");

    const [event] = mapEntries(script.entries, SETTLED).events;

    expect(event?.eventKind).toBe("user_prompt");
    expect(event?.payload).toMatchObject({ steer: true });
  });

  it("recovers a delivery as a runtime note from the attachment's origin alone", async () => {
    const script = new Script();
    script.prompt("go");
    script.delivery("background job finished", { kind: "task-notification" });
    writeTranscript(h, script.lines);

    const recovered = await recorder(h);

    expect(await messages(recovered)).toEqual(["t1 user_prompt go", "t1 runtime_note background job finished"]);
  });
});

describe("slash command markup quoted in conversation", () => {
  it("stays assistant text in a response and the person's words in a typed prompt", () => {
    const script = new Script();
    script.prompt("What does <command-name>/example</command-name> mean?");
    script.answer({ type: "text", text: "It looks like <command-name>/example</command-name> in the transcript." });

    const events = mapEntries(script.entries, SETTLED).events.map(
      (event) => `${event.eventKind} ${(event.payload as { text?: string }).text}`,
    );

    expect(events).toEqual([
      "user_prompt What does <command-name>/example</command-name> mean?",
      "assistant_text It looks like <command-name>/example</command-name> in the transcript.",
    ]);
  });
});
