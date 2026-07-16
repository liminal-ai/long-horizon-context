// Model context and status on the record (TC-1.1, TC-1.2, TC-1.4, TC-2.5
// pre-compact legs, the per-kind tail-mapping legs, and the model-context/status
// legs of the suite-wide zero-model assertion). Every TC goes through the real
// SDK surface (threadView.getLlmRequestContext / status) against real temp
// threads; the fake model host (capturedCalls) appears only in construction —
// no Epic 03 read may touch it.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api } from "../convex/_generated/api.js";
import { initLhc, type Lhc, type LlmRequestContext, type SdkConfig } from "../src/client/index.js";

type LlmRequestContextMessage = LlmRequestContext["messages"][number];

import { capturedCalls, resetCapturedCalls } from "./convex/model.js";
import {
  type DerivedThreadFixture,
  derivedThreadFixture,
  dummyModelCall,
  executor,
  type ServiceFixture,
  serviceFixture,
  validEvent,
} from "./fixtures/index.js";

const TRANSIENT_REASON = "rate_limit: scripted failure (fixture)";
const PERMANENT_REASON = "content_refusal: scripted permanent failure (fixture)";

let fixture: DerivedThreadFixture;

beforeAll(async () => {
  fixture = await derivedThreadFixture();
});

function manualFixture(view?: SdkConfig["view"]): ServiceFixture {
  return serviceFixture(view === undefined ? {} : { view });
}

async function newThread(f: ServiceFixture): Promise<{ filePath: string; threadId: string }> {
  return await f.createThread();
}

async function intake(
  sdk: Lhc,
  filePath: string,
  batch: Parameters<Lhc["intakeStream"]["messageEvents"]>[1],
): Promise<void> {
  const result = await sdk.intakeStream.messageEvents({ filePath }, batch);
  if (!result.ok) throw new Error(`intake failed: ${result.error.reason}`);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function textPart(text: string): [{ type: "text"; text: string }] {
  return [{ type: "text", text }];
}

function messageText(message: LlmRequestContextMessage | undefined): string | undefined {
  return message?.content.map((part) => part.text).join("");
}

async function workItemCount(f: ServiceFixture): Promise<number> {
  return await f.test.run(async (ctx) => {
    const rows = await ctx.db.query("workItems").collect();
    return rows.filter((row) => row.instance === f.instance).length;
  });
}

// Below-SDK read-only snapshot of everything a read could illegally mutate:
// queue rows, derivation states, view rows, boundary position.
async function stateSnapshot(f: ServiceFixture): Promise<Record<string, unknown>> {
  return await f.test.run(async (ctx) => {
    const work = (await ctx.db.query("workItems").collect())
      .filter((row) => row.instance === f.instance)
      .map((row) => ({ id: row.workItem, status: row.status }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const derivations = (await ctx.db.query("derivations").collect())
      .filter((row) => row.instance === f.instance)
      .map((row) => ({ subject: row.subject, deriv: row.deriv, state: row.state }))
      .sort((a, b) => (a.subject + a.deriv).localeCompare(b.subject + b.deriv));
    const viewRows = (await ctx.db.query("threadViews").collect()).filter((row) => row.instance === f.instance).length;
    const boundaryRow = (await ctx.db.query("viewBoundaries").collect()).find((row) => row.instance === f.instance);
    return { work, derivations, viewRows, boundary: boundaryRow?.position ?? 0 };
  });
}

async function seedViewBoundary(f: ServiceFixture, position: number): Promise<void> {
  await f.test.run(async (ctx) => {
    const rows = await ctx.db.query("viewBoundaries").collect();
    const row = rows.find((candidate) => candidate.instance === f.instance);
    if (row === undefined) throw new Error("view boundary missing");
    await ctx.db.patch("viewBoundaries", row._id, { position });
  });
}

// A second SDK bound to the SAME component instance and harness — the port's
// analog of a fresh SDK reopening the same file. Reads use the instance's
// STORED config, so this consumer's mode/view only govern its own writes.
function sameInstanceSdk(f: ServiceFixture, mode: "manual" | "background", view?: SdkConfig["view"]): Lhc {
  return initLhc(api, executor(f.test), {
    componentInstanceId: f.instance,
    mode,
    inference: {
      call: dummyModelCall,
      assignments: {
        smoothed_prompt: { provider: "test", model: "model-smoothed_prompt", prompt: "smoothing-v1" },
        tool_result_summary: { provider: "test", model: "model-tool_result_summary", prompt: "tool-result-v2" },
        detailed_turn_compression: {
          provider: "test",
          model: "model-detailed_turn_compression",
          prompt: "detailed-turn-compression-v3",
        },
        chunk_summary_brief: { provider: "test", model: "model-chunk_summary_brief", prompt: "chunk-brief-v3" },
      },
    },
    ...(view === undefined ? {} : { view }),
  });
}

describe("TC-1.1 (AC-1.2, AC-1.3): never-compacted thread returns full model context in order; later intake appends", () => {
  it("carries threadId and both intake rounds in record order", async () => {
    const f = manualFixture();
    const { filePath, threadId } = await newThread(f);
    await intake(f.sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "first question" } }),
      validEvent("assistant_text", { payload: { text: "first answer" } }),
      validEvent("turn_end"),
    ]);

    const first = await f.sdk.threadView.getLlmRequestContext({ filePath });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.threadId).toBe(threadId);
    expect(first.value.messages).toEqual([
      { role: "user", content: textPart("first question") },
      { role: "assistant", content: textPart("first answer") },
    ]);

    await intake(f.sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "second question" } }),
      validEvent("assistant_text", { payload: { text: "second answer" } }),
      validEvent("turn_end"),
    ]);
    const second = await f.sdk.threadView.getLlmRequestContext({ filePath });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.messages).toEqual([
      { role: "user", content: textPart("first question") },
      { role: "assistant", content: textPart("first answer") },
      { role: "user", content: textPart("second question") },
      { role: "assistant", content: textPart("second answer") },
    ]);
  });
});

