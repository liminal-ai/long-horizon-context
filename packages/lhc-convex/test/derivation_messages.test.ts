import { describe, expect, test } from "vitest";
import type { DerivationReportEntry, Lhc, MessageEventInput } from "../src/client/index.js";
import { serviceFixture, validEvent } from "./fixtures/index.js";

async function send(sdk: Lhc, filePath: string, batch: readonly MessageEventInput[]) {
  const result = await sdk.intakeStream.messageEvents({ filePath }, batch);
  if (!result.ok) throw new Error(result.error.reason);
  return result.value;
}

async function formOf(sdk: Lhc, filePath: string, subjectId: string, derivationType: string) {
  const report = await sdk.messages.report({ filePath }, { messageId: subjectId });
  if (!report.ok) throw new Error(report.error.reason);
  return report.value.find((row) => row.derivationType === derivationType);
}

async function forms(sdk: Lhc, filePath: string): Promise<DerivationReportEntry[]> {
  const report = await sdk.messages.report({ filePath });
  if (!report.ok) throw new Error(report.error.reason);
  return report.value;
}

describe("message derivation lifecycle", () => {
  test("prompt smoothing lands a ready form readable alongside the message", async () => {
    const fixture = serviceFixture();
    const filePath = (await fixture.createThread()).filePath;
    const text = "please smooth this prompt";
    await send(fixture.sdk, filePath, [validEvent("user_prompt", { payload: { text } })]);
    const drained = await fixture.sdk.work.drain({ filePath });
    expect(drained).toEqual({
      ok: true,
      value: { claimed: 1, completed: 1, failed: 0, blocked: 0, staleDiscarded: 0, remaining: 0 },
    });
    const listed = await fixture.sdk.messages.list({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value[0]?.blocks[0]?.content["text"]).toBe(text);
    expect(listed.value[0]?.derivations).toEqual([
      expect.objectContaining({
        subjectKind: "message",
        subjectId: "m1",
        derivationType: "smoothed_prompt",
        state: "ready",
        content: "canned smoothed_prompt text from the fake host",
        sourceVersion: 1,
      }),
    ]);
    expect(await formOf(fixture.sdk, filePath, "m1", "smoothed_prompt")).toMatchObject({
      state: "ready",
      content: "canned smoothed_prompt text from the fake host",
    });
  });

  test("a tool_call queues no summary", async () => {
    const fixture = serviceFixture();
    const filePath = (await fixture.createThread()).filePath;
    const batch = await send(fixture.sdk, filePath, [validEvent("tool_call")]);
    expect(batch.queuedWork).toEqual([]);
    expect(await fixture.sdk.work.drain({ filePath })).toEqual({
      ok: true,
      value: { claimed: 0, completed: 0, failed: 0, blocked: 0, staleDiscarded: 0, remaining: 0 },
    });
    expect(await formOf(fixture.sdk, filePath, "m1", "tool_result_summary")).toBeUndefined();
  });

  test("smoothing failure lands failed with the provider reason; the message stays readable", async () => {
    const fixture = serviceFixture({ models: { smoothed_prompt: "fail" } });
    const filePath = (await fixture.createThread()).filePath;
    const text = "this prompt will never smooth";
    await send(fixture.sdk, filePath, [validEvent("user_prompt", { payload: { text } })]);
    const drained = await fixture.sdk.work.drain({ filePath });
    expect(drained).toEqual({
      ok: true,
      value: { claimed: 1, completed: 0, failed: 1, blocked: 0, staleDiscarded: 0, remaining: 0 },
    });
    expect(await formOf(fixture.sdk, filePath, "m1", "smoothed_prompt")).toMatchObject({
      state: "failed",
      reason: "provider_failure: other: scripted failure",
    });
    const listed = await fixture.sdk.messages.list({ filePath });
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.value[0]?.blocks[0]?.content["text"]).toBe(text);
  });

  test("message source damage lands blocked rather than failed", async () => {
    const fixture = serviceFixture();
    const filePath = (await fixture.createThread()).filePath;
    await send(fixture.sdk, filePath, [validEvent("user_prompt")]);
    await fixture.test.run(async (ctx) => {
      const blocks = await ctx.db.query("messageBlocks").collect();
      const block = blocks.find((row) => row.instance === fixture.instance && row.message === "m1");
      if (block === undefined) throw new Error("message block missing");
      await ctx.db.patch("messageBlocks", block._id, { content: {} });
    });
    const drained = await fixture.sdk.work.drain({ filePath });
    expect(drained).toEqual({
      ok: true,
      value: { claimed: 1, completed: 0, failed: 0, blocked: 1, staleDiscarded: 0, remaining: 0 },
    });
    expect(await formOf(fixture.sdk, filePath, "m1", "smoothed_prompt")).toMatchObject({
      state: "blocked",
      reason: "source_damaged: prompt m1 has no text block",
    });
  });

  test("non-derivable message kinds queue no work and carry no derivation rows", async () => {
    const fixture = serviceFixture();
    const filePath = (await fixture.createThread()).filePath;
    const batch = await send(fixture.sdk, filePath, [
      validEvent("assistant_text"),
      validEvent("runtime_note"),
      validEvent("assistant_thinking"),
    ]);
    expect(batch.queuedWork).toEqual([]);
    expect(await fixture.sdk.work.drain({ filePath })).toEqual({
      ok: true,
      value: { claimed: 0, completed: 0, failed: 0, blocked: 0, staleDiscarded: 0, remaining: 0 },
    });
    expect(await forms(fixture.sdk, filePath)).toEqual([]);
  });

  test("tool calls create no form while tool results create exactly one summary", async () => {
    const fixture = serviceFixture();
    const filePath = (await fixture.createThread()).filePath;
    const batch = await send(fixture.sdk, filePath, [validEvent("tool_call"), validEvent("tool_result")]);
    expect(batch.queuedWork.map((item) => item.kind)).toEqual(["tool_result_summary"]);
    expect((await fixture.sdk.work.drain({ filePath })).ok).toBe(true);
    expect((await forms(fixture.sdk, filePath)).map((form) => form.derivationType)).toEqual(["tool_result_summary"]);
  });
});
