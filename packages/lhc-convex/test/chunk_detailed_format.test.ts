// Story 4: chunk_summary_detailed concatenation format, ported to the component.
// The detailed chunk summary is a deterministic concatenation of member turns'
// detailed_turn_compression content joined by "\n\n" (queue.ts:730) — no chunk
// model call. A member whose compression is failed contributes its
// pre_detailed_assembly content as a floor and the summary still lands ready
// (queue.ts:721-723); a member whose compression is pending/blocked lands the
// summary failed with member_projection_not_ready (queue.ts:724).
//
// Projected tokens per turn are the pre_detailed_assembly token count
// (queue.ts:595 `projectedTokens: estimateTokens(assembly.text)`), so chunk
// boundaries are forced through the smoothed-prompt-based assembly size, exactly
// as derivation_turns.test.ts does.
//
// EXCLUDED / DIVERGENT (documented in the ledger):
//  - The frozen "logs the fallback" (failed_floor warning at derivation time)
//    and its "no log when stale-discarded" pair: the component substitutes a
//    failed member's assembly floor SILENTLY — the failed_floor log/floorUsed
//    surface exists only in the compact path, not at chunk-summary derivation
//    (queue.ts:713-733 emits no log). Only the floor CONTENT behavior ports.
//  - The blocked-member leg of "requeues pending members and blocks blocked
//    members": a blocked member compression yields member_projection_not_ready
//    FAILED, not a blocked/source_damaged summary (queue.ts:724 has no blocked
//    branch). Only the pending-member (FAILED) leg ports.
//  - report.ran dispositions and w-* work-item ids are substrate (aggregate
//    DrainReport, opaque `w${seq}` ids); re-derivation runs through the public
//    deriveDetailedChunk/deriveBriefChunk actions (same handler as the drain).
import { describe, expect, test } from "vitest";
import { estimateTokens, type Lhc, type MessageEventInput } from "../src/client/index.js";
import { type ServiceFixture, serviceFixture, validEvent } from "./fixtures/index.js";

const SMOOTHED = "canned smoothed_prompt text from the fake host";
const FIXED = "fixed projected turn text";

function assemblyTokens(answer: string): number {
  return estimateTokens(`User:\n${SMOOTHED}\n\n⏺ ${answer}`);
}

async function send(sdk: Lhc, filePath: string, batch: readonly MessageEventInput[]): Promise<void> {
  const result = await sdk.intakeStream.messageEvents({ filePath }, batch);
  if (!result.ok) throw new Error(result.error.reason);
}

async function sendPromptTurn(sdk: Lhc, filePath: string, prompt: string, answer: string): Promise<void> {
  await send(sdk, filePath, [
    validEvent("user_prompt", { payload: { text: prompt } }),
    validEvent("assistant_text", { payload: { text: answer } }),
    validEvent("turn_end"),
  ]);
}

async function drain(sdk: Lhc, filePath: string, opts?: { maxItems?: number }): Promise<void> {
  const result = await sdk.work.drain({ filePath }, opts);
  if (!result.ok) throw new Error(result.error.reason);
}

async function turnForm(sdk: Lhc, filePath: string, turnId: string, derivationType: string) {
  const report = await sdk.turns.report({ filePath }, { turnId });
  if (!report.ok) throw new Error(report.error.reason);
  return report.value.find((form) => form.derivationType === derivationType);
}

async function chunkForm(sdk: Lhc, filePath: string, chunkId: string, derivationType: string) {
  const report = await sdk.turns.report({ filePath }, { chunkId });
  if (!report.ok) throw new Error(report.error.reason);
  return report.value.find((form) => form.derivationType === derivationType);
}