describe("TC-1.2 (AC-1.1, AC-1.7): two model-context reads with nothing between are byte-identical and create no work or model calls", () => {
  it("hashes identical, zero work rows created, the fake host observes zero calls", async () => {
    resetCapturedCalls();
    const before = await stateSnapshot(fixture);
    const workRowsBefore = await workItemCount(fixture);

    const one = await fixture.sdk.threadView.getLlmRequestContext({ filePath: fixture.filePath });
    const two = await fixture.sdk.threadView.getLlmRequestContext({ filePath: fixture.filePath });
    expect(one.ok && two.ok).toBe(true);
    if (!one.ok || !two.ok) return;

    expect(sha256(one.value)).toBe(sha256(two.value));
    expect(JSON.stringify(one.value)).toBe(JSON.stringify(two.value));

    expect(await workItemCount(fixture)).toBe(workRowsBefore);
    expect(await stateSnapshot(fixture)).toEqual(before);
    expect(capturedCalls.length).toBe(0);
  });
});

describe("tail mapping legs (architecture-risk): one named leg per message kind", () => {
  let f: ServiceFixture;
  let filePath: string;
  let contextMessages: LlmRequestContextMessage[];

  beforeAll(async () => {
    f = manualFixture();
    filePath = (await newThread(f)).filePath;
    await intake(f.sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "mapping prompt" } }),
      validEvent("assistant_thinking", { payload: { text: "mapping thought" } }),
      validEvent("tool_call", {
        payload: { toolCallId: "call-map-1", toolName: "read_file", arguments: { path: "map.txt" } },
      }),
      validEvent("tool_result", {
        payload: { toolCallId: "call-map-1", content: "mapping output", isError: false },
      }),
      validEvent("runtime_note", { payload: { text: "mapping note" } }),
      validEvent("assistant_text", { payload: { text: "mapping answer" } }),
      validEvent("turn_end"),
    ]);
    const result = await f.sdk.threadView.getLlmRequestContext({ filePath });
    if (!result.ok) throw new Error(`model context failed: ${result.error.reason}`);
    contextMessages = result.value.messages;
  });

  it("user_prompt: user role, text verbatim", () => {
    expect(contextMessages[0]).toEqual({ role: "user", content: textPart("mapping prompt") });
  });

  it("assistant_thinking: assistant role, fenced [thinking] block", () => {
    expect(contextMessages[1]).toEqual({
      role: "assistant",
      content: textPart("[thinking]\nmapping thought\n[/thinking]"),
    });
  });

  it("tool_call: assistant role, name marker plus deterministic arg rendering", () => {
    expect(contextMessages[2]).toEqual({
      role: "assistant",
      content: textPart('[tool call · read_file] {"path":"map.txt"}'),
    });
  });

  it("tool_result ahead of the boundary: user role, name marker plus full content", () => {
    expect(contextMessages[3]).toEqual({
      role: "user",
      content: textPart("[tool result · read_file]\nmapping output"),
    });
  });

  it("runtime_note: user role, [runtime note] marker plus text", () => {
    expect(contextMessages[4]).toEqual({ role: "user", content: textPart("[runtime note] mapping note") });
  });

  it("assistant_text: assistant role, text verbatim", () => {
    expect(contextMessages[5]).toEqual({ role: "assistant", content: textPart("mapping answer") });
  });

  it("tool_result at-or-behind the boundary: abridged marker plus short form (boundary seeded below-SDK)", async () => {
    const listed = await f.sdk.messages.list({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const result = listed.value.find((m) => m.kind === "tool_result");
    expect(result).toBeDefined();
    if (result === undefined) return;
    await seedViewBoundary(f, result.sourceEventOrder);

    const refreshedContext = await f.sdk.threadView.getLlmRequestContext({ filePath });
    expect(refreshedContext.ok).toBe(true);
    if (!refreshedContext.ok) return;
    const short = refreshedContext.value.messages[3];
    // Summaries are pending on this undrained thread, but rendering now uses
    // deterministic truncation for at-or-behind-boundary tool results.
    expect(short).toEqual({
      role: "user",
      content: textPart("[tool result · read_file · abridged]\nmapping output"),
    });
  });
});

