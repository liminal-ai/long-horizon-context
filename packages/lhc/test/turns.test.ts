// Story 4 (Flow 3): turn boundaries through the production walk. TC-3.1
// through TC-3.8 (the work-item halves of TC-3.3/TC-3.6 are Story 5's named
// debt), TC-4.4's three-way class assertion, TC-5.4's no-transition clause
// re-asserted now that turns exist, and the corruption rung of the rollback
// ladder. Everything enters through the SDK (the CLI surface retired with Epic 05
// Story 1). The pure rule table is golden-cased in state-machine.test.ts.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  intakeStream,
  messages,
  threads,
  turns,
  type MessageEventInput,
  type TurnRecord,
} from "../src/index.js";
import {
  corruptTwoOpenTurns,
  tempStore,
  validEvent,
  type TempStore,
} from "./fixtures/index.js";

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

async function send(filePath: string, batch: MessageEventInput[]) {
  const result = await intakeStream.messageEvents({ filePath }, batch);
  if (!result.ok) throw new Error(`fixture batch failed: ${result.error.reason}`);
  return result.value;
}

async function readTurns(filePath: string): Promise<TurnRecord[]> {
  const result = await turns.listTurns({ filePath });
  if (!result.ok) throw new Error(`turn read-back failed: ${result.error.reason}`);
  return result.value;
}

// Full logical read-back across every record kind this story owns — the
// rollback ladder's corruption rung compares this whole, not just the error.
async function readBack(filePath: string) {
  const [events, projected, turnRecords] = await Promise.all([
    intakeStream.listEvents({ filePath }),
    messages.listMessages({ filePath }),
    turns.listTurns({ filePath }),
  ]);
  if (!events.ok || !projected.ok || !turnRecords.ok) {
    throw new Error("read-back failed");
  }
  return { events: events.value, messages: projected.value, turns: turnRecords.value };
}

