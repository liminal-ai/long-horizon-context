import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BatchResult,
  initLhc,
  type Lhc,
  type MessageEventInput,
  type OpResult,
  type SdkConfig,
} from "../src/index.js";
import { createInferenceCallbacksDouble, openRaw, type TempStore, tempStore, validEvent } from "./fixtures/index.js";

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
});

function unwrap<T>(result: OpResult<T>): T {
  if (!result.ok) throw new Error(`expected ok result, got ${result.error.code}: ${result.error.reason}`);
  return result.value;
}

function manualSdk(chunkTargetProjectedTokens = 90): Lhc {
  const config: SdkConfig = {
    tokenFamily: "o200k",
    inferenceCallbacks: createInferenceCallbacksDouble(),
    mode: "manual",
    lease: { durationMs: 5000 },
    guards: { detailedTurnCompression: { tinyTurnTokens: 1 } },
    chunkPolicy: { targetProjectedTokens: chunkTargetProjectedTokens, maxProjectedTokens: 4400 },
    toolResult: { smallTierTokens: 1, smallTargetRatio: 0.15, midTargetRatio: 0.04 },
  };
  return initLhc(config);
}

async function newThread(sdk: Lhc): Promise<string> {
  const created = await sdk.threads.newThread({ filePath: store.threadPath(), registryPath: store.registryPath });
  if (!created.ok) throw new Error(`thread creation failed: ${created.error.reason}`);
  return created.value.filePath;
}

async function send(sdk: Lhc, filePath: string, batch: readonly MessageEventInput[]): Promise<BatchResult> {
  const result = await sdk.intakeStream.messageEvents({ filePath }, batch);
  if (!result.ok) throw new Error(`batch failed: ${result.error.code} ${result.error.reason}`);
  return result.value;
}

async function drain(sdk: Lhc, filePath: string): Promise<void> {
  const report = await sdk.work.drain({ filePath });
  if (!report.ok) throw new Error(`drain failed: ${report.error.reason}`);
}

interface SentTurn {
  marker: string;
  events: MessageEventInput[];
  messageIds: string[];
  endOrder: number;
}

const FILLER = " filler words to give this turn some token weight for compaction purposes here";

async function sendTurn(sdk: Lhc, filePath: string, marker: string): Promise<SentTurn> {
  const events = [
    validEvent("user_prompt", { payload: { text: `${marker} user asks${FILLER}` } }),
    validEvent("assistant_text", { payload: { text: `${marker} assistant answers${FILLER}` } }),
    validEvent("turn_end"),
  ];
  const result = await send(sdk, filePath, events);
  return {
    marker,
    events,
    messageIds: result.events.flatMap((entry) => (entry.messageId === undefined ? [] : [entry.messageId])),
    endOrder: result.threadPosition.lastEventOrder,
  };
}

async function sendRollback(sdk: Lhc, filePath: string, keepThroughEventOrder: number): Promise<BatchResult> {
  return send(sdk, filePath, [validEvent("rollback", { payload: { keepThroughEventOrder, reason: "test rewind" } })]);
}

async function sessionJson(sdk: Lhc, filePath: string): Promise<string> {
  const view = unwrap(await sdk.threadView.getSessionThreadView({ filePath }));
  return JSON.stringify(view.entries);
}

async function llmText(sdk: Lhc, filePath: string): Promise<string> {
  const context = unwrap(await sdk.threadView.getLlmRequestContext({ filePath }));
  return context.messages.map((message) => message.content.map((part) => part.text).join("")).join("\n");
}

function servedSourceIds(session: string): string[] {
  return [...session.matchAll(/"messageId":"(m\d+)"/g)].map((match) => match[1] as string);
}

function rawViewRows(filePath: string): { views: number; bandText: string } {
  const db = openRaw(filePath);
  try {
    const views = db.prepare(`SELECT COUNT(*) AS n FROM thread_view`).get() as { n: number | bigint };
    const bands = db.prepare(`SELECT rendered_text FROM thread_view_band ORDER BY band`).all() as Array<{
      rendered_text: string;
    }>;
    return { views: Number(views.n), bandText: bands.map((band) => band.rendered_text).join("\n") };
  } finally {
    db.close();
  }
}

