// Story 5: chunk_summary_brief from detailed material, ported to the component.
// The brief consumes the READY chunk_summary_detailed content: it sends that
// text plus concrete targets (min/aim/max = round(inputTokens*0.08/0.12/0.2),
// queue.ts:745-747) to the model and records metadata.sizeDisposition
// (queue.ts:770-793). The concrete targets are proven by rebuilding the exact
// chunk-brief-v3 render from the detailed text and matching it against the call
// the fake host received (the component renders the input into messages before
// the model call, so the raw callback-input object the frozen suite captures is
// observed through the rendered request instead).
//
// EXCLUDED / DIVERGENT (documented in the ledger). The frozen suite tests a
// cooperative work scheduler in which the brief runs independently of the
// detailed summary and DEFERS / REQUEUES / BLOCKS on the detailed dependency
// state. The component uses a strict serial FIFO drain: at chunk close the
// detailed work is enqueued (and claimed) strictly before the brief
// (queue.ts:801-815), so the brief always observes a ready detailed summary; its
// handler has NO deferral, NO self/detailed re-enqueue, and NO blocked branch —
// when the detailed row is pending/failed/blocked/missing the brief lands FAILED
// with `chunk_summary_detailed_not_ready` (queue.ts:737-738). These five frozen
// legs have no component analog:
//   - "defers behind live detailed work without writing detailed directly"
//   - "schedules detailed work before requeued brief when no detailed work is live"
//   - "uses the current brief source version when the detailed row is missing"
//     (the component does not re-enqueue detailed work)
//   - "keeps detailed pending when its member projection is pending" (the brief
//     stays-pending mechanic; the detailed FAILED member_projection_not_ready
//     leg is covered by chunk_detailed_format.test.ts)
//   - "blocks when detailed is blocked or failed" (the component FAILS the brief
//     with chunk_summary_detailed_not_ready rather than blocking it with
//     source_damaged)
import { describe, expect, test } from "vitest";
import { estimateTokens, type Lhc } from "../src/client/index.js";
import { PROMPT_REGISTRY, type PromptTemplate } from "../src/shared/prompts/index.js";
import { capturedCalls, resetCapturedCalls } from "./convex/model.js";
import { serviceFixture, type ServiceFixture, validEvent } from "./fixtures/index.js";

const BRIEF_MODEL = "model-chunk_summary_brief";

function renderByName(name: string, input: unknown): unknown {
  return (PROMPT_REGISTRY[name] as PromptTemplate<unknown> | undefined)?.render(input);
}

function targetInputFor(text: string) {
  const inputTokens = estimateTokens(text);
  return {
    text,
    inputTokens,
    targetMinTokens: Math.max(1, Math.round(inputTokens * 0.08)),
    targetAimTokens: Math.max(1, Math.round(inputTokens * 0.12)),
    targetMaxTokens: Math.max(1, Math.round(inputTokens * 0.2)),
  };
}

async function seedClosedChunk(sdk: Lhc, filePath: string): Promise<void> {
  const accepted = await sdk.intakeStream.messageEvents({ filePath }, [
    validEvent("user_prompt", { payload: { text: "brief source prompt" } }),
    validEvent("assistant_text", { payload: { text: "brief source answer" } }),
    validEvent("turn_end"),
  ]);
  if (!accepted.ok) throw new Error(accepted.error.reason);
  const drained = await sdk.work.drain({ filePath });
  if (!drained.ok) throw new Error(drained.error.reason);
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

async function setChunkSummary(
  fixture: ServiceFixture,
  thread: string,
  chunkId: string,
  derivationType: "chunk_summary_detailed" | "chunk_summary_brief",
  state: "pending" | "ready",
  opts: { content?: string } = {},
): Promise<void> {
  await fixture.test.run(async (ctx) => {
    const rows = await ctx.db.query("derivations").collect();
    const row = rows.find(
      (r) =>
        r.instance === fixture.instance &&
        r.thread === thread &&
        r.scope === "chunk" &&
        r.subject === chunkId &&
        r.deriv === derivationType,
    );
    if (row === undefined) throw new Error(`${chunkId}/${derivationType} missing`);
    await ctx.db.patch("derivations", row._id, {
      state,
      content: opts.content,
      reason: undefined,
      metadata: undefined,
      derivedAt: "2026-01-01T00:00:00.000Z",
    });
  });
}

describe("Story 5: chunk_summary_brief from detailed material", () => {
  test("sends detailed text and concrete targets to the model, then records sizeDisposition", async () => {
    resetCapturedCalls();
    const fixture = serviceFixture({
      guards: { detailedTurnCompression: { tinyTurnTokens: 1 } },
      chunkPolicy: { targetProjectedTokens: 1, maxProjectedTokens: 1 },
    });
    const { filePath, threadId } = await fixture.createThread();
    await seedClosedChunk(fixture.sdk, filePath);

    const detailedText = "seeded detailed text; not the member compression";
    const memberCompression = (await turnForm(fixture.sdk, filePath, "t1", "detailed_turn_compression"))?.content ?? "";
    expect(memberCompression).not.toBe(detailedText);

    await setChunkSummary(fixture, threadId, "c1", "chunk_summary_detailed", "ready", { content: detailedText });
    await setChunkSummary(fixture, threadId, "c1", "chunk_summary_brief", "pending");

    const derived = await fixture.sdk.turns.deriveBriefChunk({ filePath }, "c1");
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;
    expect(derived.value).toMatchObject({ chunkId: "c1", derivationType: "chunk_summary_brief", outcome: "derived" });

    // The concrete targets flow into the brief call: rebuild the exact rendered
    // request from the detailed text and match it against what the host got.
    const expectedInput = targetInputFor(detailedText);
    const briefCall = capturedCalls.filter((call) => call.model === BRIEF_MODEL).at(-1);
    expect(briefCall?.messages).toEqual(renderByName("chunk-brief-v3", expectedInput));
    // The member compression never reaches the brief input — only the detailed text.
    expect(JSON.stringify(briefCall?.messages)).not.toContain(memberCompression);

    expect(await chunkForm(fixture.sdk, filePath, "c1", "chunk_summary_brief")).toMatchObject({
      state: "ready",
      metadata: { sizeDisposition: expect.any(String) },
    });
  });
});
