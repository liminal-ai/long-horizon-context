// Schema v5 slice 1: turn-scoped host facts (provider usage, turn outcome,
// wall-clock timing). Intake accepts optional payload fields; projection
// writes them; turns/messages reads expose them; empty turn_end stays valid.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { intakeStream, type MessageEventInput, messages, type ThreadRef, threads, turns } from "../src/index.js";
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

async function send(filePath: string, batch: MessageEventInput[]) {
  const result = await intakeStream.messageEvents({ filePath } satisfies ThreadRef, batch);
  if (!result.ok) throw new Error(`fixture batch failed: ${result.error.reason}`);
  return result.value;
}

describe("schema v5 host facts", () => {
  it("empty turn_end payload is still valid and closes the turn without host facts", async () => {
    const filePath = await createThread();
    const result = await send(filePath, [
      validEvent("user_prompt"),
      validEvent("assistant_text"),
      validEvent("turn_end"),
    ]);
    expect(result.events.map((entry) => entry.outcome)).toEqual(["recorded", "recorded", "recorded"]);
    expect(result.turnTransitions).toEqual([
      { action: "closed", turnId: "t1" },
      { action: "opened", turnId: "t2" },
    ]);

    const turnRecords = await turns.listTurns({ filePath });
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

    const db = openRaw(filePath);
    try {
      const row = db
        .prepare(`SELECT outcome, outcome_reason, started_at, ended_at FROM turns WHERE turn_id = 't1'`)
        .get() as {
        outcome: string | null;
        outcome_reason: string | null;
        started_at: string | null;
        ended_at: string | null;
      };
      expect(row.outcome).toBeNull();
      expect(row.outcome_reason).toBeNull();
      expect(row.started_at).toBeNull();
      expect(row.ended_at).toBeNull();
    } finally {
      db.close();
    }
  });

  it("turn_end host facts round-trip intake → storage → turns.listTurns verbatim", async () => {
    const filePath = await createThread();
    const hostFacts = {
      outcome: "aborted" as const,
      outcomeReason: "user cancelled mid-tool",
      startedAt: "2026-07-01T12:00:00.000Z",
      endedAt: "2026-07-01T12:00:04.250Z",
    };
    await send(filePath, [
      validEvent("user_prompt"),
      validEvent("assistant_text"),
      validEvent("turn_end", { payload: hostFacts }),
    ]);

    const listed = await turns.listTurns({ filePath });
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
    const db = openRaw(filePath);
    try {
      const row = db
        .prepare(`SELECT outcome, outcome_reason, started_at, ended_at FROM turns WHERE turn_id = 't1'`)
        .get() as {
        outcome: string;
        outcome_reason: string;
        started_at: string;
        ended_at: string;
      };
      expect(row).toEqual({
        outcome: hostFacts.outcome,
        outcome_reason: hostFacts.outcomeReason,
        started_at: hostFacts.startedAt,
        ended_at: hostFacts.endedAt,
      });
    } finally {
      db.close();
    }

    // Event payload also retains the facts (canonical record).
    const events = await intakeStream.listEvents({ filePath });
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    const turnEnd = events.value.find((event) => event.eventKind === "turn_end");
    expect(turnEnd?.payload).toEqual(hostFacts);
  });

  it("assistant_text providerUsage round-trips byte-level through list and show", async () => {
    const filePath = await createThread();
    // Nested, mixed-type shape — not a fixed column set; fidelity is the point.
    const providerUsage = {
      input_tokens: 1204,
      cached_input_tokens: 900,
      output_tokens: 88,
      reasoning_output_tokens: 12,
      nested: { cache_write: 0, provider: "openai-codex" },
    };
    const usageJson = JSON.stringify(providerUsage);

    await send(filePath, [
      validEvent("user_prompt"),
      validEvent("assistant_text", {
        payload: { text: "done", providerUsage },
      }),
      validEvent("turn_end"),
    ]);

    const listed = await messages.list({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const assistant = listed.value.find((message) => message.kind === "assistant_text");
    expect(assistant).toBeDefined();
    expect(JSON.stringify(assistant!.providerUsage)).toBe(usageJson);

    const shown = await messages.show({ filePath }, assistant!.messageId);
    expect(shown.ok).toBe(true);
    if (!shown.ok) return;
    expect(JSON.stringify(shown.value.providerUsage)).toBe(usageJson);

    const db = openRaw(filePath);
    try {
      const row = db.prepare(`SELECT provider_usage FROM message WHERE message_id = ?`).get(assistant!.messageId) as {
        provider_usage: string;
      };
      // Stored column is the verbatim JSON string.
      expect(row.provider_usage).toBe(usageJson);
    } finally {
      db.close();
    }
  });

  it("assistant_text without providerUsage stores and reads as NULL / absent", async () => {
    const filePath = await createThread();
    await send(filePath, [
      validEvent("user_prompt"),
      validEvent("assistant_text", { payload: { text: "no usage attached" } }),
      validEvent("turn_end"),
    ]);

    const listed = await messages.list({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const assistant = listed.value.find((message) => message.kind === "assistant_text");
    expect(assistant).toBeDefined();
    expect(assistant).not.toHaveProperty("providerUsage");

    const shown = await messages.show({ filePath }, assistant!.messageId);
    expect(shown.ok).toBe(true);
    if (!shown.ok) return;
    expect(shown.value).not.toHaveProperty("providerUsage");

    const db = openRaw(filePath);
    try {
      const row = db.prepare(`SELECT provider_usage FROM message WHERE message_id = ?`).get(assistant!.messageId) as {
        provider_usage: string | null;
      };
      expect(row.provider_usage).toBeNull();
    } finally {
      db.close();
    }
  });

  it("invalid outcome value is rejected whole", async () => {
    const filePath = await createThread();
    const result = await intakeStream.messageEvents({ filePath }, [
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
  });

  it("unknown key in turn_end payload is rejected", async () => {
    const filePath = await createThread();
    const result = await intakeStream.messageEvents({ filePath }, [
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

  it("providerUsage that is not a JSON object is rejected", async () => {
    const filePath = await createThread();
    for (const bad of ["tokens", 12, true, null, [1, 2]]) {
      const result = await intakeStream.messageEvents({ filePath }, [
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

  it("outcome completed alone is valid and projects", async () => {
    const filePath = await createThread();
    await send(filePath, [
      validEvent("user_prompt"),
      validEvent("assistant_text"),
      validEvent("turn_end", { payload: { outcome: "completed" } }),
    ]);
    const listed = await turns.listTurns({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.find((turn) => turn.turnId === "t1")).toMatchObject({
      status: "closed",
      outcome: "completed",
    });
  });
});