function rawOpenTurnCount(filePath: string): number {
  const db = openRaw(filePath);
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM turns WHERE status = 'open'`).get() as {
      n: number | bigint;
    };
    return Number(row.n);
  } finally {
    db.close();
  }
}

describe("rollback: core serving", () => {
  it("mid-thread rollback serves kept turns only and keeps discarded content in the record", async () => {
    const sdk = manualSdk();
    const filePath = await newThread(sdk);
    const t1 = await sendTurn(sdk, filePath, "RBKEEP1");
    const t2 = await sendTurn(sdk, filePath, "RBDROP2");
    const t3 = await sendTurn(sdk, filePath, "RBDROP3");
    await drain(sdk, filePath);

    const rolled = await sendRollback(sdk, filePath, t1.endOrder);
    expect(rolled.events).toEqual([{ idempotencyKey: expect.any(String), outcome: "recorded" }]);
    expect(rolled.turnTransitions).toEqual([]);

    const session = await sessionJson(sdk, filePath);
    expect(session).toContain("RBKEEP1");
    expect(session).not.toContain("RBDROP2");
    expect(session).not.toContain("RBDROP3");
    expect(servedSourceIds(session).sort()).toEqual([...t1.messageIds].sort());

    const llm = await llmText(sdk, filePath);
    expect(llm).toContain("RBKEEP1");
    expect(llm).not.toContain("RBDROP");

    const live = unwrap(await sdk.messages.list({ filePath }));
    expect(live.map((message) => message.messageId)).toEqual(t1.messageIds);

    const all = unwrap(await sdk.messages.list({ filePath }, { includeDeleted: true }));
    expect(all).toHaveLength(6);
    const hidden = all.filter((message) => message.deleted === true);
    expect(hidden.map((message) => message.messageId).sort()).toEqual([...t2.messageIds, ...t3.messageIds].sort());
    expect(JSON.stringify(hidden)).toContain("RBDROP2");

    const turns = unwrap(await sdk.turns.listTurns({ filePath }));
    expect(turns.map((turn) => [turn.turnId, turn.status])).toEqual([
      ["t1", "closed"],
      ["t4", "open"],
    ]);
    expect(rawOpenTurnCount(filePath)).toBe(1);

    const events = unwrap(await sdk.intakeStream.listEvents({ filePath }));
    expect(events.map((event) => event.eventKind)).toEqual([
      "user_prompt",
      "assistant_text",
      "turn_end",
      "user_prompt",
      "assistant_text",
      "turn_end",
      "user_prompt",
      "assistant_text",
      "turn_end",
      "rollback",
    ]);
    const rollbackEvent = events[9];
    if (rollbackEvent?.eventKind !== "rollback") throw new Error("expected rollback event at position 10");
    expect(rollbackEvent.payload).toEqual({ keepThroughEventOrder: t1.endOrder, reason: "test rewind" });
  });

  it("append after rollback grows the kept branch in order", async () => {
    const sdk = manualSdk();
    const filePath = await newThread(sdk);
    const t1 = await sendTurn(sdk, filePath, "RBKEEP1");
    await sendTurn(sdk, filePath, "RBDROP2");
    await sendRollback(sdk, filePath, t1.endOrder);
    const tNew = await sendTurn(sdk, filePath, "RBNEW3");
    await drain(sdk, filePath);

    const session = await sessionJson(sdk, filePath);
    expect(session.indexOf("RBKEEP1")).toBeGreaterThanOrEqual(0);
    expect(session.indexOf("RBNEW3")).toBeGreaterThan(session.indexOf("RBKEEP1"));
    expect(session).not.toContain("RBDROP2");
    expect(servedSourceIds(session)).toEqual([...t1.messageIds, ...tNew.messageIds]);

    const turns = unwrap(await sdk.turns.listTurns({ filePath }));
    expect(turns.map((turn) => turn.memberMessageIds)).toEqual([t1.messageIds, tNew.messageIds, []]);
  });

  it("retrieval answers deleted for hidden turns and messages, and serves kept neighbours", async () => {
    const sdk = manualSdk();
    const filePath = await newThread(sdk);
    const t1 = await sendTurn(sdk, filePath, "RBKEEP1");
    const t2 = await sendTurn(sdk, filePath, "RBDROP2");
    await drain(sdk, filePath);
    await sendRollback(sdk, filePath, t1.endOrder);

    const turns = unwrap(await sdk.retrieval.getTurns({ filePath }, ["t2", "t1"]));
    expect(turns.served.map((turn) => turn.turnId)).toEqual(["t1"]);
    expect(turns.served[0]?.text).toContain("RBKEEP1");
    expect(turns.unserved).toEqual([{ id: "t2", reason: "deleted" }]);

    const hiddenId = t2.messageIds[0] as string;
    const keptId = t1.messageIds[0] as string;
    const messages = unwrap(await sdk.retrieval.getMessages({ filePath }, [hiddenId, keptId]));
    expect(messages.served.map((message) => message.messageId)).toEqual([keptId]);
    expect(messages.unserved).toEqual([{ id: hiddenId, reason: "deleted" }]);
  });
});

describe("rollback: compacted views", () => {
  const COMPACT_PARAMS = { lowerBound: 200, percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 } };

  it("rollback behind the compact point drops stored bands and a recompact stays clean", async () => {
    const sdk = manualSdk();
    const filePath = await newThread(sdk);
    const turns: SentTurn[] = [];
    for (let index = 1; index <= 10; index += 1) {
      turns.push(await sendTurn(sdk, filePath, `RBMK${index}Z`));
      await drain(sdk, filePath);
    }
    const receipt = unwrap(await sdk.threadView.compact({ filePath }, { params: COMPACT_PARAMS }));
    const keepThrough = (turns[6] as SentTurn).endOrder;
    expect(receipt.compactPoint).toBeGreaterThan(keepThrough);

    const before = rawViewRows(filePath);
    expect(before.views).toBe(1);
    expect(before.bandText).toContain("RBMK8Z");
    expect(before.bandText).toContain("RBMK9Z");
    expect(await llmText(sdk, filePath)).toContain("RBMK8Z");

    await sendRollback(sdk, filePath, keepThrough);

    const dropped = rawViewRows(filePath);
    expect(dropped.views).toBe(0);
    expect(dropped.bandText).toBe("");
    expect(unwrap(await sdk.threadView.describe({ filePath }))).toBeNull();

    const sessionAfter = await sessionJson(sdk, filePath);
    expect(sessionAfter).toContain("RBMK7Z");
    expect(sessionAfter).not.toContain("RBMK8Z");
    expect(sessionAfter).not.toContain("RBMK9Z");
    expect(sessionAfter).not.toContain("RBMK10Z");
    const llmAfter = await llmText(sdk, filePath);
    expect(llmAfter).not.toContain("RBMK8Z");
    expect(llmAfter).not.toContain("RBMK9Z");

    await drain(sdk, filePath);
    unwrap(await sdk.threadView.compact({ filePath }, { params: COMPACT_PARAMS }));
    await drain(sdk, filePath);

    const rebuilt = rawViewRows(filePath);
    expect(rebuilt.bandText).not.toContain("RBMK8Z");
    expect(rebuilt.bandText).not.toContain("RBMK9Z");
    expect(rebuilt.bandText).not.toContain("RBMK10Z");
    const sessionRebuilt = await sessionJson(sdk, filePath);
    expect(sessionRebuilt).not.toContain("RBMK8Z");
    expect(sessionRebuilt).not.toContain("RBMK10Z");
    const stored = unwrap(await sdk.threadView.describe({ filePath }));
    const subjectIds = (stored?.arrangement ?? []).map((entry) => entry.subjectId);
    expect(subjectIds).not.toContain("t8");
    expect(subjectIds).not.toContain("t9");
    expect(subjectIds).not.toContain("t10");
  });

  it("a straddling rollback rebuilds the kept turn prefix without the hidden tail", async () => {
    const sdk = manualSdk();
    const filePath = await newThread(sdk);
    const sent = await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: `RBSTRAD user asks${FILLER}` } }),
      validEvent("assistant_text", { payload: { text: `RBSTRAD first answer kept${FILLER}` } }),
      validEvent("assistant_text", { payload: { text: `RBSTRAD second answer dropped${FILLER}` } }),
      validEvent("turn_end"),
    ]);
    const messageIds = sent.events.flatMap((entry) => (entry.messageId === undefined ? [] : [entry.messageId]));
    await drain(sdk, filePath);

    const kept = unwrap(await sdk.retrieval.getTurns({ filePath }, ["t1"]));
    expect(kept.served[0]?.text).toContain("second answer dropped");

    const rolled = await sendRollback(sdk, filePath, sent.threadPosition.lastEventOrder - 2);
    expect(rolled.queuedWork.length).toBeGreaterThan(0);
    await drain(sdk, filePath);

    const live = unwrap(await sdk.messages.list({ filePath }));
    expect(live.map((message) => message.messageId)).toEqual(messageIds.slice(0, 2));
    const turns = unwrap(await sdk.turns.listTurns({ filePath }));
    expect(turns[0]?.memberMessageIds).toEqual(messageIds.slice(0, 2));

    const after = unwrap(await sdk.retrieval.getTurns({ filePath }, ["t1"]));
    expect(after.served[0]?.text).toContain("first answer kept");
    expect(after.served[0]?.text).not.toContain("second answer dropped");
    expect(await sessionJson(sdk, filePath)).not.toContain("second answer dropped");
    expect(await llmText(sdk, filePath)).not.toContain("second answer dropped");
  });
});

function messageIdsOf(result: BatchResult): string[] {
  return result.events.flatMap((entry) => (entry.messageId === undefined ? [] : [entry.messageId]));
}

async function liveMessageIds(sdk: Lhc, filePath: string): Promise<string[]> {
  return unwrap(await sdk.messages.list({ filePath })).map((message) => message.messageId);
}

async function turnShape(sdk: Lhc, filePath: string): Promise<Array<[string, string, string[]]>> {
  const turns = unwrap(await sdk.turns.listTurns({ filePath }));
  return turns.map((turn) => [turn.turnId, turn.status, turn.memberMessageIds]);
}

describe("rollback: rollback of rollback", () => {
  it("each rollback hides more, an anchor in a discarded region unhides nothing, and redo needs fresh keys", async () => {
    const sdk = manualSdk();
    const filePath = await newThread(sdk);
    const t1 = await sendTurn(sdk, filePath, "RRKEEP1");
    const t2 = await sendTurn(sdk, filePath, "RRDROPA2");
    const t3 = await sendTurn(sdk, filePath, "RRDROPB3");
    await sendRollback(sdk, filePath, t2.endOrder);
    const t4 = await sendTurn(sdk, filePath, "RRNEW4");
    expect(await liveMessageIds(sdk, filePath)).toEqual([...t1.messageIds, ...t2.messageIds, ...t4.messageIds]);

    await sendRollback(sdk, filePath, t1.endOrder);
    expect(await liveMessageIds(sdk, filePath)).toEqual(t1.messageIds);

    await sendRollback(sdk, filePath, t3.endOrder);
    expect(await liveMessageIds(sdk, filePath)).toEqual(t1.messageIds);

    const resent = await send(sdk, filePath, t3.events);
    expect(resent.events.map((entry) => entry.outcome)).toEqual(["skipped", "skipped", "skipped"]);
    expect(await sessionJson(sdk, filePath)).not.toContain("RRDROPB3");

    const redo = await sendTurn(sdk, filePath, "RRDROPB3");
    const t6 = await sendTurn(sdk, filePath, "RRNEW6");
    await sendRollback(sdk, filePath, redo.endOrder);
    await drain(sdk, filePath);
    expect(await liveMessageIds(sdk, filePath)).toEqual([...t1.messageIds, ...redo.messageIds]);
    const session = await sessionJson(sdk, filePath);
    expect(session.indexOf("RRDROPB3")).toBeGreaterThan(session.indexOf("RRKEEP1"));
    for (const gone of ["RRDROPA2", "RRNEW4", t6.marker]) expect(session).not.toContain(gone);
  });
});

describe("rollback: open turn", () => {
  it("a rollback inside the open turn keeps it open and turn_end closes the kept prefix", async () => {
    const sdk = manualSdk();
    const filePath = await newThread(sdk);
    const t1 = await sendTurn(sdk, filePath, "OTKEEP1");
    const open = await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: `OTKEEP2 user asks${FILLER}` } }),
      validEvent("assistant_text", { payload: { text: `OTKEEP2 first answer${FILLER}` } }),
      validEvent("assistant_text", { payload: { text: `OTDROP2 second answer${FILLER}` } }),
    ]);
    const openIds = messageIdsOf(open);

    const rolled = await sendRollback(sdk, filePath, open.threadPosition.lastEventOrder - 1);
    expect(rolled.turnTransitions).toEqual([]);
    expect(rolled.queuedWork).toEqual([]);
    expect(await turnShape(sdk, filePath)).toEqual([
      ["t1", "closed", t1.messageIds],
      ["t2", "open", openIds.slice(0, 2)],
    ]);

    const closed = await send(sdk, filePath, [validEvent("turn_end")]);
    expect(closed.turnTransitions).toEqual([
      { action: "closed", turnId: "t2" },
      { action: "opened", turnId: "t3" },
    ]);
    await drain(sdk, filePath);
    expect(await turnShape(sdk, filePath)).toEqual([
      ["t1", "closed", t1.messageIds],
      ["t2", "closed", openIds.slice(0, 2)],
      ["t3", "open", []],
    ]);
    const session = await sessionJson(sdk, filePath);
    expect(session).toContain("OTKEEP2 first answer");
    expect(session).not.toContain("OTDROP2");
  });

  it("a rollback that empties the open turn lets the next prompt join it", async () => {
    const sdk = manualSdk();
    const filePath = await newThread(sdk);
    const t1 = await sendTurn(sdk, filePath, "OEKEEP1");
    await send(sdk, filePath, [validEvent("user_prompt", { payload: { text: `OEDROP2 user asks${FILLER}` } })]);
    await sendRollback(sdk, filePath, t1.endOrder);
    expect(await turnShape(sdk, filePath)).toEqual([
      ["t1", "closed", t1.messageIds],
      ["t2", "open", []],
    ]);

    const next = await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: `OENEW2 user asks${FILLER}` } }),
    ]);
    expect(next.turnTransitions).toEqual([]);
    expect(await turnShape(sdk, filePath)).toEqual([
      ["t1", "closed", t1.messageIds],
      ["t2", "open", messageIdsOf(next)],
    ]);
    expect(rawOpenTurnCount(filePath)).toBe(1);
  });
});

describe("rollback: anchor validation", () => {
  it("refuses an anchor at its own position and rolls the whole batch back", async () => {
    const sdk = manualSdk();
    const filePath = await newThread(sdk);
    const t1 = await sendTurn(sdk, filePath, "AVKEEP1");
    const refused = await sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: "AVLOST2 user asks" } }),
      validEvent("rollback", { payload: { keepThroughEventOrder: t1.endOrder + 2 } }),
    ]);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toMatchObject({ errorClass: "caller_error", code: "invalid_event" });
    expect(unwrap(await sdk.intakeStream.listEvents({ filePath }))).toHaveLength(t1.events.length);
    expect(await liveMessageIds(sdk, filePath)).toEqual(t1.messageIds);
  });

  it.each([
    { keepThroughEventOrder: -1 },
    { keepThroughEventOrder: 1.5 },
    { keepThroughEventOrder: "1" },
    { keepThroughEventOrder: 1, anchorUuid: "host-uuid" },
    {},
  ])("refuses malformed payload %j", async (payload) => {
    const sdk = manualSdk();
    const filePath = await newThread(sdk);
    await sendTurn(sdk, filePath, "AVKEEP1");
    const malformed = { ...validEvent("rollback"), payload } as unknown as MessageEventInput;
    const refused = await sdk.intakeStream.messageEvents({ filePath }, [malformed]);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toMatchObject({ errorClass: "caller_error", code: "invalid_event" });
  });
});

describe("rollback: rebuild from the event log", () => {
  it("replaying the log into a fresh thread reproduces the hidden set and the served view", async () => {
    const sdk = manualSdk();
    const filePath = await newThread(sdk);
    const t1 = await sendTurn(sdk, filePath, "RLKEEP1");
    await sendTurn(sdk, filePath, "RLDROP2");
    await sendRollback(sdk, filePath, t1.endOrder);
    await sendTurn(sdk, filePath, "RLNEW3");
    const open = await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: `RLKEEP4 user asks${FILLER}` } }),
      validEvent("assistant_text", { payload: { text: `RLDROP4 answer${FILLER}` } }),
    ]);
    await sendRollback(sdk, filePath, open.threadPosition.lastEventOrder - 1);
    await send(sdk, filePath, [validEvent("turn_end")]);
    await drain(sdk, filePath);

    const log = unwrap(await sdk.intakeStream.listEvents({ filePath }));
    const replayPath = await newThread(sdk);
    await send(
      sdk,
      replayPath,
      log.map(({ eventOrder: _order, recordedAt: _at, ...input }) => input as MessageEventInput),
    );
    await drain(sdk, replayPath);

    const snapshot = async (path: string) => ({
      events: unwrap(await sdk.intakeStream.listEvents({ filePath: path })).map((event) => [
        event.eventOrder,
        event.idempotencyKey,
      ]),
      messages: unwrap(await sdk.messages.list({ filePath: path }, { includeDeleted: true })).map((message) => [
        message.messageId,
        message.deleted === true,
      ]),
      turns: await turnShape(sdk, path),
      session: servedSourceIds(await sessionJson(sdk, path)),
      llm: await llmText(sdk, path),
    });
    const original = await snapshot(filePath);
    expect(original.messages.filter(([, deleted]) => deleted)).toHaveLength(3);
    expect(original.llm).not.toContain("RLDROP");
    expect(await snapshot(replayPath)).toEqual(original);
  });
});

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

describe("rollback: interleaved append, delete, compact, rollback", () => {
  const COMPACT_PARAMS = { lowerBound: 200, percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 } };
  const STEPS = 40;

  it.each([1, 2, 3, 4])("seed %i keeps discarded text out of every served surface", async (seed) => {
    const random = seededRandom(seed);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const sdk = manualSdk();
    const filePath = await newThread(sdk);
    const live = new Map<string, { marker: string; order: number; removable: boolean }>();
    const discarded = new Map<string, string>();
    const ops: string[] = [];
    let turnCount = 0;

    const appendTurn = async () => {
      turnCount += 1;
      const markers = [`PZ${turnCount}U`, `PZ${turnCount}A`];
      const result = await send(sdk, filePath, [
        validEvent("user_prompt", { payload: { text: `${markers[0]} user asks${FILLER}` } }),
        validEvent("assistant_text", { payload: { text: `${markers[1]} assistant answers${FILLER}` } }),
        validEvent("turn_end"),
      ]);
      const last = result.threadPosition.lastEventOrder;
      messageIdsOf(result).forEach((messageId, index) => {
        live.set(messageId, { marker: markers[index] as string, order: last - 2 + index, removable: index === 1 });
      });
    };

    for (let step = 0; step < STEPS; step += 1) {
      const roll = random();
      const removable = [...live].filter(([, entry]) => entry.removable).map(([messageId]) => messageId);
      if (roll < 0.4 || live.size === 0) {
        ops.push("append");
        await appendTurn();
      } else if (roll < 0.5 && removable.length > 0) {
        const messageId = pick(removable);
        ops.push(`delete ${messageId}`);
        unwrap(await sdk.messages.remove({ filePath }, { messageId }));
        live.delete(messageId);
      } else if (roll < 0.7) {
        ops.push("compact");
        await drain(sdk, filePath);
        unwrap(await sdk.threadView.compact({ filePath }, { params: COMPACT_PARAMS }));
      } else {
        const frontier = unwrap(await sdk.intakeStream.threadFrontier({ filePath })).lastEventOrder;
        const view = unwrap(await sdk.threadView.describe({ filePath }));
        const mode = random();
        const keepThrough =
          mode < 0.4
            ? Math.max(0, frontier - 1 - Math.floor(random() * 8))
            : mode < 0.7 || view === null
              ? Math.floor(random() * (frontier + 1))
              : Math.max(0, view.compactPoint - 1 - Math.floor(random() * 4));
        ops.push(`rollback ${keepThrough}/${frontier}`);
        await sendRollback(sdk, filePath, keepThrough);
        for (const [messageId, entry] of live) {
          if (entry.order <= keepThrough) continue;
          discarded.set(messageId, entry.marker);
          live.delete(messageId);
        }
      }
      await drain(sdk, filePath);

      const turnIds = unwrap(await sdk.turns.listTurns({ filePath })).map((turn) => turn.turnId);
      const retrieved: string[] = [];
      for (let start = 0; start < turnIds.length; start += 32) {
        const batch = unwrap(await sdk.retrieval.getTurns({ filePath }, turnIds.slice(start, start + 32)));
        retrieved.push(...batch.served.map((turn) => turn.text));
      }
      const session = await sessionJson(sdk, filePath);
      const surfaces = {
        session,
        llm: await llmText(sdk, filePath),
        bands: rawViewRows(filePath).bandText,
        retrieval: retrieved.join("\n"),
      };
      const leaks = Object.entries(surfaces).flatMap(([surface, text]) =>
        [...discarded.values()].filter((marker) => text.includes(marker)).map((marker) => `${surface}:${marker}`),
      );
      const context = `seed ${seed} after ${ops.join(", ")}`;
      expect(leaks, context).toEqual([]);
      expect((await liveMessageIds(sdk, filePath)).sort(), context).toEqual([...live.keys()].sort());
      expect(
        servedSourceIds(session).filter((messageId) => discarded.has(messageId)),
        context,
      ).toEqual([]);
      expect(rawOpenTurnCount(filePath), context).toBe(1);
    }
    expect(ops.some((op) => op.startsWith("rollback"))).toBe(true);
    expect(ops).toContain("compact");
    expect(discarded.size).toBeGreaterThan(0);
  });
});
