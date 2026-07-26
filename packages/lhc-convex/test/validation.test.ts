// Flow 4 (public service): batch validation and whole-batch rejection —
// TC-4.1 (four invalidity categories, each rejected at index 0), TC-4.2
// (first-failure index reporting), TC-4.3 and TC-4.5 (whole-batch rollback to
// baseline), TC-4.4's caller_error leg, and the unknown-field / empty
// actor+harness strictness supplementals.
//
// This file ports the non-overlapping PUBLIC-SERVICE legs. The exhaustive
// per-case validator differential is exercised directly by the shared
// `validateEvents` unit-level intake tests; here every rejection flows through
// `intakeStream.messageEvents` end to end.
//
// Substrate-only / structurally-divergent frozen legs:
//   - TC-4.4's system_error (storage_failure) leg writes a regular file where a
//     directory must be so the SQLite registry insert fails. Convex owns
//     storage; there is no filesystem registry to fail, so the caller_error leg
//     is ported and the class-separation assertion (caller_error vs
//     system_error) is dropped (documented n/a).
//   - The strictness supplemental's ENVELOPE probe passes an unknown field on
//     the thread reference. The client's `componentRef` extracts only
//     `threadId`/`filePath` before the mutation runs, so unknown ref fields are
//     normalized away and never reach the component's `validateThreadRef`. The
//     reachable event-level and payload-level unknown-field strictness is
//     ported (both flow through the events array untouched).
import { beforeEach, describe, expect, test } from "vitest";
import type { EventRecord, Lhc, MessageEventInput } from "../src/client/index.js";
import { conversationTurn, eventBatch, type ServiceFixture, serviceFixture, validEvent } from "./fixtures/index.js";

let fixture: ServiceFixture;
let sdk: Lhc;

beforeEach(() => {
  fixture = serviceFixture();
  sdk = fixture.sdk;
});

async function createThread(): Promise<string> {
  return (await fixture.createThread()).filePath;
}

async function readBack(filePath: string): Promise<EventRecord[]> {
  const result = await sdk.intakeStream.listEvents({ filePath });
  if (!result.ok) throw new Error(`read-back failed: ${result.error.reason}`);
  return result.value;
}

describe("Flow 4 (SDK): batch validation and rejection", () => {
  test("TC-4.1: four invalidity categories, each rejected whole with a named reason", async () => {
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
      // turn_end may carry optional host facts, but unknown keys stay closed.
      { batch: [turnEndWithPayload], reason: /"text".*unexpected|unexpected.*"text"/ },
    ];

    for (const { batch, reason } of cases) {
      const result = await sdk.intakeStream.messageEvents({ filePath }, batch);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.errorClass).toBe("caller_error");
      expect(result.error.code).toBe("invalid_event");
      expect(result.error.eventIndex).toBe(0);
      expect(result.error.reason).toMatch(reason);
    }

    expect(await readBack(filePath)).toEqual([]);
  });

  test("TC-4.2: first failure names index 2; the valid earlier events did not land", async () => {
    const filePath = await createThread();
    const batch = [
      validEvent("user_prompt"),
      validEvent("assistant_text"),
      validEvent("assistant_thinking", { actor: "" }),
    ];

    const result = await sdk.intakeStream.messageEvents({ filePath }, batch);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_event");
    expect(result.error.eventIndex).toBe(2);

    expect(await readBack(filePath)).toEqual([]);
  });

  test("TC-4.3: after a rejection the thread reads back logically identical to its baseline", async () => {
    const filePath = await createThread();
    const recorded = await sdk.intakeStream.messageEvents({ filePath }, conversationTurn());
    expect(recorded.ok).toBe(true);
    const baseline = await readBack(filePath);
    expect(baseline).toHaveLength(5);

    const rejected = await sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt"),
      { ...validEvent("turn_end"), payload: { oops: 1 } } as unknown as MessageEventInput,
    ]);
    expect(rejected.ok).toBe(false);

    expect(await readBack(filePath)).toEqual(baseline);
  });

  test("TC-4.4 (caller leg): a structurally invalid event is a caller_error/invalid_event", async () => {
    const filePath = await createThread();

    const callerLeg = await sdk.intakeStream.messageEvents({ filePath }, [
      { ...validEvent("user_prompt"), eventKind: "bogus" } as unknown as MessageEventInput,
    ]);
    expect(callerLeg.ok).toBe(false);
    if (callerLeg.ok) return;
    expect(callerLeg.error.errorClass).toBe("caller_error");
    expect(callerLeg.error.code).toBe("invalid_event");

    expect(await readBack(filePath)).toEqual([]);
  });

  test("TC-4.5: a batch mixing new, duplicate, and invalid events is rejected whole", async () => {
    const filePath = await createThread();
    const original = eventBatch(["user_prompt", "assistant_text"]);
    const recorded = await sdk.intakeStream.messageEvents({ filePath }, original);
    expect(recorded.ok).toBe(true);
    const baseline = await readBack(filePath);
    expect(baseline).toHaveLength(2);

    const mixed = [
      validEvent("tool_call"),
      original[0]!, // valid duplicate of a recorded event
      { ...validEvent("turn_end"), payload: { bad: true } } as unknown as MessageEventInput,
    ];
    const rejected = await sdk.intakeStream.messageEvents({ filePath }, mixed);
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.error.code).toBe("invalid_event");
    expect(rejected.error.eventIndex).toBe(2);

    // Duplicates' original records unchanged; the new events absent.
    expect(await readBack(filePath)).toEqual(baseline);
  });

  test("strictness supplemental: unknown fields rejected at event and payload levels", async () => {
    const filePath = await createThread();

    const eventProbe = await sdk.intakeStream.messageEvents({ filePath }, [
      { ...validEvent("user_prompt"), surprise: true } as unknown as MessageEventInput,
    ]);
    expect(eventProbe.ok).toBe(false);
    if (eventProbe.ok) return;
    expect(eventProbe.error.code).toBe("invalid_event");
    expect(eventProbe.error.reason).toContain("event");
    expect(eventProbe.error.reason).toContain("surprise");

    const payloadProbe = await sdk.intakeStream.messageEvents({ filePath }, [
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

  test("strictness supplemental: empty actor and empty harness are rejected", async () => {
    const filePath = await createThread();

    const emptyActor = await sdk.intakeStream.messageEvents({ filePath }, [validEvent("user_prompt", { actor: "" })]);
    expect(emptyActor.ok).toBe(false);
    if (emptyActor.ok) return;
    expect(emptyActor.error.code).toBe("invalid_event");
    expect(emptyActor.error.reason).toContain("actor");

    const emptyHarness = await sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { harness: "" }),
    ]);
    expect(emptyHarness.ok).toBe(false);
    if (emptyHarness.ok) return;
    expect(emptyHarness.error.code).toBe("invalid_event");
    expect(emptyHarness.error.reason).toContain("harness");

    expect(await readBack(filePath)).toEqual([]);
  });
});
