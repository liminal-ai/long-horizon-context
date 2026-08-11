// Story 3: turn construction recovery cascade, ported to the component. A turn
// composes from its members' message derivations; when a derivation is not
// ready the composer floors it deterministically (cleaned prompt, recorded tool
// args, truncated tool result) and — with no live work in flight — writes the
// floor back to the message derivation with a fallback log. Ready derivations
// are used verbatim and never overwritten.
//
// turn_rendering is deterministic here: each part renders as
// `${label}${suffix}\n${text}` joined by "\n\n" (queue.ts composeStructuredTurnText),
// so the composition tests read the stored rendering back instead of capturing a
// model call, exactly as the frozen suite does.
//
// EXCLUDED (documented in the ledger), both defensive behaviors for artificial
// states the component's normal pipeline never produces:
//  - "leaves derivation rows untouched when live work exists but still renders a
//    floor": the component composes the floored rendering identically, but its
//    completion write-back is not gated on a live work item for the message
//    derivation, so it stamps the floor ready rather than leaving it pending.
//    The serial FIFO drain enqueues a message's smoothing strictly before the
//    turn derivation, so a pending message derivation never coexists with a
//    running turn derivation in the normal pipeline.
//  - "logs fallback when a message derivation row is absent": the component
//    floors the rendering correctly for an absent row, but its recovery
//    write-back only patches an existing derivation row (it does not recreate a
//    deleted one), so no row is written back and no fallback log is emitted.
//    Message derivation rows are always created at intake, so an absent row is
//    unreachable without direct deletion.
import { beforeEach, describe, expect, test } from "vitest";
import type { Lhc, MessageEventInput } from "../src/client/index.js";
import { truncateForFallback } from "../src/shared/tool_result_rendering.js";
import { capturedCalls, resetCapturedCalls } from "./convex/model.js";
import { type ServiceFixture, serviceFixture, validEvent } from "./fixtures/index.js";

type Fixture = ServiceFixture;

// The fixture assigns these model strings per lane; a captured call to either
// proves the corresponding message inference ran.
const SMOOTHING_MODEL = "model-smoothed_prompt";
const TOOL_SUMMARY_MODEL = "model-tool_result_summary";

beforeEach(() => {
  resetCapturedCalls();
});

function makeFixture(overrides: Parameters<typeof serviceFixture>[0] = {}): Fixture {
  return serviceFixture({
    ...overrides,
    guards: {
      ...overrides.guards,
      detailedTurnCompression: { tinyTurnTokens: 1, ...overrides.guards?.detailedTurnCompression },
    },
  });
}

async function send(sdk: Lhc, filePath: string, batch: readonly MessageEventInput[]): Promise<void> {
  const result = await sdk.intakeStream.messageEvents({ filePath }, batch);
  if (!result.ok) throw new Error(result.error.reason);
}

async function drain(sdk: Lhc, filePath: string, opts?: { maxItems?: number }): Promise<void> {
  const result = await sdk.work.drain({ filePath }, opts);
  if (!result.ok) throw new Error(result.error.reason);
}

async function messageForm(sdk: Lhc, filePath: string, subjectId: string, derivationType: string) {
  const report = await sdk.messages.report({ filePath }, { messageId: subjectId });
  if (!report.ok) throw new Error(report.error.reason);
  return report.value.find((form) => form.derivationType === derivationType);
}

async function renderingContent(sdk: Lhc, filePath: string): Promise<string> {
  const report = await sdk.turns.report({ filePath }, { turnId: "t1" });
  if (!report.ok) throw new Error(report.error.reason);
  return report.value.find((form) => form.derivationType === "turn_rendering")?.content ?? "";
}

function stripEntityXml(body: string): string {
  // Block wrap: <mN>\n…\n</mN>. Tool-run lines: <mN>…</mN> on each line.
  const block = body.match(/^<m\d+>\n([\s\S]*)\n<\/m\d+>$/);
  if (block?.[1] !== undefined) return block[1];
  return body.replace(/<\/m\d+>/g, "").replace(/<m\d+>/g, "");
}

// turn_rendering is `${label}${suffix}\n${body}` sections joined by "\n\n"
// inside the turn's <tN> wrap; dropping the label line and the entity tags of
// each section yields the per-part body (mirrors the frozen helper at the pin).
async function renderingBodies(sdk: Lhc, filePath: string): Promise<string[]> {
  let content = await renderingContent(sdk, filePath);
  // Drop the outer <tN>…</tN> wrap added for addressable smooth history.
  content = content.replace(/^<t\d+>\n/, "").replace(/\n<\/t\d+>$/, "");
  return content.split("\n\n").map((part) => stripEntityXml(part.split("\n").slice(1).join("\n")));
}

