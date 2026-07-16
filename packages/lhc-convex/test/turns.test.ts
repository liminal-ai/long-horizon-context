// Flow 3 (SDK): turn boundaries through the production walk, ported to the
// component. TC-3.1..TC-3.8, TC-5.4's no-transition clause, and the corruption
// rung of the rollback ladder (two open turns / zero open turns). Everything
// enters through the SDK.
//
// Adaptation: the frozen corruption fixture patches SQLite rows; the component
// equivalent inserts / patches turn rows through `fixture.test.run` (the
// sanctioned raw-state seam, as view_fixture.test.ts uses). TC-4.4's third
// error class — a filesystem/registry `storage_failure` (system_error) — has no
// Convex analog (there is no per-thread SQLite file or filesystem registry), so
// only the caller_error and state_corruption legs port; see the ledger.
import { describe, expect, test } from "vitest";
import type { Lhc, MessageEventInput, TurnRecord } from "../src/client/index.js";
import { type ServiceFixture, serviceFixture, validEvent } from "./fixtures/index.js";

async function send(sdk: Lhc, filePath: string, batch: MessageEventInput[]) {
  const result = await sdk.intakeStream.messageEvents({ filePath }, batch);
  if (!result.ok) throw new Error(`fixture batch failed: ${result.error.reason}`);
  return result.value;
}

async function readTurns(sdk: Lhc, filePath: string): Promise<TurnRecord[]> {
  const result = await sdk.turns.listTurns({ filePath });
  if (!result.ok) throw new Error(`turn read-back failed: ${result.error.reason}`);
  return result.value;
}

// Full logical read-back across every record kind this story owns — the
// rollback ladder's corruption rung compares this whole, not just the error.
async function readBack(sdk: Lhc, filePath: string) {
  const [events, projected, turnRecords] = await Promise.all([
    sdk.intakeStream.listEvents({ filePath }),
    sdk.messages.list({ filePath }),
    sdk.turns.listTurns({ filePath }),
  ]);
  if (!events.ok || !projected.ok || !turnRecords.ok) throw new Error("read-back failed");
  return { events: events.value, messages: projected.value, turns: turnRecords.value };
}

// Two open turns: the reachable component corruption (an extra open turn row),
// as view_fixture.test.ts seeds it.
async function corruptTwoOpenTurns(fixture: ServiceFixture, thread: string): Promise<void> {
  await fixture.test.run(async (ctx) => {
    await ctx.db.insert("turns", {
      instance: fixture.instance,
      thread,
      turn: "t-corrupt",
      turnOrder: 999,
      status: "open",
      openedAtEventOrder: 999,
    });
  });
}

// Zero open turns: close the sole open turn out from under intake.
async function closeAllOpenTurns(fixture: ServiceFixture, thread: string): Promise<void> {
  await fixture.test.run(async (ctx) => {
    const rows = await ctx.db.query("turns").collect();
    for (const row of rows) {
      if (row.instance === fixture.instance && row.thread === thread && row.status === "open") {
        await ctx.db.patch("turns", row._id, { status: "closed", closedAtEventOrder: 0 });
      }
    }
  });
}

const CLOSED_TURN_DERIVATIONS = (turnId: string) => [
  {
    subjectKind: "turn",
    subjectId: turnId,
    derivationType: "pre_detailed_assembly",
    state: "pending",
    sourceVersion: 1,
  },
  {
    subjectKind: "turn",
    subjectId: turnId,
    derivationType: "turn_rendering",
    state: "pending",
    sourceVersion: 1,
  },
];

