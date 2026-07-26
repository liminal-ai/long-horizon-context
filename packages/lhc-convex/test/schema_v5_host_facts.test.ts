// Schema v5 host facts (docs/schema-v5-turn-host-facts.md) — Convex port of
// packages/lhc/test/schema-v5-host-facts.test.ts.
//
// Substrate adaptations:
//   - raw-SQL storage assertions → direct convex-test db document reads
//   - byte-level provider_usage JSON string → deep-equality on the stored value
//     (event payload already uses v.any() host JSON; document field ordering
//     follows that same store-verbatim precedent)
//   - no SQLite migration ladder (D4 on Convex = optional fields absent on old
//     documents; no backfill). Migration tests stay n/a (PORTING_LEDGER).
import { describe, expect, test } from "vitest";
import type { Lhc, MessageEventInput } from "../src/client/index.js";
import { type ServiceFixture, serviceFixture, validEvent } from "./fixtures/index.js";

async function createThread(fixture: ServiceFixture): Promise<{ filePath: string; threadId: string }> {
  return await fixture.createThread();
}

async function send(sdk: Lhc, filePath: string, batch: MessageEventInput[]) {
  const result = await sdk.intakeStream.messageEvents({ filePath }, batch);
  if (!result.ok) throw new Error(`fixture batch failed: ${result.error.reason}`);
  return result.value;
}

async function readTurnDoc(
  fixture: ServiceFixture,
  thread: string,
  turnId: string,
): Promise<Record<string, unknown> | null> {
  return await fixture.test.run(async (ctx) => {
    const rows = await ctx.db.query("turns").collect();
    const row = rows.find(
      (entry) => entry.instance === fixture.instance && entry.thread === thread && entry.turn === turnId,
    );
    if (row === undefined) return null;
    const { _id, _creationTime, ...rest } = row;
    return rest;
  });
}

async function readMessageDoc(
  fixture: ServiceFixture,
  thread: string,
  messageId: string,
): Promise<Record<string, unknown> | null> {
  return await fixture.test.run(async (ctx) => {
    const rows = await ctx.db.query("messages").collect();
    const row = rows.find(
      (entry) => entry.instance === fixture.instance && entry.thread === thread && entry.message === messageId,
    );
    if (row === undefined) return null;
    const { _id, _creationTime, ...rest } = row;
    return rest;
  });
}

