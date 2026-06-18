// Flow 4: batch validation and rejection (TC-4.1, 4.2, 4.3, 4.5, the
// caller_error + system_error legs of TC-4.4, plus the unknown-field
// strictness and empty actor/harness supplementals). TC-4.4's corruption leg
// lands with Story 4's fixture.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type EventRecord, intakeStream, type MessageEventInput, type ThreadRef, threads } from "../src/index.js";
import { conversationTurn, eventBatch, type TempStore, tempStore, validEvent } from "./fixtures/index.js";

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

async function readBack(filePath: string): Promise<EventRecord[]> {
  const result = await intakeStream.listEvents({ filePath });
  if (!result.ok) throw new Error(`read-back failed: ${result.error.reason}`);
  return result.value;
}

describe("Flow 4 (SDK): batch validation and rejection", () => {
  it("TC-4.1: four invalidity categories, each rejected whole with a named reason", async () => {
    const filePath = await createThread();

    const unknownKind = {
      ...validEvent("user_prompt"),
      eventKind: "mystery_kind",
    } as unknown as MessageEventInput;

    const { idempotencyKey: _dropped, ...withoutKey } = validEvent("user_prompt");
    const missingKey = withoutKey as unknown as MessageEventInput;

    const serverField = {
      ...validEvent("user_prompt"),
      eventOrder: 7,
    } as unknown as MessageEventInput;

    const turnEndWithPayload = {
      ...validEvent("turn_end"),
      payload: { text: "should not be here" },
    } as unknown as MessageEventInput;

    const cases: Array<{ batch: MessageEventInput[]; reason: RegExp }> = [
      { batch: [unknownKind], reason: /unknown event kind/ },
      { batch: [missingKey], reason: /idempotencyKey/ },
      { batch: [serverField], reason: /server-generated.*eventOrder/ },
      { batch: [turnEndWithPayload], reason: /turn_end/ },
    ];

    for (const { batch, reason } of cases) {
      const result = await intakeStream.messageEvents({ filePath }, batch);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.errorClass).toBe("caller_error");
      expect(result.error.code).toBe("invalid_event");
      expect(result.error.eventIndex).toBe(0);
      expect(result.error.reason).toMatch(reason);
    }

    expect(await readBack(filePath)).toEqual([]);
  });

  it("TC-4.2: first failure names index 2; the valid earlier events did not land", async () => {
    const filePath = await createThread();
    const batch = [
      validEvent("user_prompt"),
      validEvent("assistant_text"),
      validEvent("assistant_thinking", { actor: "" }),
    ];

    const result = await intakeStream.messageEvents({ filePath }, batch);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_event");
    expect(result.error.eventIndex).toBe(2);

    expect(await readBack(filePath)).toEqual([]);
  });

  it("TC-4.3: after a rejection the thread reads back logically identical to its baseline", async () => {
    const filePath = await createThread();
    const recorded = await intakeStream.messageEvents({ filePath }, conversationTurn());
    expect(recorded.ok).toBe(true);
    const baseline = await readBack(filePath);
    expect(baseline).toHaveLength(5);

    const rejected = await intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt"),
      { ...validEvent("turn_end"), payload: { oops: 1 } } as unknown as MessageEventInput,
    ]);
    expect(rejected.ok).toBe(false);

    // Logical equality at the read-back level (events at this story; the
    // rollback ladder extends to messages/turns/work in Stories 3-5).
    expect(await readBack(filePath)).toEqual(baseline);
  });

  it("TC-4.4 (caller/system legs): error classes separate; corruption leg is Story 4's", async () => {
    const filePath = await createThread();

    const callerLeg = await intakeStream.messageEvents({ filePath }, [
      { ...validEvent("user_prompt"), eventKind: "bogus" } as unknown as MessageEventInput,
    ]);
    expect(callerLeg.ok).toBe(false);
    if (callerLeg.ok) return;
    expect(callerLeg.error.errorClass).toBe("caller_error");
    expect(callerLeg.error.code).toBe("invalid_event");

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

    expect(callerLeg.error.errorClass).not.toBe(systemLeg.error.errorClass);
  });

  it("TC-4.5: a batch mixing new, duplicate, and invalid events is rejected whole", async () => {
    const filePath = await createThread();
    const original = eventBatch(["user_prompt", "assistant_text"]);
    const recorded = await intakeStream.messageEvents({ filePath }, original);
    expect(recorded.ok).toBe(true);
    const baseline = await readBack(filePath);
    expect(baseline).toHaveLength(2);

    const mixed = [
      validEvent("tool_call"),
      original[0]!, // valid duplicate of a recorded event
      { ...validEvent("turn_end"), payload: { bad: true } } as unknown as MessageEventInput,
    ];
    const rejected = await intakeStream.messageEvents({ filePath }, mixed);
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.error.code).toBe("invalid_event");
    expect(rejected.error.eventIndex).toBe(2);

    // Duplicates' original records unchanged; the new events absent.
    expect(await readBack(filePath)).toEqual(baseline);
  });

  it("strictness supplemental: unknown fields rejected at envelope, event, and payload levels", async () => {
    const filePath = await createThread();

    const envelopeProbe = await intakeStream.messageEvents({ filePath, surprise: true } as unknown as ThreadRef, [
      validEvent("user_prompt"),
    ]);
    expect(envelopeProbe.ok).toBe(false);
    if (envelopeProbe.ok) return;
    expect(envelopeProbe.error.code).toBe("invalid_event");
    expect(envelopeProbe.error.reason).toContain("envelope");

    const eventProbe = await intakeStream.messageEvents({ filePath }, [
      { ...validEvent("user_prompt"), surprise: true } as unknown as MessageEventInput,
    ]);
    expect(eventProbe.ok).toBe(false);
    if (eventProbe.ok) return;
    expect(eventProbe.error.code).toBe("invalid_event");
    expect(eventProbe.error.reason).toContain("event");
    expect(eventProbe.error.reason).toContain("surprise");

    const payloadProbe = await intakeStream.messageEvents({ filePath }, [
      {
        ...validEvent("user_prompt"),
        payload: { text: "hello", surprise: true },
      } as unknown as MessageEventInput,
    ]);
    expect(payloadProbe.ok).toBe(false);
    if (payloadProbe.ok) return;
    expect(payloadProbe.error.code).toBe("invalid_event");
    expect(payloadProbe.error.reason).toContain("payload");
    expect(payloadProbe.error.reason).toContain("surprise");

    expect(await readBack(filePath)).toEqual([]);
  });

  it("strictness supplemental: empty actor and empty harness are rejected", async () => {
    const filePath = await createThread();

    const emptyActor = await intakeStream.messageEvents({ filePath }, [validEvent("user_prompt", { actor: "" })]);
    expect(emptyActor.ok).toBe(false);
    if (emptyActor.ok) return;
    expect(emptyActor.error.code).toBe("invalid_event");
    expect(emptyActor.error.reason).toContain("actor");

    const emptyHarness = await intakeStream.messageEvents({ filePath }, [validEvent("user_prompt", { harness: "" })]);
    expect(emptyHarness.ok).toBe(false);
    if (emptyHarness.ok) return;
    expect(emptyHarness.error.code).toBe("invalid_event");
    expect(emptyHarness.error.reason).toContain("harness");

    expect(await readBack(filePath)).toEqual([]);
  });
});
