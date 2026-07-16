import { describe, expect, test } from "vitest";
import { estimateTokens, type DerivationReportEntry, type Lhc, type MessageEventInput } from "../src/client/index.js";
import { serviceFixture, validEvent } from "./fixtures/index.js";

async function send(sdk: Lhc, filePath: string, events: readonly MessageEventInput[]) {
  const result = await sdk.intakeStream.messageEvents({ filePath }, events);
  if (!result.ok) throw new Error(result.error.reason);
  return result.value;
}

async function sendTurn(sdk: Lhc, filePath: string, prompt: string, answer: string) {
  return await send(sdk, filePath, [
    validEvent("user_prompt", { payload: { text: prompt } }),
    validEvent("assistant_text", { payload: { text: answer } }),
    validEvent("turn_end"),
  ]);
}

async function turnForm(sdk: Lhc, filePath: string, subjectId: string, derivationType: string) {
  const report = await sdk.turns.report({ filePath }, { turnId: subjectId });
  if (!report.ok) throw new Error(report.error.reason);
  return report.value.find((row) => row.derivationType === derivationType);
}

async function chunkForm(sdk: Lhc, filePath: string, subjectId: string, derivationType: string) {
  const report = await sdk.turns.report({ filePath }, { chunkId: subjectId });
  if (!report.ok) throw new Error(report.error.reason);
  return report.value.find((row) => row.derivationType === derivationType);
}

async function messageForm(sdk: Lhc, filePath: string, subjectId: string, derivationType: string) {
  const report = await sdk.messages.report({ filePath }, { messageId: subjectId });
  if (!report.ok) throw new Error(report.error.reason);
  return report.value.find((row) => row.derivationType === derivationType);
}

async function liveWork(fixture: ReturnType<typeof serviceFixture>, thread: string) {
  return await fixture.test.run(async (ctx) => {
    const rows = await ctx.db.query("workItems").collect();
    return rows.filter((row) => row.instance === fixture.instance && row.thread === thread);
  });
}

async function deleteWork(fixture: ReturnType<typeof serviceFixture>, thread: string, kind: string) {
  await fixture.test.run(async (ctx) => {
    const rows = await ctx.db.query("workItems").collect();
    for (const row of rows) {
      if (row.instance === fixture.instance && row.thread === thread && row.kind === kind) {
        await ctx.db.delete("workItems", row._id);
      }
    }
  });
}

function derivationSnapshot(rows: readonly DerivationReportEntry[]) {
  return rows.map((row) => [row.subjectId, row.derivationType, row.state, row.content]);
}

function assemblyTokens(prompt: string, answer: string) {
  return estimateTokens(`User:\n${prompt}\n\n⏺ ${answer}`);
}

const SMOOTHED = "canned smoothed_prompt text from the fake host";
const COMPRESSED = "canned detailed_turn_compression text from the fake host";
const BRIEF = "canned chunk_summary_brief text from the fake host";