describe("TC-1.4 (AC-1.5): boundary mid-tail — short behind, full ahead, non-tool content full everywhere", () => {
  // Skipped upstream in packages/lhc (frozen): the "render deterministic floors
  // even when a ready summary exists" behavior is not finalized. Kept skipped
  // and adapted to the Convex surface for parity.
  it.skip("renders deterministic tool-result floors behind the boundary and full content ahead of it", async () => {
    const f = serviceFixture({
      mode: "manual",
      toolResult: { smallTierTokens: 1, smallTargetRatio: 0.15, midTargetRatio: 0.04 },
    });
    const filePath = (await newThread(f)).filePath;
    for (const turn of [1, 2]) {
      await intake(f.sdk, filePath, [
        validEvent("user_prompt", { payload: { text: `boundary prompt ${turn}` } }),
        validEvent("assistant_thinking", { payload: { text: `boundary thought ${turn}` } }),
        validEvent("tool_call", {
          payload: { toolCallId: `call-bd-${turn}`, toolName: "read_file", arguments: { path: `bd-${turn}.txt` } },
        }),
        validEvent("tool_result", {
          payload: { toolCallId: `call-bd-${turn}`, content: `boundary output ${turn}`, isError: false },
        }),
        validEvent("assistant_text", { payload: { text: `boundary answer ${turn}` } }),
        validEvent("turn_end"),
      ]);
    }
    const drained = await f.sdk.work.drain({ filePath });
    expect(drained.ok).toBe(true);

    const listed = await f.sdk.messages.list({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const results = listed.value.filter((m) => m.kind === "tool_result");
    expect(results).toHaveLength(2);
    const [behind, ahead] = results;
    if (behind === undefined || ahead === undefined) return;
    const behindSummary = behind.derivations?.find(
      (derivation) => derivation.derivationType === "tool_result_summary" && derivation.state === "ready",
    );

    await seedViewBoundary(f, behind.sourceEventOrder);

    const context = await f.sdk.threadView.getLlmRequestContext({ filePath });
    expect(context.ok).toBe(true);
    if (!context.ok) return;
    const contents = context.value.messages.map((m) => messageText(m));

    expect(contents).toContain("[tool result · read_file · abridged]\nboundary output 1");
    expect(contents).not.toContain(`[tool result · read_file · abridged]\n${behindSummary?.content}`);
    expect(contents).toContain("[tool result · read_file]\nboundary output 2");
    for (const turn of [1, 2]) {
      expect(contents).toContain(`boundary prompt ${turn}`);
      expect(contents).toContain(`[thinking]\nboundary thought ${turn}\n[/thinking]`);
      expect(contents).toContain(`boundary answer ${turn}`);
    }
  });

  it("falls to deterministic truncation when no summary is ready and the content is oversized", async () => {
    const f = manualFixture();
    const filePath = (await newThread(f)).filePath;
    const longContent = "x".repeat(560);
    await intake(f.sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "truncation prompt" } }),
      validEvent("tool_call", {
        payload: { toolCallId: "call-tr-1", toolName: "read_file", arguments: { path: "tr.txt" } },
      }),
      validEvent("tool_result", {
        payload: { toolCallId: "call-tr-1", content: longContent, isError: false },
      }),
      validEvent("turn_end"),
    ]);
    // No drain: the summary stays pending, so the ladder's truncation rung
    // renders — fixed 500-char prefix plus the exact dropped-count marker.
    const listed = await f.sdk.messages.list({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const result = listed.value.find((m) => m.kind === "tool_result");
    if (result === undefined) return;
    await seedViewBoundary(f, result.sourceEventOrder);

    const context = await f.sdk.threadView.getLlmRequestContext({ filePath });
    expect(context.ok).toBe(true);
    if (!context.ok) return;
    const short = context.value.messages.find((m) => messageText(m)?.startsWith("[tool result"));
    expect(messageText(short)).toBe(`[tool result · read_file · abridged]\n${"x".repeat(500)}… [truncated 60 chars]`);
  });
});