describe("Flow 3 (SDK): turn boundaries", () => {
  it("TC-3.1: a prompt opens a turn and the whole activity stamps to it (AC-3.1, AC-3.2)", async () => {
    const filePath = await createThread();
    const result = await send(filePath, [
      validEvent("user_prompt"),
      validEvent("assistant_text"),
      validEvent("tool_call"),
      validEvent("tool_result"),
    ]);
    expect(result.turnTransitions).toEqual([{ action: "opened", turnId: "t1" }]);

    const turnRecords = await readTurns(filePath);
    expect(turnRecords).toEqual([
      {
        turnId: "t1",
        status: "open",
        memberMessageIds: ["m1", "m2", "m3", "m4"],
        openedAtEventOrder: 1,
      },
    ]);

    // Membership is also visible on the members themselves.
    const projected = await messages.listMessages({ filePath });
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.value.map((message) => message.turnId)).toEqual(["t1", "t1", "t1", "t1"]);
  });

  it("TC-3.2: a second prompt closes the open turn and opens a new one holding only the prompt (AC-3.3)", async () => {
    const filePath = await createThread();
    await send(filePath, [validEvent("user_prompt"), validEvent("assistant_text")]);

    const second = await send(filePath, [validEvent("user_prompt")]);
    expect(second.turnTransitions).toEqual([
      { action: "closed", turnId: "t1" },
      { action: "opened", turnId: "t2" },
    ]);

    const turnRecords = await readTurns(filePath);
    expect(turnRecords).toEqual([
      {
        turnId: "t1",
        status: "closed",
        memberMessageIds: ["m1", "m2"],
        openedAtEventOrder: 1,
        closedAtEventOrder: 3,
        forms: [
          {
            subjectKind: "turn",
            subjectId: "t1",
            form: "lower_band_projection",
            state: "pending",
            sourceVersion: 1,
          },
          {
            subjectKind: "turn",
            subjectId: "t1",
            form: "turn_rendering",
            state: "pending",
            sourceVersion: 1,
          },
        ],
      },
      {
        turnId: "t2",
        status: "open",
        memberMessageIds: ["m3"],
        openedAtEventOrder: 3,
      },
    ]);
  });

  it("TC-3.3 (transition + membership half): turn_end closes the open turn (AC-3.4; work item is Story 5's)", async () => {
    const filePath = await createThread();
    const result = await send(filePath, [
      validEvent("user_prompt"),
      validEvent("assistant_text"),
      validEvent("turn_end"),
    ]);
    expect(result.turnTransitions).toEqual([
      { action: "opened", turnId: "t1" },
      { action: "closed", turnId: "t1" },
    ]);

    const turnRecords = await readTurns(filePath);
    expect(turnRecords).toEqual([
      {
        turnId: "t1",
        status: "closed",
        memberMessageIds: ["m1", "m2"],
        openedAtEventOrder: 1,
        closedAtEventOrder: 3,
        forms: [
          {
            subjectKind: "turn",
            subjectId: "t1",
            form: "lower_band_projection",
            state: "pending",
            sourceVersion: 1,
          },
          {
            subjectKind: "turn",
            subjectId: "t1",
            form: "turn_rendering",
            state: "pending",
            sourceVersion: 1,
          },
        ],
      },
    ]);
  });

  it("TC-3.4: an orphan turn_end is recorded but inert; the next prompt opens t1 normally (AC-3.5)", async () => {
    const filePath = await createThread();
    const orphan = await send(filePath, [validEvent("turn_end")]);
    expect(orphan.turnTransitions).toEqual([]);
    expect(orphan.events[0]!.outcome).toBe("recorded");

    const events = await intakeStream.listEvents({ filePath });
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    expect(events.value).toHaveLength(1);
    expect(events.value[0]!.eventOrder).toBe(1);

    expect(await readTurns(filePath)).toEqual([]);

    const next = await send(filePath, [validEvent("user_prompt")]);
    expect(next.turnTransitions).toEqual([{ action: "opened", turnId: "t1" }]);
    expect(await readTurns(filePath)).toEqual([
      { turnId: "t1", status: "open", memberMessageIds: ["m2"], openedAtEventOrder: 2 },
    ]);
  });

  it("TC-3.5: gap messages stay membershipless forever; the closed turn reads back unchanged (AC-3.7, AC-3.8)", async () => {
    const filePath = await createThread();
    await send(filePath, [
      validEvent("user_prompt"),
      validEvent("assistant_text"),
      validEvent("turn_end"),
    ]);
    const closedBefore = (await readTurns(filePath))[0]!;

    // Post-close, pre-prompt: a gap message with no membership.
    await send(filePath, [validEvent("assistant_text")]);
    // A new prompt opens t2; the gap message must not be adopted into it.
    await send(filePath, [validEvent("user_prompt")]);

    const projected = await messages.listMessages({ filePath });
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    const gap = projected.value.find((message) => message.messageId === "m4")!;
    expect(gap.turnId).toBeUndefined();

    const turnRecords = await readTurns(filePath);
    // Frozenness is behavioral: the closed turn's full record — members
    // included — is identical after the later activity.
    expect(turnRecords[0]).toEqual(closedBefore);
    expect(turnRecords[1]).toEqual({
      turnId: "t2",
      status: "open",
      memberMessageIds: ["m5"],
      openedAtEventOrder: 5,
    });
  });

  it("TC-3.6 (transition half): implicit close behaves exactly like explicit close (work parity is Story 5's)", async () => {
    const explicitPath = await createThread();
    await send(explicitPath, [validEvent("user_prompt"), validEvent("assistant_text")]);
    const explicitClose = await send(explicitPath, [validEvent("turn_end")]);

    const implicitPath = await createThread();
    await send(implicitPath, [validEvent("user_prompt"), validEvent("assistant_text")]);
    const implicitClose = await send(implicitPath, [validEvent("user_prompt")]);

    // Both paths close t1 at event order 3 with the same frozen membership.
    expect(explicitClose.turnTransitions[0]).toEqual({ action: "closed", turnId: "t1" });
    expect(implicitClose.turnTransitions[0]).toEqual({ action: "closed", turnId: "t1" });
    const explicitT1 = (await readTurns(explicitPath))[0];
    const implicitT1 = (await readTurns(implicitPath))[0];
    expect(explicitT1).toEqual(implicitT1);
  });

  it("TC-3.7: two open turns fail any batch with turn_state_corrupt and the batch records nothing (AC-3.9)", async () => {
    const filePath = await createThread();
    await send(filePath, [validEvent("user_prompt"), validEvent("assistant_text")]);
    corruptTwoOpenTurns(filePath);

    // Baseline captured after the corruption: the failed batch must add
    // nothing on top of it — full read-back diff, not just the error code.
    const baseline = await readBack(filePath);

    const failed = await intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt"),
      validEvent("assistant_text"),
    ]);
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.error.errorClass).toBe("state_corruption");
    expect(failed.error.code).toBe("turn_state_corrupt");

    // The check fired at state load, before any event was processed: no
    // partial walk preceded detection (architecture-risk timing assertion,
    // the rollback ladder's corruption rung).
    expect(await readBack(filePath)).toEqual(baseline);
  });

  it("TC-3.8: one batch with two prompts and a turn_end yields two closed turns with correct membership (AC-3.3)", async () => {
    const filePath = await createThread();
    const result = await send(filePath, [
      validEvent("user_prompt"),
      validEvent("assistant_text"),
      validEvent("user_prompt"),
      validEvent("assistant_text"),
      validEvent("turn_end"),
    ]);

    // Transitions in occurrence order, per event inside the walk.
    expect(result.turnTransitions).toEqual([
      { action: "opened", turnId: "t1" },
      { action: "closed", turnId: "t1" },
      { action: "opened", turnId: "t2" },
      { action: "closed", turnId: "t2" },
    ]);

    expect(await readTurns(filePath)).toEqual([
      {
        turnId: "t1",
        status: "closed",
        memberMessageIds: ["m1", "m2"],
        openedAtEventOrder: 1,
        closedAtEventOrder: 3,
        forms: [
          {
            subjectKind: "turn",
            subjectId: "t1",
            form: "lower_band_projection",
            state: "pending",
            sourceVersion: 1,
          },
          {
            subjectKind: "turn",
            subjectId: "t1",
            form: "turn_rendering",
            state: "pending",
            sourceVersion: 1,
          },
        ],
      },
      {
        turnId: "t2",
        status: "closed",
        memberMessageIds: ["m3", "m4"],
        openedAtEventOrder: 3,
        closedAtEventOrder: 5,
        forms: [
          {
            subjectKind: "turn",
            subjectId: "t2",
            form: "lower_band_projection",
            state: "pending",
            sourceVersion: 1,
          },
          {
            subjectKind: "turn",
            subjectId: "t2",
            form: "turn_rendering",
            state: "pending",
            sourceVersion: 1,
          },
        ],
      },
    ]);
  });

  it("TC-5.4 (no-transition clause): resending recorded events causes no transition and leaves turn state unchanged (AC-5.4)", async () => {
    const filePath = await createThread();
    const prompt = validEvent("user_prompt");
    const end = validEvent("turn_end");
    await send(filePath, [prompt, validEvent("assistant_text"), end]);
    await send(filePath, [validEvent("user_prompt")]); // t2 now open
    const baseline = await readBack(filePath);

    // A resent prompt cannot re-close a turn; a resent turn_end cannot close
    // whatever happens to be open now.
    const resend = await send(filePath, [prompt, end]);
    expect(resend.events.map((entry) => entry.outcome)).toEqual(["skipped", "skipped"]);
    expect(resend.turnTransitions).toEqual([]);
    expect(await readBack(filePath)).toEqual(baseline);
  });
});