describe("turn derivation and chunk formation", () => {
  test("a closed turn lands rendering, assembly, and compression as independent rows", async () => {
    const fixture = serviceFixture({ guards: { detailedTurnCompression: { tinyTurnTokens: 1 } } });
    const { filePath, threadId } = await fixture.createThread();
    await sendTurn(fixture.sdk, filePath, "compose this turn", "the composed answer");

    expect(await fixture.sdk.work.drain({ filePath })).toEqual({
      ok: true,
      value: { claimed: 3, completed: 3, failed: 0, blocked: 0, staleDiscarded: 0, remaining: 0 },
    });
    expect(await turnForm(fixture.sdk, filePath, "t1", "turn_rendering")).toMatchObject({
      subjectKind: "turn",
      state: "ready",
      content: expect.stringContaining(SMOOTHED),
      sourceVersion: 1,
    });
    expect(await turnForm(fixture.sdk, filePath, "t1", "pre_detailed_assembly")).toMatchObject({
      state: "ready",
      content: `User:\n${SMOOTHED}\n\n⏺ the composed answer`,
      sourceVersion: 1,
    });
    expect(await turnForm(fixture.sdk, filePath, "t1", "detailed_turn_compression")).toMatchObject({
      state: "ready",
      content: COMPRESSED,
      sourceVersion: 1,
    });
    expect(await liveWork(fixture, threadId)).toEqual([]);
  });

  test("failed smoothing falls back to raw text while the turn still lands ready", async () => {
    const fixture = serviceFixture({ models: { smoothed_prompt: "fail" } });
    const { filePath } = await fixture.createThread();
    await sendTurn(fixture.sdk, filePath, "raw prompt one", "answer text");

    expect(await fixture.sdk.work.drain({ filePath })).toEqual({
      ok: true,
      value: { claimed: 3, completed: 2, failed: 1, blocked: 0, staleDiscarded: 0, remaining: 0 },
    });
    expect(await turnForm(fixture.sdk, filePath, "t1", "turn_rendering")).toMatchObject({
      state: "ready",
      content: expect.stringContaining("raw prompt one"),
    });
    expect(await turnForm(fixture.sdk, filePath, "t1", "detailed_turn_compression")).toMatchObject({ state: "ready" });
    expect(await messageForm(fixture.sdk, filePath, "m1", "smoothed_prompt")).toMatchObject({ state: "ready" });
    const logs = await fixture.sdk.logging.queryDerivationLog(
      { filePath },
      { subjectId: "m1", derivationType: "smoothed_prompt" },
    );
    expect(logs.ok && logs.value.map((entry) => entry["eventKind"])).toContain("inference_failed");
  });

  test("turn construction does not invoke inference for a pending message derivation", async () => {
    const fixture = serviceFixture({ models: { smoothed_prompt: "throw:turn construction reran smoothing" } });
    const { filePath, threadId } = await fixture.createThread();
    await sendTurn(fixture.sdk, filePath, "pending prompt", "answer text");
    await deleteWork(fixture, threadId, "prompt_smoothing");

    expect(await fixture.sdk.work.drain({ filePath })).toEqual({
      ok: true,
      value: { claimed: 2, completed: 2, failed: 0, blocked: 0, staleDiscarded: 0, remaining: 0 },
    });
    expect(await turnForm(fixture.sdk, filePath, "t1", "turn_rendering")).toMatchObject({ state: "ready" });
    expect(await turnForm(fixture.sdk, filePath, "t1", "detailed_turn_compression")).toMatchObject({ state: "ready" });
  });

  test("dependency repair does not rebuild a turn until explicitly requested", async () => {
    const fixture = serviceFixture({ models: { smoothed_prompt: "script:network:turn-repair" } });
    const { filePath, threadId } = await fixture.createThread();
    await sendTurn(fixture.sdk, filePath, "gapped prompt", "gapped answer");
    await fixture.sdk.work.drain({ filePath });
    const before = await turnForm(fixture.sdk, filePath, "t1", "turn_rendering");
    const chunksBefore = await fixture.sdk.turns.listChunks({ filePath });

    expect(await fixture.sdk.messages.derive({ filePath }, ["m1"])).toEqual({
      ok: true,
      value: [{ messageId: "m1", outcome: "derived", sourceVersion: 2 }],
    });
    expect(await turnForm(fixture.sdk, filePath, "t1", "turn_rendering")).toEqual(before);
    expect(await liveWork(fixture, threadId)).toEqual([]);

    expect(await fixture.sdk.turns.deriveTurn({ filePath }, "t1")).toEqual({
      ok: true,
      value: { turnId: "t1", outcome: "derived", sourceVersion: 2 },
    });
    const rebuilt = await turnForm(fixture.sdk, filePath, "t1", "turn_rendering");
    const repaired = await messageForm(fixture.sdk, filePath, "m1", "smoothed_prompt");
    expect(repaired).toMatchObject({ state: "ready", content: expect.any(String) });
    if (repaired?.content === undefined) throw new Error("repaired smoothing has no content");
    expect(rebuilt).toMatchObject({
      state: "ready",
      sourceVersion: 2,
      content: expect.stringContaining(repaired.content),
    });
    expect(rebuilt?.content).not.toBe(before?.content);
    expect(await fixture.sdk.turns.listChunks({ filePath })).toEqual(chunksBefore);
  });

  test("tool runs preserve per-call outcomes in one grouped account", async () => {
    const fixture = serviceFixture();
    const { filePath } = await fixture.createThread();
    const call = (id: string, path: string) =>
      validEvent("tool_call", { payload: { toolCallId: id, toolName: "edit_file", arguments: { path } } });
    const result = (id: string, content: string, isError: boolean) =>
      validEvent("tool_result", { payload: { toolCallId: id, content, isError } });
    await send(fixture.sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "edit three files" } }),
      call("call-a", "a.txt"),
      result("call-a", "edited a.txt", false),
      call("call-b", "b.txt"),
      result("call-b", "permission denied", true),
      call("call-c", "c.txt"),
      result("call-c", "edited c.txt", false),
      validEvent("turn_end"),
    ]);
    await fixture.sdk.work.drain({ filePath });

    const text = (await turnForm(fixture.sdk, filePath, "t1", "turn_rendering"))?.content ?? "";
    expect(text).toContain("[tool run · edit_file · 3 calls · 2 succeeded, 1 failed]");
    expect(text).not.toMatch(/\b3 succeeded\b/);
    for (const item of [
      ['edit_file({"path":"a.txt"})', "succeeded"],
      ["edited a.txt", "succeeded"],
      ['edit_file({"path":"b.txt"})', "failed"],
      ["permission denied", "failed"],
      ['edit_file({"path":"c.txt"})', "succeeded"],
      ["edited c.txt", "succeeded"],
    ]) {
      expect(text).toContain(`${item[0]} ⇒ ${item[1]}`);
    }
  });

  test("turn reads expose placement in the completion transaction", async () => {
    const fixture = serviceFixture();
    const { filePath } = await fixture.createThread();
    await sendTurn(fixture.sdk, filePath, "place me", "placed");
    await fixture.sdk.work.drain({ filePath });

    const turns = await fixture.sdk.turns.listTurns({ filePath });
    expect(turns.ok && turns.value[0]).toEqual(
      expect.objectContaining({ turnId: "t1", status: "closed", chunkId: "c1", memberIdx: 0 }),
    );
  });

  test("the target crossing turn starts the next chunk", async () => {
    const per = assemblyTokens(SMOOTHED, "answer text");
    const fixture = serviceFixture({
      chunkPolicy: { targetProjectedTokens: 2 * per + 1, maxProjectedTokens: 100 * per },
    });
    const { filePath, threadId } = await fixture.createThread();
    for (let index = 0; index < 3; index += 1) await sendTurn(fixture.sdk, filePath, "prompt text", "answer text");
    await fixture.sdk.work.drain({ filePath });

    const chunks = await fixture.sdk.turns.listChunks({ filePath });
    expect(
      chunks.ok &&
        chunks.value.map(({ chunkId, status, accumulatedProjectedTokens, memberTurnIds }) => ({
          chunkId,
          status,
          accumulatedProjectedTokens,
          memberTurnIds,
        })),
    ).toEqual([
      { chunkId: "c1", status: "closed", accumulatedProjectedTokens: 2 * per, memberTurnIds: ["t1", "t2"] },
      { chunkId: "c2", status: "open", accumulatedProjectedTokens: per, memberTurnIds: ["t3"] },
    ]);
    expect(await chunkForm(fixture.sdk, filePath, "c1", "chunk_summary_detailed")).toMatchObject({ state: "ready" });
    expect(await chunkForm(fixture.sdk, filePath, "c1", "chunk_summary_brief")).toMatchObject({ state: "ready" });
    expect(await liveWork(fixture, threadId)).toEqual([]);
  });

  test("the target threshold is inclusive and excludes the crossing turn", async () => {
    const per = assemblyTokens(SMOOTHED, "answer text");
    const fixture = serviceFixture({
      chunkPolicy: { targetProjectedTokens: 2 * per, maxProjectedTokens: 100 * per },
    });
    const { filePath } = await fixture.createThread();
    await sendTurn(fixture.sdk, filePath, "prompt text", "answer text");
    await sendTurn(fixture.sdk, filePath, "prompt text", "answer text");
    await fixture.sdk.work.drain({ filePath });

    const chunks = await fixture.sdk.turns.listChunks({ filePath });
    expect(
      chunks.ok && chunks.value.map(({ chunkId, status, memberTurnIds }) => ({ chunkId, status, memberTurnIds })),
    ).toEqual([
      { chunkId: "c1", status: "closed", memberTurnIds: ["t1"] },
      { chunkId: "c2", status: "open", memberTurnIds: ["t2"] },
    ]);
  });

  test("one oversized turn forms a closed chunk with both summaries", async () => {
    const answer = "omega ".repeat(120).trim();
    const big = assemblyTokens(SMOOTHED, answer);
    const fixture = serviceFixture({ chunkPolicy: { targetProjectedTokens: big, maxProjectedTokens: big } });
    const { filePath } = await fixture.createThread();
    await sendTurn(fixture.sdk, filePath, "huge turn", answer);
    await fixture.sdk.work.drain({ filePath });

    const chunks = await fixture.sdk.turns.listChunks({ filePath });
    expect(
      chunks.ok &&
        chunks.value.map(({ chunkId, status, accumulatedProjectedTokens, memberTurnIds }) => ({
          chunkId,
          status,
          accumulatedProjectedTokens,
          memberTurnIds,
        })),
    ).toEqual([{ chunkId: "c1", status: "closed", accumulatedProjectedTokens: big, memberTurnIds: ["t1"] }]);
    expect(await chunkForm(fixture.sdk, filePath, "c1", "chunk_summary_detailed")).toMatchObject({ state: "ready" });
    expect(await chunkForm(fixture.sdk, filePath, "c1", "chunk_summary_brief")).toMatchObject({ state: "ready" });
  });

  test("an oversized turn behind an open chunk closes both chunks", async () => {
    const answer = "omega ".repeat(120).trim();
    const big = assemblyTokens(SMOOTHED, answer);
    const fixture = serviceFixture({ chunkPolicy: { targetProjectedTokens: big, maxProjectedTokens: big } });
    const { filePath } = await fixture.createThread();
    await sendTurn(fixture.sdk, filePath, "small turn", "small answer");
    await sendTurn(fixture.sdk, filePath, "huge turn", answer);
    await fixture.sdk.work.drain({ filePath });

    const chunks = await fixture.sdk.turns.listChunks({ filePath });
    expect(
      chunks.ok && chunks.value.map(({ chunkId, status, memberTurnIds }) => ({ chunkId, status, memberTurnIds })),
    ).toEqual([
      { chunkId: "c1", status: "closed", memberTurnIds: ["t1"] },
      { chunkId: "c2", status: "closed", memberTurnIds: ["t2"] },
    ]);
    for (const chunkId of ["c1", "c2"]) {
      expect(await chunkForm(fixture.sdk, filePath, chunkId, "chunk_summary_detailed")).toMatchObject({
        state: "ready",
      });
      expect(await chunkForm(fixture.sdk, filePath, chunkId, "chunk_summary_brief")).toMatchObject({ state: "ready" });
    }
  });

  test("chunk close lands detailed and brief summaries as distinct artifacts", async () => {
    const fixture = serviceFixture({
      guards: { detailedTurnCompression: { tinyTurnTokens: 1 } },
      chunkPolicy: { targetProjectedTokens: 1, maxProjectedTokens: 1 },
    });
    const { filePath } = await fixture.createThread();
    await sendTurn(fixture.sdk, filePath, "summarize me", "summarized");
    expect(await fixture.sdk.work.drain({ filePath })).toEqual({
      ok: true,
      value: { claimed: 5, completed: 5, failed: 0, blocked: 0, staleDiscarded: 0, remaining: 0 },
    });

    const detailed = await chunkForm(fixture.sdk, filePath, "c1", "chunk_summary_detailed");
    const brief = await chunkForm(fixture.sdk, filePath, "c1", "chunk_summary_brief");
    expect(detailed).toMatchObject({ state: "ready", content: COMPRESSED });
    expect(brief).toMatchObject({ state: "ready", content: BRIEF, metadata: { sizeDisposition: expect.any(String) } });
    expect(detailed?.content).not.toBe(brief?.content);
  });

  test("detailed chunks contain compressions only and brief inference consumes detailed text", async () => {
    const fixture = serviceFixture({
      guards: { detailedTurnCompression: { tinyTurnTokens: 1 } },
      chunkPolicy: { targetProjectedTokens: 1, maxProjectedTokens: 1 },
    });
    const { filePath } = await fixture.createThread();
    await send(fixture.sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "edit two files" } }),
      validEvent("tool_call", {
        payload: { toolCallId: "rcpt-a", toolName: "edit_file", arguments: { path: "ok.txt" } },
      }),
      validEvent("tool_result", { payload: { toolCallId: "rcpt-a", content: "edited ok.txt", isError: false } }),
      validEvent("tool_call", {
        payload: { toolCallId: "rcpt-b", toolName: "edit_file", arguments: { path: "ro.txt" } },
      }),
      validEvent("tool_result", { payload: { toolCallId: "rcpt-b", content: "read-only file", isError: true } }),
      validEvent("turn_end"),
    ]);
    await fixture.sdk.work.drain({ filePath });

    const rendering = await turnForm(fixture.sdk, filePath, "t1", "turn_rendering");
    expect(rendering?.content).toContain("tool run · edit_file · 2 calls · 1 succeeded, 1 failed");
    const detailed = await chunkForm(fixture.sdk, filePath, "c1", "chunk_summary_detailed");
    expect(detailed).toMatchObject({ state: "ready", content: COMPRESSED });
    expect(detailed?.content).not.toContain("receipts");
    expect(detailed?.content).not.toContain("edit_file");
    const logs = await fixture.sdk.logging.queryDerivationLog(
      { filePath },
      { subjectId: "c1", derivationType: "chunk_summary_brief", eventKind: "inference_succeeded" },
    );
    expect(logs.ok).toBe(true);
    if (!logs.ok) return;
    expect(JSON.stringify(logs.value[0]?.["payload"])).toContain(COMPRESSED);
  });

  test("brief failure leaves detailed ready and brief can be re-derived alone", async () => {
    const fixture = serviceFixture({
      guards: { detailedTurnCompression: { tinyTurnTokens: 1 } },
      chunkPolicy: { targetProjectedTokens: 1, maxProjectedTokens: 1 },
      models: { chunk_summary_brief: "script:network:brief-independent" },
    });
    const { filePath } = await fixture.createThread();
    await sendTurn(fixture.sdk, filePath, "independent failure", "answer");
    expect(await fixture.sdk.work.drain({ filePath })).toEqual({
      ok: true,
      value: { claimed: 5, completed: 4, failed: 1, blocked: 0, staleDiscarded: 0, remaining: 0 },
    });
    const detailedBefore = await chunkForm(fixture.sdk, filePath, "c1", "chunk_summary_detailed");
    expect(detailedBefore).toMatchObject({ state: "ready" });
    expect(await chunkForm(fixture.sdk, filePath, "c1", "chunk_summary_brief")).toMatchObject({
      state: "failed",
      reason: "provider_failure: network: scripted network failure",
    });

    expect(await fixture.sdk.turns.deriveBriefChunk({ filePath }, "c1")).toEqual({
      ok: true,
      value: { chunkId: "c1", outcome: "derived", derivationType: "chunk_summary_brief", sourceVersion: 2 },
    });
    expect(await chunkForm(fixture.sdk, filePath, "c1", "chunk_summary_brief")).toMatchObject({ state: "ready" });
    expect(await chunkForm(fixture.sdk, filePath, "c1", "chunk_summary_detailed")).toEqual(detailedBefore);
  });

  test("replaying the same stream produces identical chunk boundaries and summary artifacts", async () => {
    const fixture = serviceFixture({ chunkPolicy: { targetProjectedTokens: 60, maxProjectedTokens: 4_400 } });
    const turns: Array<[string, string]> = [
      ["first prompt about the parser", "parser answer with detail"],
      ["second prompt about the cache", "cache answer, longer, with extra words"],
      ["third prompt about the index rebuild", "index answer"],
      ["fourth prompt, short", "fourth answer, also short"],
      ["fifth prompt to push past one chunk", "fifth answer closing things out"],
    ];
    const build = async (filePath: string) => {
      await fixture.createThread(filePath);
      for (const [prompt, answer] of turns) await sendTurn(fixture.sdk, filePath, prompt, answer);
      await fixture.sdk.work.drain({ filePath });
      const chunks = await fixture.sdk.turns.listChunks({ filePath });
      if (!chunks.ok) throw new Error(chunks.error.reason);
      const reports: DerivationReportEntry[] = [];
      for (const chunk of chunks.value) {
        const report = await fixture.sdk.turns.report({ filePath }, { chunkId: chunk.chunkId });
        if (!report.ok) throw new Error(report.error.reason);
        reports.push(...report.value);
      }
      return {
        chunks: chunks.value.map(({ derivations: _, ...chunk }) => chunk),
        summaries: derivationSnapshot(reports),
      };
    };

    const first = await build("replay-one");
    const second = await build("replay-two");
    expect(first).toEqual(second);
    expect(first.chunks.length).toBeGreaterThan(1);
  });
});
