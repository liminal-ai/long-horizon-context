// Host metadata surface (turn parts, AC-7.1): the pressure-decision reads.
// activeTurn comes from the record's open turn and its host-supplied step
// indices; unsettledTurn comes from the installed view alone.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { intakeStream, threads, threadView } from "../src/index.js";
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

async function read(filePath: string) {
  const result = await threadView.hostMetadata({ filePath });
  if (!result.ok) throw new Error(result.error.reason);
  return result.value;
}

describe("threadView.hostMetadata", () => {
  it("reports the open turn's size and complete-step edges from stamped step indices", async () => {
    const filePath = await createThread();
    expect(await read(filePath)).toEqual({
      activeTurn: { turnId: "t1", estimatedTokens: 0, completeSteps: 0, lastStepEdge: null, splittable: false },
      unsettledTurn: null,
    });

    const sent = await intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt"),
      validEvent("assistant_text", { payload: { text: "step zero", stepIndex: 0 } }),
      validEvent("tool_call", { payload: { toolCallId: "a", toolName: "read", arguments: {}, stepIndex: 1 } }),
      validEvent("tool_call", { payload: { toolCallId: "b", toolName: "read", arguments: {}, stepIndex: 1 } }),
      validEvent("tool_result", { payload: { toolCallId: "b", content: "bb", stepIndex: 1 } }),
      validEvent("tool_result", { payload: { toolCallId: "a", content: "aa", stepIndex: 1 } }),
      validEvent("tool_call", { payload: { toolCallId: "c", toolName: "read", arguments: {}, stepIndex: 2 } }),
    ]);
    expect(sent.ok).toBe(true);
    const db = openRaw(filePath);
    let storedSum: number;
    try {
      storedSum = Number(
        (db.prepare(`SELECT SUM(token_estimate) AS s FROM message WHERE turn_id = 't1'`).get() as { s: number }).s,
      );
    } finally {
      db.close();
    }
    expect(storedSum).toBeGreaterThan(0);
    expect(await read(filePath)).toEqual({
      activeTurn: { turnId: "t1", estimatedTokens: storedSum, completeSteps: 2, lastStepEdge: 1, splittable: true },
      unsettledTurn: null,
    });

    // Closing the turn moves the active turn to the fresh empty one.
    const closed = await intakeStream.messageEvents({ filePath }, [validEvent("turn_end")]);
    expect(closed.ok).toBe(true);
    expect((await read(filePath)).activeTurn).toEqual({
      turnId: "t2",
      estimatedTokens: 0,
      completeSteps: 0,
      lastStepEdge: null,
      splittable: false,
    });

    // Exactly one complete step: splittable, but no admissible k — the one
    // complete step is the minimum verbatim tail, and 0 is not a split.
    const one = await intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt"),
      validEvent("assistant_text", { payload: { text: "only step", stepIndex: 0 } }),
    ]);
    expect(one.ok).toBe(true);
    expect((await read(filePath)).activeTurn).toMatchObject({
      turnId: "t2",
      completeSteps: 1,
      lastStepEdge: null,
      splittable: true,
    });
  });

  it("a NULL step index on any step-bearing member makes the turn not splittable with no admissible edge", async () => {
    const filePath = await createThread();
    const sent = await intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt"),
      validEvent("assistant_text", { payload: { text: "stamped", stepIndex: 0 } }),
      validEvent("assistant_text", { payload: { text: "unstamped" } }),
      validEvent("assistant_text", { payload: { text: "stamped again", stepIndex: 1 } }),
    ]);
    expect(sent.ok).toBe(true);
    expect((await read(filePath)).activeTurn).toMatchObject({
      turnId: "t1",
      completeSteps: 2,
      lastStepEdge: null,
      splittable: false,
    });
  });

  it("derives the unsettled turn from the installed view's part entry, never from the record", async () => {
    const filePath = await createThread();
    const sent = await intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt"),
      validEvent("assistant_text", { payload: { text: "a", stepIndex: 0 } }),
      validEvent("turn_end"),
    ]);
    expect(sent.ok).toBe(true);
    const install = (arrangement: unknown): void => {
      const db = openRaw(filePath);
      try {
        db.exec(`DELETE FROM thread_view`);
        db.prepare(
          `INSERT INTO thread_view (singleton, view_id, created_at, compact_point, covered_from, profile_name,
             config_json, arrangement_json, gaps_json, source_state_json)
           VALUES (1, 'v-test', '2026-01-01T00:00:00.000Z', 2, 0, NULL, '{}', ?, '[]', '{}')`,
        ).run(JSON.stringify(arrangement));
      } finally {
        db.close();
      }
    };
    const whole = {
      band: "smooth",
      subjectKind: "turn",
      subjectId: "t1",
      derivationUsed: "turn_rendering",
      degraded: false,
    };
    install([whole]);
    expect((await read(filePath)).unsettledTurn).toBeNull();
    install([{ ...whole, derivationUsed: "part", part: { fromStep: 0, toStep: 0 } }]);
    expect((await read(filePath)).unsettledTurn).toEqual({ turnId: "t1" });
  });
});
