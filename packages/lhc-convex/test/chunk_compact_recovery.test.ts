// Story 4: chunk derivation and compact recovery, ported to the component.
// Detailed and brief chunk summaries are independent derivations/states; a
// compact-time not-ready detailed summary degrades to a deterministic
// stored-member concatenation with zero model calls (compact is a Convex
// mutation and cannot call the model, view.ts:214-236). A background detailed
// summary whose member projection is pending lands FAILED with
// member_projection_not_ready.
//
// DIVERGENT / RESHAPED (documented in the ledger):
//  - Compact writes NO operator-log row (it only stores threadViews/bands), so
//    the frozen `{level:"warning", reason:"failed_floor", floorUsed:
//    "stored_member_concat"}` log has no analog; the failed_floor signal
//    surfaces only through the compact receipt `warnings` and the stored band
//    marker. The receipt warning shape is `{band, subjectId, reason}` — the
//    component does not carry a `derivationType` key (view.ts:684-686).
//  - The degraded detailed band is built from each member's
//    `compression ?? assembly ?? rendering` (view.ts:227), so it carries the
//    member's stored detailed_turn_compression content, not the raw dialogue the
//    frozen fallback (which prefers rendering) surfaces.
//  - Brief failure reasons are wrapped `provider_failure: <kind>: <message>`.
//
// EXCLUDED (documented open in the ledger):
//  - "refuses compact when canonical member source is corrupt": a deleted
//    chunk-member turn yields `{errorClass:"caller_error", code:
//    "invalid_view_config"}` (view.ts:185 → computeSelection catch), not
//    `state_corruption` — only >1 open turns raises turn_state_corrupt.
//  - "background chunk summaries block when a chunk member references a missing
//    turn": the chunk-summary readSource iterates chunkMembers and the members'
//    surviving turn-scope derivations; a deleted turn ROW is not re-checked, so
//    the summaries do not land blocked/source_damaged.
import { describe, expect, test } from "vitest";
import type { Lhc, MessageEventInput } from "../src/client/index.js";
import { capturedCalls, resetCapturedCalls } from "./convex/model.js";
import { type ServiceFixture, serviceFixture, validEvent } from "./fixtures/index.js";

const COMPACT_PARAMS = {
  lowerBound: 120,
  percentages: { full: 10, smooth: 10, detailed: 70, brief: 10 },
};

async function send(sdk: Lhc, filePath: string, batch: readonly MessageEventInput[]): Promise<void> {
  const result = await sdk.intakeStream.messageEvents({ filePath }, batch);
  if (!result.ok) throw new Error(result.error.reason);
}

async function drain(sdk: Lhc, filePath: string, opts?: { maxItems?: number }): Promise<void> {
  const result = await sdk.work.drain({ filePath }, opts);
  if (!result.ok) throw new Error(result.error.reason);
}

async function seedFourClosedTurns(sdk: Lhc, filePath: string): Promise<void> {
  for (let i = 1; i <= 4; i += 1) {
    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: `prompt ${i}` } }),
      validEvent("assistant_text", { payload: { text: `answer ${i}` } }),
      validEvent("turn_end"),
    ]);
  }
  await drain(sdk, filePath);
}

async function chunkForm(sdk: Lhc, filePath: string, chunkId: string, derivationType: string) {
  const report = await sdk.turns.report({ filePath }, { chunkId });
  if (!report.ok) throw new Error(report.error.reason);
  return report.value.find((form) => form.derivationType === derivationType);
}

async function setChunkDetailed(
  fixture: ServiceFixture,
  thread: string,
  chunkId: string,
  update: { state: "pending" | "failed"; reason?: string },
): Promise<void> {
  await patchDerivation(fixture, thread, "chunk", chunkId, "chunk_summary_detailed", update);
}

async function patchDerivation(
  fixture: ServiceFixture,
  thread: string,
  scope: "chunk" | "turn",
  subject: string,
  deriv: string,
  update: { state: "pending" | "failed"; reason?: string },
): Promise<void> {
  await fixture.test.run(async (ctx) => {
    const rows = await ctx.db.query("derivations").collect();
    const row = rows.find(
      (r) =>
        r.instance === fixture.instance &&
        r.thread === thread &&
        r.scope === scope &&
        r.subject === subject &&
        r.deriv === deriv,
    );
    if (row === undefined) throw new Error(`${subject}/${deriv} missing`);
    await ctx.db.patch("derivations", row._id, {
      state: update.state,
      content: undefined,
      reason: update.reason,
      metadata: undefined,
      derivedAt: "2026-01-01T00:00:00.000Z",
    });
  });
}