async function deleteWork(fixture: Fixture, thread: string, kind: string): Promise<void> {
  await fixture.test.run(async (ctx) => {
    const rows = await ctx.db.query("workItems").collect();
    for (const row of rows) {
      if (row.instance === fixture.instance && row.thread === thread && row.kind === kind) {
        await ctx.db.delete("workItems", row._id);
      }
    }
  });
}

async function patchMessageDerivation(
  fixture: Fixture,
  thread: string,
  subjectId: string,
  derivationType: string,
  update: { state: "pending" | "ready" | "failed"; content?: string; reason?: string },
): Promise<void> {
  await fixture.test.run(async (ctx) => {
    const rows = await ctx.db.query("derivations").collect();
    const row = rows.find(
      (r) =>
        r.instance === fixture.instance &&
        r.thread === thread &&
        r.scope === "message" &&
        r.subject === subjectId &&
        r.deriv === derivationType,
    );
    if (row === undefined) throw new Error(`derivation ${subjectId}/${derivationType} missing`);
    await ctx.db.patch("derivations", row._id, {
      state: update.state,
      content: update.content,
      reason: update.reason,
      metadata: undefined,
      derivedAt: "2026-01-01T00:00:00.000Z",
    });
  });
}

function laneCalls(sinceIndex: number, model: string) {
  return capturedCalls.slice(sinceIndex).filter((call) => call.model === model);
}