describe("TC-2.5 pre-compact legs (AC-2.8): the status read on a heavy thread", () => {
  let heavy: DerivedThreadFixture;

  beforeAll(async () => {
    // A low threshold makes the fixture "heavy" relative to config. In the
    // port, threshold is per-instance stored config, so it is baked into the
    // fixture rather than overlaid by a second read-time SDK.
    heavy = await derivedThreadFixture({ view: { compactThreshold: 100 } });
    // The two manufactured failed states (transient + permanent
    // tool_result_summary), matching the committed corpus.
    await heavy.test.run(async (ctx) => {
      const summaries = (await ctx.db.query("derivations").collect())
        .filter(
          (row) =>
            row.instance === heavy.instance &&
            row.thread === heavy.threadId &&
            row.scope === "message" &&
            row.deriv === "tool_result_summary",
        )
        .sort((a, b) => a.subject.localeCompare(b.subject));
      const transient = summaries[2];
      const permanent = summaries[4];
      if (transient === undefined || permanent === undefined) throw new Error("fixture tool summaries missing");
      await ctx.db.patch("derivations", transient._id, {
        state: "failed",
        content: undefined,
        reason: TRANSIENT_REASON,
        metadata: undefined,
        derivedAt: "2026-01-01T00:00:00.000Z",
      });
      await ctx.db.patch("derivations", permanent._id, {
        state: "failed",
        content: undefined,
        reason: PERMANENT_REASON,
        metadata: undefined,
        derivedAt: "2026-01-01T00:00:00.000Z",
      });
    });
  });

  it("reports tail tokens vs threshold, recommendation, derivation counts, null view health, and the zone sum — reads only", async () => {
    resetCapturedCalls();
    const before = await stateSnapshot(heavy);

    const status = await heavy.sdk.threadView.status({ filePath: heavy.filePath });
    expect(status.ok).toBe(true);
    if (!status.ok) return;

    expect(status.value.threshold).toBe(100);
    expect(status.value.tailTokens).toBeGreaterThan(100);
    expect(status.value.compactRecommended).toBe(true);

    // Derivation counts by state: the two scripted failures, all others ready.
    expect(status.value.derivation).toEqual({ pending: 0, failed: 2, blocked: 0 });

    // Pre-compact: view health is null, not a zeroed shape.
    expect(status.value.view).toBeNull();

    // The visibility zone: boundary at its seeded default 0, so the sum is
    // every live tool result's estimate — cross-checked against the record.
    const listed = await heavy.sdk.messages.list({ filePath: heavy.filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const expectedZone = listed.value
      .filter((m) => m.kind === "tool_result")
      .reduce((sum, m) => sum + m.tokenEstimate, 0);
    expect(status.value.visibility).toEqual({ boundaryPosition: 0, zoneTokens: expectedZone, maxTokens: 64000 });

    // Reads only: no state change, zero model calls.
    expect(await stateSnapshot(heavy)).toEqual(before);
    expect(capturedCalls.length).toBe(0);
  });

  it("counts blocked derivations through the owner's report (sacrificial sibling)", async () => {
    const sibling = serviceFixture();
    const { filePath, threadId } = await sibling.createThread();
    const accepted = await sibling.sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: "blocked turn" } }),
      validEvent("assistant_text", { payload: { text: "answer" } }),
      validEvent("turn_end"),
    ]);
    expect(accepted.ok).toBe(true);
    await sibling.test.run(async (ctx) => {
      const turns = await ctx.db.query("turns").collect();
      const turn = turns.find(
        (row) => row.instance === sibling.instance && row.thread === threadId && row.turn === "t1",
      );
      if (turn === undefined) throw new Error("turn missing");
      await ctx.db.patch("turns", turn._id, { deletedAt: "2026-01-01T00:00:00.000Z" });
    });
    const drained = await sibling.sdk.work.drain({ filePath });
    expect(drained.ok).toBe(true);

    const status = await sibling.sdk.threadView.status({ filePath });
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    // The sibling's damaged turn landed both turn derivations blocked through
    // the production terminal path (turn_rendering + pre_detailed_assembly).
    expect(status.value.derivation.blocked).toBe(2);
    expect(status.value.view).toBeNull();
  });

  it("after more intake the tail grew; still no compact without invocation", async () => {
    const first = await heavy.sdk.threadView.status({ filePath: heavy.filePath });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    await intake(heavy.sdk, heavy.filePath, [
      validEvent("user_prompt", { payload: { text: "one more question for the heavy thread" } }),
      validEvent("assistant_text", { payload: { text: "one more answer for the heavy thread" } }),
      validEvent("turn_end"),
    ]);

    const second = await heavy.sdk.threadView.status({ filePath: heavy.filePath });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.tailTokens).toBeGreaterThan(first.value.tailTokens);
    expect(second.value.view).toBeNull();
    expect((await stateSnapshot(heavy))["viewRows"]).toBe(0);
  });
});