describe("Story 4: chunk derivation and compact recovery", () => {
  test("queues detailed and brief chunk summaries as independent work items and states", async () => {
    const fixture = serviceFixture({
      guards: { detailedTurnCompression: { tinyTurnTokens: 1 } },
      chunkPolicy: { targetProjectedTokens: 1, maxProjectedTokens: 999_999 },
      models: { chunk_summary_brief: "failure:timeout:scripted brief failure" },
    });
    const { filePath } = await fixture.createThread();
    await seedFourClosedTurns(fixture.sdk, filePath);

    expect((await chunkForm(fixture.sdk, filePath, "c1", "chunk_summary_detailed"))?.state).toBe("ready");
    expect(await chunkForm(fixture.sdk, filePath, "c1", "chunk_summary_brief")).toMatchObject({
      state: "failed",
      reason: "provider_failure: timeout: scripted brief failure",
    });
  });

  test("compacts a failed detailed chunk summary through stored-member concat with zero model calls", async () => {
    const fixture = serviceFixture({
      guards: { detailedTurnCompression: { tinyTurnTokens: 1 } },
      chunkPolicy: { targetProjectedTokens: 1, maxProjectedTokens: 999_999 },
    });
    const { filePath, threadId } = await fixture.createThread();
    await seedFourClosedTurns(fixture.sdk, filePath);
    const t1Report = await fixture.sdk.turns.report({ filePath }, { turnId: "t1" });
    if (!t1Report.ok) throw new Error(t1Report.error.reason);
    const memberCompression =
      t1Report.value.find((f) => f.derivationType === "detailed_turn_compression")?.content ?? "";
    await setChunkDetailed(fixture, threadId, "c1", { state: "failed", reason: "timeout: old summary failed" });

    resetCapturedCalls();
    const compacted = await fixture.sdk.threadView.compact({ filePath }, { params: COMPACT_PARAMS });
    expect(compacted.ok).toBe(true);
    if (!compacted.ok) return;
    expect(capturedCalls).toEqual([]);
    expect(compacted.value.warnings).toContainEqual({ band: "detailed", subjectId: "c1", reason: "failed_floor" });

    const contextRead = await fixture.sdk.threadView.getLlmRequestContext({ filePath });
    expect(contextRead.ok).toBe(true);
    if (!contextRead.ok) return;
    const detailed = contextRead.value.messages.find((message) =>
      message.content.some((part) => part.text.startsWith("[context · detailed]")),
    );
    const detailedText = detailed?.content.map((part) => part.text).join("");
    expect(detailedText).toContain("[degraded: detailed-from-stored-members]");
    expect(detailedText).toContain(memberCompression);
    expect(detailedText).not.toContain("unavailable");
    // Compact ran no model calls: the degraded band is a pure stored-member concat.
    expect(capturedCalls).toEqual([]);
  });

  test("halts compact before fallback assembly when stop is requested", async () => {
    const fixture = serviceFixture({
      guards: { detailedTurnCompression: { tinyTurnTokens: 1 } },
      chunkPolicy: { targetProjectedTokens: 1, maxProjectedTokens: 999_999 },
    });
    const { filePath, threadId } = await fixture.createThread();
    await seedFourClosedTurns(fixture.sdk, filePath);
    await setChunkDetailed(fixture, threadId, "c1", { state: "pending" });

    const stopped = await fixture.sdk.threadView.compact(
      { filePath },
      { signal: { aborted: true }, params: COMPACT_PARAMS },
    );
    expect(stopped.ok).toBe(false);
    if (stopped.ok) return;
    expect(stopped.error).toMatchObject({ errorClass: "caller_error", code: "compact_stopped" });
    expect((await chunkForm(fixture.sdk, filePath, "c1", "chunk_summary_detailed"))?.state).toBe("pending");
  });

  test("background chunk summary work fails on a not-ready member projection", async () => {
    const fixture = serviceFixture({
      guards: { detailedTurnCompression: { tinyTurnTokens: 1 } },
      chunkPolicy: { targetProjectedTokens: 1, maxProjectedTokens: 999_999 },
    });
    const { filePath, threadId } = await fixture.createThread();
    await seedFourClosedTurns(fixture.sdk, filePath);
    await setChunkDetailed(fixture, threadId, "c1", { state: "pending" });
    await patchDerivation(fixture, threadId, "turn", "t1", "detailed_turn_compression", { state: "pending" });

    const derived = await fixture.sdk.turns.deriveDetailedChunk({ filePath }, "c1");
    expect(derived.ok).toBe(true);

    expect(await chunkForm(fixture.sdk, filePath, "c1", "chunk_summary_detailed")).toMatchObject({
      state: "failed",
      reason: expect.stringContaining("member_projection_not_ready"),
    });
  });
});