async function setCompression(
  fixture: ServiceFixture,
  thread: string,
  turnId: string,
  update: { state: "pending" | "failed"; reason?: string },
): Promise<void> {
  await fixture.test.run(async (ctx) => {
    const rows = await ctx.db.query("derivations").collect();
    const row = rows.find(
      (r) =>
        r.instance === fixture.instance &&
        r.thread === thread &&
        r.scope === "turn" &&
        r.subject === turnId &&
        r.deriv === "detailed_turn_compression",
    );
    if (row === undefined) throw new Error(`compression for ${turnId} missing`);
    await ctx.db.patch("derivations", row._id, {
      state: update.state,
      content: undefined,
      reason: update.reason,
      metadata: undefined,
      derivedAt: "2026-01-01T00:00:00.000Z",
    });
  });
}

describe("Story 4: chunk_summary_detailed concatenation format", () => {
  test("derives blank-line-separated member text in order without a detailed model call", async () => {
    const per = assemblyTokens("answer text");
    const fixture = serviceFixture({
      models: { detailed_turn_compression: `success:${FIXED}` },
      guards: { detailedTurnCompression: { tinyTurnTokens: 1 } },
      chunkPolicy: { targetProjectedTokens: 4 * per, maxProjectedTokens: 999_999 },
    });
    const { filePath } = await fixture.createThread();

    for (let i = 0; i < 4; i += 1) await sendPromptTurn(fixture.sdk, filePath, "prompt text", "answer text");
    await drain(fixture.sdk, filePath);

    // Four turns with target 4*per close c1 with the first three members.
    const detailedText = (await chunkForm(fixture.sdk, filePath, "c1", "chunk_summary_detailed"))?.content;
    expect(detailedText).toBe(`${FIXED}\n\n${FIXED}\n\n${FIXED}`);
    expect(detailedText).not.toContain(" | ");
  });

  test("detailed assembly is compression text only — no receipt block, no tool argument leak", async () => {
    const perTool = estimateTokens(`User:\n${SMOOTHED}`);
    const perPrompt = assemblyTokens("plain answer");
    const fixture = serviceFixture({
      models: { detailed_turn_compression: `success:${FIXED}` },
      guards: { detailedTurnCompression: { tinyTurnTokens: 1 } },
      chunkPolicy: { targetProjectedTokens: perTool + perPrompt + 1, maxProjectedTokens: 999_999 },
    });
    const { filePath } = await fixture.createThread();

    // t1 is a tool turn (dialog-only assembly); t2/t3 prompt turns. Target closes
    // c1 with [t1, t2]; t3 opens c2.
    await send(fixture.sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "read the project plan" } }),
      validEvent("tool_call", {
        payload: { toolCallId: "tool-a", toolName: "read_file", arguments: { path: "docs/plan.md" } },
      }),
      validEvent("tool_result", { payload: { toolCallId: "tool-a", content: "plan contents", isError: false } }),
      validEvent("turn_end"),
    ]);
    await sendPromptTurn(fixture.sdk, filePath, "plain prompt", "plain answer");
    await sendPromptTurn(fixture.sdk, filePath, "closing prompt", "closing answer");
    await drain(fixture.sdk, filePath);

    const detailed = await chunkForm(fixture.sdk, filePath, "c1", "chunk_summary_detailed");
    expect(detailed?.content).toBe(`${FIXED}\n\n${FIXED}`);
    expect(detailed?.content).not.toContain("[receipts");
    expect(detailed?.content).not.toContain('({"');
    expect(detailed?.content).not.toContain("docs/plan.md");
    const rendering = await turnForm(fixture.sdk, filePath, "t1", "turn_rendering");
    expect(rendering?.content).toContain("tool run · read_file · 1 call · 1 succeeded");
    expect(rendering?.metadata).toBeUndefined();
  });

  test("uses ready pre_detailed_assembly as the floor for a failed detailed member", async () => {
    // The failed_floor derivation-time log has no analog on the component (the
    // floor is substituted silently); only the floor CONTENT behavior ports.
    const fixture = serviceFixture({
      guards: { detailedTurnCompression: { tinyTurnTokens: 1 } },
      chunkPolicy: { targetProjectedTokens: 1, maxProjectedTokens: 1 },
    });
    const { filePath, threadId } = await fixture.createThread();
    await sendPromptTurn(fixture.sdk, filePath, "floor prompt", "floor answer");
    await drain(fixture.sdk, filePath);
    const assembly = (await turnForm(fixture.sdk, filePath, "t1", "pre_detailed_assembly"))?.content;
    expect(assembly).toBeDefined();

    await setCompression(fixture, threadId, "t1", { state: "failed", reason: "scripted compression failure" });
    const derived = await fixture.sdk.turns.deriveDetailedChunk({ filePath }, "c1");
    expect(derived.ok).toBe(true);

    expect(await chunkForm(fixture.sdk, filePath, "c1", "chunk_summary_detailed")).toMatchObject({
      state: "ready",
      content: assembly,
    });
  });

  test("fails the detailed summary when a member projection is pending", async () => {
    const fixture = serviceFixture({
      guards: { detailedTurnCompression: { tinyTurnTokens: 1 } },
      chunkPolicy: { targetProjectedTokens: 1, maxProjectedTokens: 1 },
    });
    const { filePath, threadId } = await fixture.createThread();
    await sendPromptTurn(fixture.sdk, filePath, "pending prompt", "pending answer");
    await drain(fixture.sdk, filePath);

    await setCompression(fixture, threadId, "t1", { state: "pending" });
    const derived = await fixture.sdk.turns.deriveDetailedChunk({ filePath }, "c1");
    expect(derived.ok).toBe(true);

    expect(await chunkForm(fixture.sdk, filePath, "c1", "chunk_summary_detailed")).toMatchObject({
      state: "failed",
      reason: expect.stringContaining("member_projection_not_ready"),
    });
  });

  test("brief consumes the detailed summary when detailed uses a failed-member floor", async () => {
    const fixture = serviceFixture({
      guards: { detailedTurnCompression: { tinyTurnTokens: 1 } },
      chunkPolicy: { targetProjectedTokens: 1, maxProjectedTokens: 1 },
    });
    const { filePath, threadId } = await fixture.createThread();
    await sendPromptTurn(fixture.sdk, filePath, "brief floor prompt", "brief floor answer");
    await drain(fixture.sdk, filePath);

    await setCompression(fixture, threadId, "t1", { state: "failed", reason: "scripted compression failure" });
    expect((await fixture.sdk.turns.deriveDetailedChunk({ filePath }, "c1")).ok).toBe(true);
    expect((await fixture.sdk.turns.deriveBriefChunk({ filePath }, "c1")).ok).toBe(true);

    expect((await chunkForm(fixture.sdk, filePath, "c1", "chunk_summary_detailed"))?.state).toBe("ready");
    const brief = await chunkForm(fixture.sdk, filePath, "c1", "chunk_summary_brief");
    expect(brief?.state).toBe("ready");
    expect(brief?.metadata?.sizeDisposition).toBeDefined();
  });

  test("produces byte-identical detailed output for identical input", async () => {
    const per = assemblyTokens("same answer");
    async function build(alias: string): Promise<string> {
      const fixture = serviceFixture({
        models: { detailed_turn_compression: `success:${FIXED}` },
        guards: { detailedTurnCompression: { tinyTurnTokens: 1 } },
        chunkPolicy: { targetProjectedTokens: 2 * per + 1, maxProjectedTokens: 999_999 },
      });
      const { filePath } = await fixture.createThread(alias);
      for (let i = 0; i < 3; i += 1) await sendPromptTurn(fixture.sdk, filePath, "same prompt", "same answer");
      await drain(fixture.sdk, filePath);
      return (await chunkForm(fixture.sdk, filePath, "c1", "chunk_summary_detailed"))?.content ?? "";
    }

    expect(await build("replay-one")).toBe(await build("replay-two"));
  });
});
