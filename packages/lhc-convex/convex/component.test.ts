/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");
const instance = "component-test";
const config = { mode: "manual" };
const modelCallHandle = "unused-by-deterministic-test";

type Success<T> = { ok: true; value: T };

async function createThread(t: ReturnType<typeof convexTest>, filePath: string): Promise<string> {
  const result = await t.mutation(api.threads.newThread, {
    instance,
    config,
    modelCallHandle,
    input: { filePath },
  });
  expect(result.ok).toBe(true);
  return (result as Success<{ threadId: string }>).value.threadId;
}

function event(
  eventKind: "user_prompt" | "assistant_text" | "tool_call" | "tool_result" | "turn_end",
  idempotencyKey: string,
  payload: Record<string, unknown>,
) {
  return { eventKind, idempotencyKey, actor: "test", harness: "convex-test", payload };
}

describe("component queue", () => {
  test("claims queued work in insertion order", async () => {
    const t = convexTest(schema, modules);
    const threadId = await createThread(t, "fifo-thread");
    await t.mutation(api.intake.messageEvents, {
      instance,
      config,
      modelCallHandle,
      ref: { threadId },
      events: [
        event("user_prompt", "fifo-1", { text: "[First]" }),
        event("user_prompt", "fifo-2", { text: "[Second]" }),
      ],
    });

    const claimed = [];
    for (let index = 0; index < 3; index += 1) {
      claimed.push((await t.mutation(internal.queue.claim, { instance, thread: threadId }))?.item.workItem);
    }
    expect(claimed).toEqual(["w1", "w2", "w3"]);
  });

  test("validates the whole closed event batch before writing anything", async () => {
    const t = convexTest(schema, modules);
    const threadId = await createThread(t, "validation-thread");
    const rejected = await t.mutation(api.intake.messageEvents, {
      instance,
      config,
      modelCallHandle,
      ref: { threadId },
      events: [
        event("user_prompt", "valid-first", { text: "must not be committed" }),
        {
          eventKind: "tool_call",
          idempotencyKey: "invalid-second",
          actor: "test",
          harness: "convex-test",
          payload: { toolCallId: "call-1", toolName: "read", arguments: {}, extra: true },
        },
      ],
    });
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: "invalid_event", eventIndex: 1 },
    });

    const events = await t.query(api.intake.listEvents, { instance, ref: { threadId } });
    expect(events).toEqual({ ok: true, value: [] });
  });

  test("one drain action processes the FIFO serially, including work enqueued by completion", async () => {
    const t = convexTest(schema, modules);
    const threadId = await createThread(t, "serial-thread");
    const written = await t.mutation(api.intake.messageEvents, {
      instance,
      config,
      modelCallHandle,
      ref: { threadId },
      events: [
        event("user_prompt", "e1", { text: "[Request interrupted by user]" }),
        event("assistant_text", "e2", { text: "Acknowledged." }),
        event("tool_call", "e3", { toolCallId: "call-1", toolName: "read", arguments: { path: "README.md" } }),
        event("tool_result", "e4", { toolCallId: "call-1", content: "README contents", isError: false }),
        event("turn_end", "e5", {}),
      ],
    });
    expect(written.ok).toBe(true);

    const drained = await t.action(api.work.drain, { instance, ref: { threadId } });
    expect(drained).toMatchObject({
      ok: true,
      value: { claimed: 4, completed: 4, failed: 0, blocked: 0, remaining: 0 },
    });

    const work = await t.query(api.work.status, { instance, ref: { threadId } });
    expect(work).toEqual({ ok: true, value: { queued: 0, running: 0, drainScheduled: false } });

    const message = await t.query(api.records.showMessage, {
      instance,
      ref: { threadId },
      messageId: "m1",
    });
    expect(message).toMatchObject({
      ok: true,
      value: {
        derivations: [
          {
            derivationType: "smoothed_prompt",
            state: "ready",
            content: "[Request interrupted by user]",
          },
        ],
      },
    });

    const turns = await t.query(api.records.listTurns, { instance, ref: { threadId } });
    expect(turns).toMatchObject({
      ok: true,
      value: [
        {
          turnId: "t1",
          status: "closed",
          memberMessageIds: ["m1", "m2", "m3", "m4"],
          chunkId: "c1",
          derivations: [
            { derivationType: "detailed_turn_compression", state: "ready" },
            { derivationType: "pre_detailed_assembly", state: "ready" },
            { derivationType: "turn_rendering", state: "ready" },
          ],
        },
        { turnId: "t2", status: "open", memberMessageIds: [] },
      ],
    });
    expect((turns as Success<Array<{ derivations: Array<{ derivationType: string; content?: string }> }>>).value[0])
      .toMatchObject({
        derivations: [
          {},
          {},
          { derivationType: "turn_rendering", content: expect.stringContaining("[tool run · read · 1 call · 1 succeeded]") },
        ],
      });

    const explicit = await t.action(api.work.deriveMessages, {
      instance,
      ref: { threadId },
      messageIds: ["m1", "m2"],
    });
    expect(explicit).toEqual({
      ok: true,
      value: [
        { messageId: "m1", outcome: "derived", sourceVersion: 2 },
        { messageId: "m2", outcome: "not_derivable" },
      ],
    });

    const edited = await t.mutation(api.records.editMessage, {
      instance,
      ref: { threadId },
      messageId: "m2",
      content: "Updated acknowledgement.",
    });
    expect(edited).toMatchObject({
      ok: true,
      value: {
        changed: { messageIds: ["m2"], turnIds: [] },
        queued: [{ kind: "turn_derivation" }, { kind: "detailed_turn_compression" }],
      },
    });
    await t.action(api.work.drain, { instance, ref: { threadId } });

    const removed = await t.mutation(api.records.removeMessage, {
      instance,
      ref: { threadId },
      messageId: "m2",
    });
    expect(removed).toMatchObject({ ok: true, value: { changed: { messageIds: ["m2"], turnIds: [] } } });
    const deleted = await t.query(api.records.showMessage, {
      instance,
      ref: { threadId },
      messageId: "m2",
    });
    expect(deleted).toMatchObject({ ok: true, value: { messageId: "m2", deleted: true } });
  });

  test("a crashed running item never gates later queued work", async () => {
    const t = convexTest(schema, modules);
    const threadId = await createThread(t, "dead-running-thread");
    const written = await t.mutation(api.intake.messageEvents, {
      instance,
      config,
      modelCallHandle,
      ref: { threadId },
      events: [
        event("user_prompt", "e1", { text: "[First marker]" }),
        event("user_prompt", "e2", { text: "[Second marker]" }),
      ],
    });
    expect(written.ok).toBe(true);

    const stranded = await t.mutation(internal.queue.claim, { instance, thread: threadId });
    expect(stranded?.item).toMatchObject({ workItem: "w1", status: "running" });

    const drained = await t.action(api.work.drain, { instance, ref: { threadId } });
    expect(drained).toMatchObject({
      ok: true,
      value: { claimed: 3, completed: 3, failed: 0, blocked: 0, remaining: 0 },
    });
    const work = await t.query(api.work.status, { instance, ref: { threadId } });
    expect(work).toEqual({ ok: true, value: { queued: 0, running: 1, drainScheduled: false } });

    const second = await t.query(api.records.showMessage, {
      instance,
      ref: { threadId },
      messageId: "m2",
    });
    expect(second).toMatchObject({
      ok: true,
      value: { derivations: [{ derivationType: "smoothed_prompt", state: "ready", content: "[Second marker]" }] },
    });
  });
});