describe("Flow 3 (SDK): turn boundaries", () => {
  test("new thread creation initializes exactly one empty open turn", async () => {
    const fixture = serviceFixture();
    const { filePath } = await fixture.createThread();
    expect(await readTurns(fixture.sdk, filePath)).toEqual([
      { turnId: "t1", turnOrder: 1, status: "open", memberMessageIds: [], openedAtEventOrder: 0 },
    ]);
  });

  test("TC-3.1: a prompt attaches to the empty open turn and the whole activity stamps to it", async () => {
    const fixture = serviceFixture();
    const { filePath } = await fixture.createThread();
    const result = await send(fixture.sdk, filePath, [
      validEvent("user_prompt"),
      validEvent("assistant_text"),
      validEvent("tool_call"),
      validEvent("tool_result"),
    ]);
    expect(result.turnTransitions).toEqual([]);

    expect(await readTurns(fixture.sdk, filePath)).toEqual([
      {
        turnId: "t1",
        turnOrder: 1,
        status: "open",
        memberMessageIds: ["m1", "m2", "m3", "m4"],
        openedAtEventOrder: 0,
      },
    ]);

    const projected = await fixture.sdk.messages.list({ filePath });
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.value.map((message) => message.turnId)).toEqual(["t1", "t1", "t1", "t1"]);
  });

  test("TC-3.2: a second prompt closes the open turn and opens a new one holding only the prompt", async () => {
    const fixture = serviceFixture();
    const { filePath } = await fixture.createThread();
    await send(fixture.sdk, filePath, [validEvent("user_prompt"), validEvent("assistant_text")]);

    const second = await send(fixture.sdk, filePath, [validEvent("user_prompt")]);
    expect(second.turnTransitions).toEqual([
      { action: "closed", turnId: "t1" },
      { action: "opened", turnId: "t2" },
    ]);

    expect(await readTurns(fixture.sdk, filePath)).toEqual([
      {
        turnId: "t1",
        turnOrder: 1,
        status: "closed",
        memberMessageIds: ["m1", "m2"],
        openedAtEventOrder: 0,
        closedAtEventOrder: 3,
        derivations: CLOSED_TURN_DERIVATIONS("t1"),
      },
      {
        turnId: "t2",
        turnOrder: 2,
        status: "open",
        memberMessageIds: ["m3"],
        openedAtEventOrder: 3,
      },
    ]);
  });

  test("TC-3.3: turn_end closes a non-empty turn and opens the next empty turn", async () => {
    const fixture = serviceFixture();
    const { filePath } = await fixture.createThread();
    const result = await send(fixture.sdk, filePath, [
      validEvent("user_prompt"),
      validEvent("assistant_text"),
      validEvent("turn_end"),
    ]);
    expect(result.turnTransitions).toEqual([
      { action: "closed", turnId: "t1" },
      { action: "opened", turnId: "t2" },
    ]);

    expect(await readTurns(fixture.sdk, filePath)).toEqual([
      {
        turnId: "t1",
        turnOrder: 1,
        status: "closed",
        memberMessageIds: ["m1", "m2"],
        openedAtEventOrder: 0,
        closedAtEventOrder: 3,
        derivations: CLOSED_TURN_DERIVATIONS("t1"),
      },
      {
        turnId: "t2",
        turnOrder: 2,
        status: "open",
        memberMessageIds: [],
        openedAtEventOrder: 3,
      },
    ]);
  });

  test("TC-3.4: turn_end on an empty open turn is recorded but inert; the next prompt uses that turn", async () => {
    const fixture = serviceFixture();
    const { filePath } = await fixture.createThread();
    const orphan = await send(fixture.sdk, filePath, [validEvent("turn_end")]);
    expect(orphan.turnTransitions).toEqual([]);
    expect(orphan.events[0]!.outcome).toBe("recorded");

    const events = await fixture.sdk.intakeStream.listEvents({ filePath });
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    expect(events.value).toHaveLength(1);
    expect(events.value[0]!.eventOrder).toBe(1);

    expect(await readTurns(fixture.sdk, filePath)).toEqual([
      { turnId: "t1", turnOrder: 1, status: "open", memberMessageIds: [], openedAtEventOrder: 0 },
    ]);

    const next = await send(fixture.sdk, filePath, [validEvent("user_prompt")]);
    expect(next.turnTransitions).toEqual([]);
    expect(await readTurns(fixture.sdk, filePath)).toEqual([
      { turnId: "t1", turnOrder: 1, status: "open", memberMessageIds: ["m2"], openedAtEventOrder: 0 },
    ]);
  });

  test("TC-3.5: post-close messages attach to the current empty turn", async () => {
    const fixture = serviceFixture();
    const { filePath } = await fixture.createThread();
    await send(fixture.sdk, filePath, [
      validEvent("user_prompt"),
      validEvent("assistant_text"),
      validEvent("turn_end"),
    ]);
    const closedBefore = (await readTurns(fixture.sdk, filePath))[0]!;

    await send(fixture.sdk, filePath, [validEvent("assistant_text")]);
    await send(fixture.sdk, filePath, [validEvent("user_prompt")]);

    const projected = await fixture.sdk.messages.list({ filePath });
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.value.map((message) => message.turnId)).toEqual(["t1", "t1", "t2", "t3"]);

    const turnRecords = await readTurns(fixture.sdk, filePath);
    // Frozenness is behavioral: the closed turn's full record is identical after
    // the later activity.
    expect(turnRecords[0]).toEqual(closedBefore);
    expect(turnRecords[1]).toEqual({
      turnId: "t2",
      turnOrder: 2,
      status: "closed",
      memberMessageIds: ["m4"],
      openedAtEventOrder: 3,
      closedAtEventOrder: 5,
      derivations: CLOSED_TURN_DERIVATIONS("t2"),
    });
    expect(turnRecords[2]).toEqual({
      turnId: "t3",
      turnOrder: 3,
      status: "open",
      memberMessageIds: ["m5"],
      openedAtEventOrder: 5,
    });
  });

  test("TC-3.6: implicit close behaves exactly like explicit close", async () => {
    const explicitFixture = serviceFixture();
    const explicit = await explicitFixture.createThread();
    await send(explicitFixture.sdk, explicit.filePath, [validEvent("user_prompt"), validEvent("assistant_text")]);
    const explicitClose = await send(explicitFixture.sdk, explicit.filePath, [validEvent("turn_end")]);

    const implicitFixture = serviceFixture();
    const implicit = await implicitFixture.createThread();
    await send(implicitFixture.sdk, implicit.filePath, [validEvent("user_prompt"), validEvent("assistant_text")]);
    const implicitClose = await send(implicitFixture.sdk, implicit.filePath, [validEvent("user_prompt")]);

    expect(explicitClose.turnTransitions[0]).toEqual({ action: "closed", turnId: "t1" });
    expect(implicitClose.turnTransitions[0]).toEqual({ action: "closed", turnId: "t1" });
    const explicitT1 = (await readTurns(explicitFixture.sdk, explicit.filePath))[0];
    const implicitT1 = (await readTurns(implicitFixture.sdk, implicit.filePath))[0];
    expect(explicitT1).toEqual(implicitT1);
  });

  test("TC-3.7: two open turns fail any batch with turn_state_corrupt and the batch records nothing", async () => {
    const fixture = serviceFixture();
    const { filePath, threadId } = await fixture.createThread();
    await send(fixture.sdk, filePath, [validEvent("user_prompt"), validEvent("assistant_text")]);
    await corruptTwoOpenTurns(fixture, threadId);

    const baseline = await readBack(fixture.sdk, filePath);

    const failed = await fixture.sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt"),
      validEvent("assistant_text"),
    ]);
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.error.errorClass).toBe("state_corruption");
    expect(failed.error.code).toBe("turn_state_corrupt");

    // The batch recorded nothing on top of the corruption: full read-back diff.
    expect(await readBack(fixture.sdk, filePath)).toEqual(baseline);
  });

  test("zero open turns fail any batch with turn_state_corrupt and the batch records nothing", async () => {
    const fixture = serviceFixture();
    const { filePath, threadId } = await fixture.createThread();
    await closeAllOpenTurns(fixture, threadId);
    const baseline = await readBack(fixture.sdk, filePath);
    const failed = await fixture.sdk.intakeStream.messageEvents({ filePath }, [validEvent("assistant_text")]);
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.error.errorClass).toBe("state_corruption");
    expect(failed.error.code).toBe("turn_state_corrupt");
    expect(await readBack(fixture.sdk, filePath)).toEqual(baseline);
  });

  test("TC-3.8: one batch with two prompts and a turn_end yields two closed turns with correct membership", async () => {
    const fixture = serviceFixture();
    const { filePath } = await fixture.createThread();
    const result = await send(fixture.sdk, filePath, [
      validEvent("user_prompt"),
      validEvent("assistant_text"),
      validEvent("user_prompt"),
      validEvent("assistant_text"),
      validEvent("turn_end"),
    ]);

    expect(result.turnTransitions).toEqual([
      { action: "closed", turnId: "t1" },
      { action: "opened", turnId: "t2" },
      { action: "closed", turnId: "t2" },
      { action: "opened", turnId: "t3" },
    ]);

    expect(await readTurns(fixture.sdk, filePath)).toEqual([
      {
        turnId: "t1",
        turnOrder: 1,
        status: "closed",
        memberMessageIds: ["m1", "m2"],
        openedAtEventOrder: 0,
        closedAtEventOrder: 3,
        derivations: CLOSED_TURN_DERIVATIONS("t1"),
      },
      {
        turnId: "t2",
        turnOrder: 2,
        status: "closed",
        memberMessageIds: ["m3", "m4"],
        openedAtEventOrder: 3,
        closedAtEventOrder: 5,
        derivations: CLOSED_TURN_DERIVATIONS("t2"),
      },
      {
        turnId: "t3",
        turnOrder: 3,
        status: "open",
        memberMessageIds: [],
        openedAtEventOrder: 5,
      },
    ]);
  });

  test("TC-5.4: resending recorded events causes no transition and leaves turn state unchanged", async () => {
    const fixture = serviceFixture();
    const { filePath } = await fixture.createThread();
    const prompt = validEvent("user_prompt");
    const end = validEvent("turn_end");
    await send(fixture.sdk, filePath, [prompt, validEvent("assistant_text"), end]);
    await send(fixture.sdk, filePath, [validEvent("user_prompt")]); // t2 now open
    const baseline = await readBack(fixture.sdk, filePath);

    const resend = await send(fixture.sdk, filePath, [prompt, end]);
    expect(resend.events.map((entry) => entry.outcome)).toEqual(["skipped", "skipped"]);
    expect(resend.turnTransitions).toEqual([]);
    expect(await readBack(fixture.sdk, filePath)).toEqual(baseline);
  });
});