describe("TC-1.2 / TC-2.5 background legs: model context and status are reads-only in a background SDK with pending work queued", () => {
  it("schedules no catch-up drain: work rows, derivation states, model-call count, and status all unchanged; repeated model-context reads byte-identical", async () => {
    // Pending work manufactured through a manual SDK (its no-op seam never
    // drains): one tool-heavy turn leaves live queue rows and pending derivations.
    const seeder = manualFixture();
    const { filePath } = await newThread(seeder);
    await intake(seeder.sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "background prompt" } }),
      validEvent("tool_call", {
        payload: { toolCallId: "call-bg-1", toolName: "read_file", arguments: { path: "bg.txt" } },
      }),
      validEvent("tool_result", {
        payload: { toolCallId: "call-bg-1", content: "background output", isError: false },
      }),
      validEvent("assistant_text", { payload: { text: "background answer" } }),
      validEvent("turn_end"),
    ]);
    expect(await workItemCount(seeder)).toBeGreaterThan(0);

    // A background-mode consumer on the same instance. Read ops are Convex
    // queries and cannot schedule work, so no first-touch catch-up drain can
    // fire — the read path is side-effect-free by construction.
    const bg = sameInstanceSdk(seeder, "background", { compactThreshold: 100 });
    resetCapturedCalls();
    const before = await stateSnapshot(seeder);

    const one = await bg.threadView.getLlmRequestContext({ filePath });
    const firstStatus = await bg.threadView.status({ filePath });
    const two = await bg.threadView.getLlmRequestContext({ filePath });
    expect(one.ok && two.ok && firstStatus.ok).toBe(true);
    if (!one.ok || !two.ok || !firstStatus.ok) return;

    // The pending work is visible through the read itself (never-attempted
    // derivations bucket as pending).
    expect(firstStatus.value.derivation.pending).toBeGreaterThan(0);

    // Byte-identical repeated model-context reads (AC-1.7) in background mode.
    expect(sha256(one.value)).toBe(sha256(two.value));
    expect(JSON.stringify(one.value)).toBe(JSON.stringify(two.value));

    // Reads only: queue rows, derivation states, view rows, and boundary all
    // unchanged; the fake host observed zero calls.
    expect(await stateSnapshot(seeder)).toEqual(before);
    expect(capturedCalls.length).toBe(0);

    // The status read repeats unchanged too — no state moved underneath it.
    const secondStatus = await bg.threadView.status({ filePath });
    expect(secondStatus.ok).toBe(true);
    if (!secondStatus.ok) return;
    expect(JSON.stringify(secondStatus.value)).toBe(JSON.stringify(firstStatus.value));
  });
});

afterAll(() => {
  // no shared external resources to release under convex-test
});
