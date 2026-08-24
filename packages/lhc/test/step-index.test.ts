// Schema v12 step index (turn parts, F2): the wire accepts an optional
// non-negative integer on the four step-bearing kinds, storage keeps it
// verbatim, stepEdges reads step structure from it and refuses to split on
// NULL or inconsistent indices, and the open turn's step edges are structure
// for compact drift detection.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { intakeStream, type MessageEventInput, messages, threads } from "../src/index.js";
import { readPreparedSourceState } from "../src/thread-view/index.js";
import { type StepMember, stepEdges } from "../src/turns/internal/steps.js";
import { openRaw, type TempStore, tempStore, validEvent } from "./fixtures/index.js";

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
});

async function createThread(): Promise<string> {
  const filePath = store.threadPath();
  const created = await threads.newThread({ filePath, registryPath: store.registryPath });
  if (!created.ok) throw new Error(`fixture thread creation failed: ${created.error.reason}`);
  return filePath;
}

describe("step index on the wire and in storage", () => {
  it("round-trips verbatim on the four step-bearing kinds and stays absent when omitted", async () => {
    const filePath = await createThread();
    const sent = await intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt"),
      validEvent("assistant_thinking", { payload: { text: "t", stepIndex: 0 } }),
      validEvent("assistant_text", { payload: { text: "a", stepIndex: 0 } }),
      validEvent("tool_call", { payload: { toolCallId: "c1", toolName: "read", arguments: {}, stepIndex: 0 } }),
      validEvent("tool_result", { payload: { toolCallId: "c1", content: "r", stepIndex: 0 } }),
      validEvent("assistant_text", { payload: { text: "b" } }),
    ]);
    expect(sent.ok).toBe(true);
    const listed = await messages.list({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.map((m) => [m.kind, m.stepIndex])).toEqual([
      ["user_prompt", undefined],
      ["assistant_thinking", 0],
      ["assistant_text", 0],
      ["tool_call", 0],
      ["tool_result", 0],
      ["assistant_text", undefined],
    ]);
    expect(listed.value[0]).not.toHaveProperty("stepIndex");
    const shown = await messages.show({ filePath }, "m4");
    expect(shown.ok).toBe(true);
    if (shown.ok) expect(shown.value.stepIndex).toBe(0);
  });

  it("rejects a negative, non-integer, or non-step-kind step index whole", async () => {
    const filePath = await createThread();
    const bad: MessageEventInput[][] = [
      [validEvent("tool_call", { payload: { toolCallId: "c", toolName: "n", arguments: {}, stepIndex: -1 } })],
      [validEvent("assistant_text", { payload: { text: "x", stepIndex: 1.5 } })],
      [validEvent("user_prompt", { payload: { text: "x", stepIndex: 0 } as never })],
    ];
    for (const batch of bad) {
      const result = await intakeStream.messageEvents({ filePath }, batch);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("invalid_event");
    }
    const listed = await messages.list({ filePath });
    expect(listed.ok && listed.value).toEqual([]);
  });
});

describe("stepEdges", () => {
  const m = (messageId: string, kind: string, stepIndex: number | null, toolCallId?: string): StepMember => {
    const order = Number(messageId.slice(1));
    return toolCallId === undefined
      ? { messageId, order, kind, stepIndex }
      : { messageId, order, kind, stepIndex, toolCallId };
  };

  it("counts complete steps with interleaved parallel results and keeps the in-flight step open", () => {
    const edges = stepEdges([
      m("m1", "user_prompt", null),
      m("m2", "assistant_thinking", 0),
      m("m3", "tool_call", 0, "a"),
      m("m4", "tool_result", 0, "a"),
      m("m5", "tool_call", 1, "b"),
      m("m6", "tool_call", 1, "c"),
      m("m7", "runtime_note", null),
      m("m8", "tool_result", 1, "c"),
      m("m9", "tool_result", 1, "b"),
      m("m10", "assistant_text", 2),
      m("m11", "tool_call", 2, "d"),
    ]);
    expect(edges).toEqual({
      splittable: true,
      complete: 2,
      lastEdge: 1,
      steps: [
        { index: 0, firstMessageId: "m2", lastMessageId: "m4", firstOrder: 2, lastOrder: 4, complete: true },
        { index: 1, firstMessageId: "m5", lastMessageId: "m9", firstOrder: 5, lastOrder: 9, complete: true },
        { index: 2, firstMessageId: "m10", lastMessageId: "m11", firstOrder: 10, lastOrder: 11, complete: false },
      ],
    });
  });

  it("is not splittable on a NULL, a non-monotonic index, or a tool pair straddling steps", () => {
    const base = [m("m1", "assistant_text", 0), m("m2", "tool_call", 1, "a"), m("m3", "tool_result", 1, "a")];
    expect(stepEdges(base)).toMatchObject({ splittable: true, complete: 2, lastEdge: 1 });
    expect(stepEdges([...base, m("m4", "assistant_text", null)]).splittable).toBe(false);
    expect(stepEdges([...base, m("m4", "assistant_text", 0)]).splittable).toBe(false);
    expect(
      stepEdges([m("m1", "assistant_text", 0), m("m2", "tool_call", 0, "a"), m("m3", "tool_result", 1, "a")]),
    ).toMatchObject({ splittable: false, complete: 0, lastEdge: null });
    expect(stepEdges([m("m1", "user_prompt", null)])).toMatchObject({ splittable: false, steps: [], lastEdge: null });
  });
});

describe("structureDigest folds the open turn's step edges", () => {
  it("changes when an open-turn step index changes and not when a closed-turn one does", async () => {
    const filePath = await createThread();
    const sent = await intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt"),
      validEvent("assistant_text", { payload: { text: "closed", stepIndex: 0 } }),
      validEvent("turn_end"),
      validEvent("user_prompt"),
      validEvent("assistant_text", { payload: { text: "open", stepIndex: 0 } }),
    ]);
    expect(sent.ok).toBe(true);
    const db = openRaw(filePath);
    try {
      const before = readPreparedSourceState(db, 0).structureDigest;
      db.prepare(`UPDATE message SET step_index = 7 WHERE message_id = 'm2'`).run();
      expect(readPreparedSourceState(db, 0).structureDigest).toBe(before);
      db.prepare(`UPDATE message SET step_index = 1 WHERE message_id = 'm5'`).run();
      const after = readPreparedSourceState(db, 0).structureDigest;
      expect(after).not.toBe(before);
      db.prepare(`UPDATE message SET step_index = NULL WHERE message_id = 'm5'`).run();
      expect(readPreparedSourceState(db, 0).structureDigest).not.toBe(after);
    } finally {
      db.close();
    }
  });
});