describe("schema v5 host facts", () => {
  test("empty turn_end payload is still valid and closes the turn without host facts", async () => {
    const fixture = serviceFixture();
    const { filePath, threadId } = await createThread(fixture);
    const result = await send(fixture.sdk, filePath, [
      validEvent("user_prompt"),
      validEvent("assistant_text"),
      validEvent("turn_end"),
    ]);
    expect(result.events.map((entry) => entry.outcome)).toEqual(["recorded", "recorded", "recorded"]);
    expect(result.turnTransitions).toEqual([
      { action: "closed", turnId: "t1" },
      { action: "opened", turnId: "t2" },
    ]);

    const turnRecords = await fixture.sdk.turns.listTurns({ filePath });
    expect(turnRecords.ok).toBe(true);
    if (!turnRecords.ok) return;
    const closed = turnRecords.value.find((turn) => turn.turnId === "t1");
    expect(closed).toMatchObject({
      status: "closed",
      closedAtEventOrder: 3,
    });
    expect(closed).not.toHaveProperty("outcome");
    expect(closed).not.toHaveProperty("outcomeReason");
    expect(closed).not.toHaveProperty("startedAt");
    expect(closed).not.toHaveProperty("endedAt");

    const row = await readTurnDoc(fixture, threadId, "t1");
    expect(row).not.toBeNull();
    expect(row).not.toHaveProperty("outcome");
    expect(row).not.toHaveProperty("outcomeReason");
    expect(row).not.toHaveProperty("startedAt");
    expect(row).not.toHaveProperty("endedAt");
  });

  test("turn_end host facts round-trip intake → storage → turns.listTurns verbatim", async () => {
    const fixture = serviceFixture();
    const { filePath, threadId } = await createThread(fixture);
    const hostFacts = {
      outcome: "aborted" as const,
      outcomeReason: "user cancelled mid-tool",
      startedAt: "2026-07-01T12:00:00.000Z",
      endedAt: "2026-07-01T12:00:04.250Z",
    };
    await send(fixture.sdk, filePath, [
      validEvent("user_prompt"),
      validEvent("assistant_text"),
      validEvent("turn_end", { payload: hostFacts }),
    ]);

    const listed = await fixture.sdk.turns.listTurns({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const closed = listed.value.find((turn) => turn.turnId === "t1");
    expect(closed).toMatchObject({
      status: "closed",
      outcome: hostFacts.outcome,
      outcomeReason: hostFacts.outcomeReason,
      startedAt: hostFacts.startedAt,
      endedAt: hostFacts.endedAt,
    });

    // Storage holds the same strings; no rewrite, no defaulting.
    const row = await readTurnDoc(fixture, threadId, "t1");
    expect(row).toMatchObject({
      outcome: hostFacts.outcome,
      outcomeReason: hostFacts.outcomeReason,
      startedAt: hostFacts.startedAt,
      endedAt: hostFacts.endedAt,
    });

    // Event payload also retains the facts (canonical record).
    const events = await fixture.sdk.intakeStream.listEvents({ filePath });
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    const turnEnd = events.value.find((event) => event.eventKind === "turn_end");
    expect(turnEnd?.payload).toEqual(hostFacts);
  });

  test("assistant_text providerUsage round-trips deep-equal through list and show", async () => {
    const fixture = serviceFixture();
    const { filePath, threadId } = await createThread(fixture);
    // Nested, mixed-type shape — not a fixed column set; fidelity is the point.
    const providerUsage = {
      input_tokens: 1204,
      cached_input_tokens: 900,
      output_tokens: 88,
      reasoning_output_tokens: 12,
      nested: { cache_write: 0, provider: "openai-codex" },
    };

    await send(fixture.sdk, filePath, [
      validEvent("user_prompt"),
      validEvent("assistant_text", {
        payload: { text: "done", providerUsage },
      }),
      validEvent("turn_end"),
    ]);

    const listed = await fixture.sdk.messages.list({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const assistant = listed.value.find((message) => message.kind === "assistant_text");
    expect(assistant).toBeDefined();
    expect(assistant!.providerUsage).toEqual(providerUsage);

    const shown = await fixture.sdk.messages.show({ filePath }, assistant!.messageId);
    expect(shown.ok).toBe(true);
    if (!shown.ok) return;
    expect(shown.value.providerUsage).toEqual(providerUsage);

    const row = await readMessageDoc(fixture, threadId, assistant!.messageId);
    expect(row).not.toBeNull();
    // Stored document field is the host object verbatim (deep equality).
    expect(row!["providerUsage"]).toEqual(providerUsage);
  });

  test("assistant_text without providerUsage stores and reads as absent", async () => {
    const fixture = serviceFixture();
    const { filePath, threadId } = await createThread(fixture);
    await send(fixture.sdk, filePath, [
      validEvent("user_prompt"),
      validEvent("assistant_text", { payload: { text: "no usage attached" } }),
      validEvent("turn_end"),
    ]);

    const listed = await fixture.sdk.messages.list({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const assistant = listed.value.find((message) => message.kind === "assistant_text");
    expect(assistant).toBeDefined();
    expect(assistant).not.toHaveProperty("providerUsage");

    const shown = await fixture.sdk.messages.show({ filePath }, assistant!.messageId);
    expect(shown.ok).toBe(true);
    if (!shown.ok) return;
    expect(shown.value).not.toHaveProperty("providerUsage");

    const row = await readMessageDoc(fixture, threadId, assistant!.messageId);
    expect(row).not.toBeNull();
    expect(row).not.toHaveProperty("providerUsage");
  });

  test("invalid outcome value is rejected whole", async () => {
    const fixture = serviceFixture();
    const { filePath } = await createThread(fixture);
    const result = await fixture.sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt"),
      {
        ...validEvent("turn_end"),
        payload: { outcome: "interrupted" },
      } as unknown as MessageEventInput,
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorClass).toBe("caller_error");
    expect(result.error.code).toBe("invalid_event");
    expect(result.error.eventIndex).toBe(1);
    expect(result.error.reason).toMatch(/outcome/);
    expect(result.error.reason).toMatch(/Expected "completed" \| "aborted"/);
  });

  test("unknown key in turn_end payload is rejected", async () => {
    const fixture = serviceFixture();
    const { filePath } = await createThread(fixture);
    const result = await fixture.sdk.intakeStream.messageEvents({ filePath }, [
      {
        ...validEvent("turn_end"),
        payload: { surprise: true },
      } as unknown as MessageEventInput,
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorClass).toBe("caller_error");
    expect(result.error.code).toBe("invalid_event");
    expect(result.error.reason).toMatch(/surprise/);
  });

  test("providerUsage that is not a JSON object is rejected", async () => {
    const fixture = serviceFixture();
    const { filePath } = await createThread(fixture);
    for (const bad of ["tokens", 12, true, null, [1, 2]]) {
      const result = await fixture.sdk.intakeStream.messageEvents({ filePath }, [
        {
          ...validEvent("assistant_text"),
          payload: { text: "hi", providerUsage: bad },
        } as unknown as MessageEventInput,
      ]);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe("invalid_event");
      expect(result.error.reason).toMatch(/providerUsage/);
    }
  });

  test("outcome completed alone is valid and projects", async () => {
    const fixture = serviceFixture();
    const { filePath } = await createThread(fixture);
    await send(fixture.sdk, filePath, [
      validEvent("user_prompt"),
      validEvent("assistant_text"),
      validEvent("turn_end", { payload: { outcome: "completed" } }),
    ]);
    const listed = await fixture.sdk.turns.listTurns({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.find((turn) => turn.turnId === "t1")).toMatchObject({
      status: "closed",
      outcome: "completed",
    });
  });
});