describe("TC-4.4: error classes carry distinct classes with stable codes", () => {
  // The frozen test compares three error classes (caller_error, state_corruption,
  // system_error). The system_error leg is a filesystem/registry storage_failure
  // with no Convex analog (no per-thread SQLite file, no filesystem registry), so
  // this port asserts the two reachable classes and their stable codes; the
  // three-way set equality has no analog. See the ledger.
  test("validation and corruption failures carry two distinct classes with stable codes", async () => {
    const callerFixture = serviceFixture();
    const caller = await callerFixture.createThread();
    const callerLeg = await callerFixture.sdk.intakeStream.messageEvents({ filePath: caller.filePath }, [
      { ...validEvent("user_prompt"), eventKind: "bogus" } as unknown as MessageEventInput,
    ]);
    expect(callerLeg.ok).toBe(false);
    if (callerLeg.ok) return;
    expect(callerLeg.error.errorClass).toBe("caller_error");
    expect(callerLeg.error.code).toBe("invalid_event");

    const corruptFixture = serviceFixture();
    const corrupt = await corruptFixture.createThread();
    await send(corruptFixture.sdk, corrupt.filePath, [validEvent("user_prompt")]);
    await corruptTwoOpenTurns(corruptFixture, corrupt.threadId);
    const corruptionLeg = await corruptFixture.sdk.intakeStream.messageEvents({ filePath: corrupt.filePath }, [
      validEvent("assistant_text"),
    ]);
    expect(corruptionLeg.ok).toBe(false);
    if (corruptionLeg.ok) return;
    expect(corruptionLeg.error.errorClass).toBe("state_corruption");
    expect(corruptionLeg.error.code).toBe("turn_state_corrupt");

    const classes = new Set([callerLeg.error.errorClass, corruptionLeg.error.errorClass]);
    expect(classes.size).toBe(2);
  });
});