describe("Story 3: turn construction recovery cascade", () => {
  test("uses ready derivations directly and writes no fallback log", async () => {
    const fixture = makeFixture();
    const { filePath } = await fixture.createThread();

    await send(fixture.sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "ready prompt" } }),
      validEvent("assistant_text", { payload: { text: "answer" } }),
      validEvent("turn_end"),
    ]);
    await drain(fixture.sdk, filePath);

    const smoothed = (await messageForm(fixture.sdk, filePath, "m1", "smoothed_prompt"))?.content;
    expect((await renderingBodies(fixture.sdk, filePath))[0]).toBe(smoothed);

    const logs = await fixture.sdk.logging.query({ filePath }, { reason: "not_ready" });
    expect(logs.ok).toBe(true);
    if (!logs.ok) return;
    expect(logs.value).toEqual([]);
  });

  test("falls pending derivations to deterministic floors when re-derivation does not complete", async () => {
    const fixture = makeFixture();
    const { filePath, threadId } = await fixture.createThread();

    await send(fixture.sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "  pending    prompt because i asked  " } }),
      validEvent("assistant_text", { payload: { text: "answer" } }),
      validEvent("turn_end"),
    ]);
    await deleteWork(fixture, threadId, "prompt_smoothing");

    await drain(fixture.sdk, filePath);

    expect((await renderingBodies(fixture.sdk, filePath))[0]).toBe("pending prompt because I asked");
    expect(await messageForm(fixture.sdk, filePath, "m1", "smoothed_prompt")).toMatchObject({
      state: "ready",
      content: "pending prompt because I asked",
    });

    const logs = await fixture.sdk.logging.query({ filePath }, { derivationType: "smoothed_prompt" });
    expect(logs.ok).toBe(true);
    if (!logs.ok) return;
    expect(logs.value.map((entry) => [entry.subjectId, entry.reason, entry.floorUsed])).toEqual([
      ["m1", "not_ready", "pending prompt because I asked"],
    ]);
  });

  test("falls back to original prompt source when the deterministic floor is unavailable", async () => {
    const fixture = makeFixture();
    const { filePath, threadId } = await fixture.createThread();
    const original = " \t\n  ";

    await send(fixture.sdk, filePath, [
      validEvent("user_prompt", { payload: { text: original } }),
      validEvent("assistant_text", { payload: { text: "answer" } }),
      validEvent("turn_end"),
    ]);
    await deleteWork(fixture, threadId, "prompt_smoothing");

    await drain(fixture.sdk, filePath);

    expect((await renderingBodies(fixture.sdk, filePath))[0]).toBe(original);
    expect(await messageForm(fixture.sdk, filePath, "m1", "smoothed_prompt")).toMatchObject({
      state: "ready",
      content: original,
    });
  });

  test("falls failed derivations through the same floor path when re-derivation does not complete", async () => {
    const fixture = makeFixture();
    const { filePath, threadId } = await fixture.createThread();

    await send(fixture.sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "  failed    prompt because i asked  " } }),
      validEvent("assistant_text", { payload: { text: "answer" } }),
      validEvent("turn_end"),
    ]);
    await deleteWork(fixture, threadId, "prompt_smoothing");
    await patchMessageDerivation(fixture, threadId, "m1", "smoothed_prompt", { state: "failed", reason: "terminal" });

    await drain(fixture.sdk, filePath);

    expect((await renderingBodies(fixture.sdk, filePath))[0]).toBe("failed prompt because I asked");
    expect(await messageForm(fixture.sdk, filePath, "m1", "smoothed_prompt")).toMatchObject({
      state: "ready",
      content: "failed prompt because I asked",
    });
  });

  test("uses deterministic floors for failed message derivations without calling message inference", async () => {
    const fixture = makeFixture();
    const { filePath, threadId } = await fixture.createThread();

    await send(fixture.sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "  recover    me  " } }),
      validEvent("assistant_text", { payload: { text: "answer" } }),
      validEvent("turn_end"),
    ]);
    await deleteWork(fixture, threadId, "prompt_smoothing");
    await patchMessageDerivation(fixture, threadId, "m1", "smoothed_prompt", { state: "failed", reason: "terminal" });
    const callsBeforeTurn = capturedCalls.length;

    await drain(fixture.sdk, filePath);

    expect(laneCalls(callsBeforeTurn, SMOOTHING_MODEL)).toEqual([]);
    expect((await renderingBodies(fixture.sdk, filePath))[0]).toBe("recover me");
    const form = await messageForm(fixture.sdk, filePath, "m1", "smoothed_prompt");
    expect(form).toMatchObject({ state: "ready", content: "recover me" });
    expect(form?.reason).toBeUndefined();
    const logs = await fixture.sdk.logging.query({ filePath }, { derivationType: "smoothed_prompt" });
    expect(logs.ok).toBe(true);
    if (!logs.ok) return;
    expect(logs.value.map((entry) => [entry.subjectId, entry.reason])).toEqual([["m1", "failed_floor"]]);
  });

  test("does not overwrite an already-ready message derivation when composing the turn", async () => {
    const fixture = makeFixture();
    const { filePath, threadId } = await fixture.createThread();

    await send(fixture.sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "  race    prompt because i asked  " } }),
      validEvent("assistant_text", { payload: { text: "answer" } }),
      validEvent("turn_end"),
    ]);
    await drain(fixture.sdk, filePath, { maxItems: 1 });
    await patchMessageDerivation(fixture, threadId, "m1", "smoothed_prompt", {
      state: "ready",
      content: "real worker output",
    });

    const derived = await fixture.sdk.turns.deriveTurn({ filePath }, "t1");
    expect(derived.ok).toBe(true);
    expect((await renderingBodies(fixture.sdk, filePath))[0]).toBe("real worker output");
    expect(await messageForm(fixture.sdk, filePath, "m1", "smoothed_prompt")).toMatchObject({
      state: "ready",
      content: "real worker output",
    });
  });

  test("renders assistant text, thinking, and runtime notes verbatim in record order", async () => {
    const fixture = makeFixture();
    const { filePath } = await fixture.createThread();

    await send(fixture.sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "order check" } }),
      validEvent("assistant_text", { payload: { text: "first answer" } }),
      validEvent("assistant_thinking", { payload: { text: "thinking exactly" } }),
      validEvent("runtime_note", { payload: { text: "runtime changed exactly" } }),
      validEvent("assistant_text", { payload: { text: "second answer" } }),
      validEvent("turn_end"),
    ]);

    await drain(fixture.sdk, filePath);

    const smoothed = (await messageForm(fixture.sdk, filePath, "m1", "smoothed_prompt"))?.content;
    expect(await renderingBodies(fixture.sdk, filePath)).toEqual([
      smoothed,
      "first answer",
      "thinking exactly",
      "runtime changed exactly",
      "second answer",
    ]);
  });

  test("floors small tool-result summaries without calling message inference during turn construction", async () => {
    const fixture = makeFixture();
    const { filePath, threadId } = await fixture.createThread();
    const content = "tool-output";

    await send(fixture.sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "summarize tool" } }),
      validEvent("tool_call", {
        payload: { toolCallId: "call", toolName: "read_file", arguments: { path: "large.txt" } },
      }),
      validEvent("tool_result", { payload: { toolCallId: "call", content, isError: false } }),
      validEvent("turn_end"),
    ]);
    await deleteWork(fixture, threadId, "tool_result_summary");
    const callsBeforeTurn = capturedCalls.length;

    await drain(fixture.sdk, filePath);

    expect(laneCalls(callsBeforeTurn, TOOL_SUMMARY_MODEL)).toEqual([]);
    const floored = truncateForFallback(content);
    expect(await renderingContent(fixture.sdk, filePath)).toContain(floored);
    expect(await messageForm(fixture.sdk, filePath, "m3", "tool_result_summary")).toMatchObject({
      state: "ready",
      content: floored,
    });
  });

  test("floors over-large failed tool-result summaries with deterministic truncation and no turn-time inference", async () => {
    const fixture = makeFixture();
    const { filePath, threadId } = await fixture.createThread();
    const content = "large-result-token ".repeat(6000);

    await send(fixture.sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "summarize the large result" } }),
      validEvent("tool_call", {
        payload: { toolCallId: "call", toolName: "read_file", arguments: { path: "huge.log" } },
      }),
      validEvent("tool_result", { payload: { toolCallId: "call", content, isError: false } }),
      validEvent("turn_end"),
    ]);
    await patchMessageDerivation(fixture, threadId, "m3", "tool_result_summary", {
      state: "failed",
      reason: "scripted failure",
    });
    await deleteWork(fixture, threadId, "tool_result_summary");
    const callsBeforeTurn = capturedCalls.length;

    await drain(fixture.sdk, filePath);

    expect(laneCalls(callsBeforeTurn, TOOL_SUMMARY_MODEL)).toEqual([]);
    const floored = await messageForm(fixture.sdk, filePath, "m3", "tool_result_summary");
    expect(floored).toMatchObject({ state: "ready" });
    expect(floored?.content).toContain("large-result-token");
    expect(floored?.content?.length).toBeLessThan(content.length);
    expect(await renderingContent(fixture.sdk, filePath)).toContain(floored?.content ?? "");
    expect(await renderingContent(fixture.sdk, filePath)).toContain("[fallback; outcome: succeeded]");
  });

  test("floors failed tool-result summaries during turn construction without re-running classification inference", async () => {
    const fixture = makeFixture();
    const { filePath, threadId } = await fixture.createThread();
    const content = "search-hit ".repeat(1500);

    await send(fixture.sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "summarize search output" } }),
      validEvent("tool_call", {
        payload: { toolCallId: "call", toolName: "bash", arguments: { command: "rg TODO src" } },
      }),
      validEvent("tool_result", { payload: { toolCallId: "call", content, isError: true } }),
      validEvent("turn_end"),
    ]);
    await deleteWork(fixture, threadId, "tool_result_summary");
    const callsBeforeTurn = capturedCalls.length;

    await drain(fixture.sdk, filePath);

    expect(laneCalls(callsBeforeTurn, TOOL_SUMMARY_MODEL)).toEqual([]);
    const floored = await messageForm(fixture.sdk, filePath, "m3", "tool_result_summary");
    expect(floored).toMatchObject({ state: "ready" });
    expect(floored?.content).toContain("search-hit");
    expect(floored?.content?.length).toBeLessThan(content.length);
    expect(await renderingContent(fixture.sdk, filePath)).toContain(floored?.content ?? "");
    expect(await renderingContent(fixture.sdk, filePath)).toContain("[fallback; outcome: failed]");
  });

  test("recovers over-cap prompts with deterministic cleaned text and no smoothing model call", async () => {
    const fixture = makeFixture({ guards: { smoothedPrompt: { maxInferenceTokens: 1 } } });
    const { filePath, threadId } = await fixture.createThread();

    await send(fixture.sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "  please    fix this because i asked  " } }),
      validEvent("assistant_text", { payload: { text: "answer" } }),
      validEvent("turn_end"),
    ]);
    await deleteWork(fixture, threadId, "prompt_smoothing");

    await drain(fixture.sdk, filePath);

    expect(laneCalls(0, SMOOTHING_MODEL)).toEqual([]);
    expect(await messageForm(fixture.sdk, filePath, "m1", "smoothed_prompt")).toMatchObject({
      state: "ready",
      content: "please fix this because I asked",
    });
  });

  test("constructs a turn with every component present when multiple derivations are not ready", async () => {
    const fixture = makeFixture();
    const { filePath, threadId } = await fixture.createThread();

    await send(fixture.sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "  multi    fallback because i asked  " } }),
      validEvent("tool_call", {
        payload: { toolCallId: "call", toolName: "read_file", arguments: { path: "multi.txt" } },
      }),
      validEvent("tool_result", { payload: { toolCallId: "call", content: "tool-output", isError: false } }),
      validEvent("assistant_text", { payload: { text: "answer after tool" } }),
      validEvent("turn_end"),
    ]);
    await deleteWork(fixture, threadId, "prompt_smoothing");
    await deleteWork(fixture, threadId, "tool_result_summary");

    await drain(fixture.sdk, filePath);

    const rendering = await renderingContent(fixture.sdk, filePath);
    expect(rendering).toContain("multi fallback because I asked");
    expect(rendering).toContain('read_file({"path":"multi.txt"})');
    expect(rendering).toContain("tool-output");
    expect(rendering).toContain("answer after tool");
    expect(await messageForm(fixture.sdk, filePath, "m1", "smoothed_prompt")).toMatchObject({
      state: "ready",
      content: "multi fallback because I asked",
    });
    expect(await messageForm(fixture.sdk, filePath, "m3", "tool_result_summary")).toMatchObject({
      state: "ready",
      content: "tool-output",
    });
  });
});