describe("TC-4.4: three error classes, asserted against each other (AC-4.7)", () => {
  it("validation, corruption, and storage failures carry three distinct classes with stable codes", async () => {
    // Caller leg: a malformed event.
    const callerPath = await createThread();
    const callerLeg = await intakeStream.messageEvents({ filePath: callerPath }, [
      { ...validEvent("user_prompt"), eventKind: "bogus" } as unknown as MessageEventInput,
    ]);
    expect(callerLeg.ok).toBe(false);
    if (callerLeg.ok) return;
    expect(callerLeg.error.errorClass).toBe("caller_error");
    expect(callerLeg.error.code).toBe("invalid_event");

    // Corruption leg: the two-open-turns fixture.
    const corruptPath = await createThread();
    await send(corruptPath, [validEvent("user_prompt")]);
    corruptTwoOpenTurns(corruptPath);
    const corruptionLeg = await intakeStream.messageEvents({ filePath: corruptPath }, [
      validEvent("assistant_text"),
    ]);
    expect(corruptionLeg.ok).toBe(false);
    if (corruptionLeg.ok) return;
    expect(corruptionLeg.error.errorClass).toBe("state_corruption");
    expect(corruptionLeg.error.code).toBe("turn_state_corrupt");

    // System leg: registry creation under a path whose parent is a file.
    const blocker = join(store.dir, "blocker-file");
    writeFileSync(blocker, "regular file standing where a directory must be");
    const systemLeg = await threads.newThread({
      filePath: store.threadPath(),
      registryPath: join(blocker, "registry.sqlite"),
    });
    expect(systemLeg.ok).toBe(false);
    if (systemLeg.ok) return;
    expect(systemLeg.error.errorClass).toBe("system_error");
    expect(systemLeg.error.code).toBe("storage_failure");

    // The three classes compared against each other, not pattern-matched
    // individually.
    const classes = new Set([
      callerLeg.error.errorClass,
      corruptionLeg.error.errorClass,
      systemLeg.error.errorClass,
    ]);
    expect(classes.size).toBe(3);
  });
});
