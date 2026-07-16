// Story 3: detailed turn compression, ported to the component. Tiny turns skip
// compression inference; the pre_detailed_assembly is composed from dialogue
// only; the turn rendering carries kind markers in record order; the concrete
// target tokens flow into the compression call (asserted by rebuilding the
// exact rendered call from the assembly and the ratio math); the tuned v3
// prompt is the default; and a compression failure lands ready on the
// pre_detailed_assembly floor with fallback metadata, logs, and chunk
// membership intact.
//
// The frozen per-item drain-report assertions (report.ran disposition,
// w-t1-* work-item ids) have no analog: the DrainReport is an aggregate and
// work-item ids are opaque sequence keys. Two-stage enqueue is asserted on the
// stored derivations and the queued work item directly.
import { beforeEach, describe, expect, test } from "vitest";
import type { Lhc, MessageEventInput } from "../src/client/index.js";
import { PROMPT_REGISTRY, type PromptTemplate } from "../src/shared/prompts/index.js";
import { estimateTokens } from "../src/shared/token_counting/index.js";
import { capturedCalls, resetCapturedCalls } from "./convex/model.js";
import { serviceFixture, validEvent } from "./fixtures/index.js";

type Fixture = ReturnType<typeof serviceFixture>;

function renderByName(name: string, input: unknown): unknown {
  return (PROMPT_REGISTRY[name] as PromptTemplate<unknown> | undefined)?.render(input);
}

// Convex's empty-output classification wording; the meaningful token is
// "empty_output".
const EMPTY_OUTPUT_REASON = "provider_failure: empty_output: model returned no text";

beforeEach(() => {
  resetCapturedCalls();
});

function tokenText(minTokens: number): string {
  let text = "";
  while (estimateTokens(text) < minTokens) text += "compressionword ";
  return text.trim();
}

function compressionInput(dialogueText: string) {
  const inputTokens = estimateTokens(dialogueText);
  return {
    dialogueText,
    inputTokens,
    targetMinTokens: Math.max(1, Math.round(inputTokens * 0.35)),
    targetAimTokens: Math.max(1, Math.round(inputTokens * 0.5)),
    targetMaxTokens: Math.max(1, Math.round(inputTokens * 0.65)),
  };
}

async function newThread(fixture: Fixture): Promise<string> {
  return (await fixture.createThread()).filePath;
}

async function send(sdk: Lhc, filePath: string, batch: readonly MessageEventInput[]): Promise<void> {
  const result = await sdk.intakeStream.messageEvents({ filePath }, batch);
  if (!result.ok) throw new Error(result.error.reason);
}

async function sendTurn(sdk: Lhc, filePath: string, prompt: string, answer: string): Promise<void> {
  await send(sdk, filePath, [
    validEvent("user_prompt", { payload: { text: prompt } }),
    validEvent("assistant_text", { payload: { text: answer } }),
    validEvent("turn_end"),
  ]);
}

async function drain(sdk: Lhc, filePath: string, opts?: { maxItems?: number }) {
  const result = await sdk.work.drain({ filePath }, opts);
  if (!result.ok) throw new Error(result.error.reason);
  return result.value;
}

async function turnForm(sdk: Lhc, filePath: string, turnId: string, derivationType: string) {
  const report = await sdk.turns.report({ filePath }, { turnId });
  if (!report.ok) throw new Error(report.error.reason);
  return report.value.find((form) => form.derivationType === derivationType);
}

describe("Story 3: detailed turn compression", () => {
  test("stores tiny turns as detailed_turn_compression without calling compression inference", async () => {
    const fixture = serviceFixture({ guards: { detailedTurnCompression: { tinyTurnTokens: 1000 } } });
    const filePath = await newThread(fixture);

    await sendTurn(fixture.sdk, filePath, "tiny turn", "short answer");
    await drain(fixture.sdk, filePath);

    const assembly = await turnForm(fixture.sdk, filePath, "t1", "pre_detailed_assembly");
    const compression = await turnForm(fixture.sdk, filePath, "t1", "detailed_turn_compression");
    expect(assembly).toMatchObject({ state: "ready" });
    expect(compression).toMatchObject({ state: "ready", content: assembly?.content });
    // No compression inference: the skip path stamps no metadata (no
    // provenance, no sizeDisposition).
    expect(compression?.metadata).toBeUndefined();
  });

  test("composes pre_detailed_assembly from dialog only in User/Assistant sections", async () => {
    // Over-cap smoothing stores the cleaned prompt verbatim, so the assembly's
    // User section carries the prompt text rather than a model summary.
    const fixture = serviceFixture({
      guards: { detailedTurnCompression: { tinyTurnTokens: 1000 }, smoothedPrompt: { maxInferenceTokens: 1 } },
    });
    const filePath = await newThread(fixture);

    await send(fixture.sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "read runtime state" } }),
      validEvent("assistant_thinking", { payload: { text: "planning the read" } }),
      validEvent("assistant_text", { payload: { text: "I will inspect it" } }),
      validEvent("tool_call", {
        payload: { toolCallId: "call-1", toolName: "read_file", arguments: { path: "state.txt" } },
      }),
      validEvent("tool_result", { payload: { toolCallId: "call-1", content: "state is ready", isError: false } }),
      validEvent("turn_end"),
    ]);
    await drain(fixture.sdk, filePath);

    const assembly = (await turnForm(fixture.sdk, filePath, "t1", "pre_detailed_assembly"))?.content ?? "";
    expect(assembly).toContain("User:\n");
    expect(assembly).toContain("read runtime state");
    expect(assembly).toContain("⏺ I will inspect it");
    expect(assembly).not.toContain("planning the read");
    expect(assembly).not.toContain("read_file");
    expect(assembly).not.toContain("state is ready");
    expect(assembly).not.toMatch(/\[1\]/);
  });

  test("item 1 writes deterministic derivations and enqueues detailed_turn_compression", async () => {
    const fixture = serviceFixture({ guards: { detailedTurnCompression: { tinyTurnTokens: 1 } } });
    const filePath = await newThread(fixture);

    await sendTurn(fixture.sdk, filePath, "two item flow", tokenText(120));
    // Run smoothing and the turn derivation, but not the enqueued compression.
    await drain(fixture.sdk, filePath, { maxItems: 2 });

    expect(await turnForm(fixture.sdk, filePath, "t1", "turn_rendering")).toMatchObject({ state: "ready" });
    expect(await turnForm(fixture.sdk, filePath, "t1", "pre_detailed_assembly")).toMatchObject({ state: "ready" });

    // Compression is enqueued as separate work and has not yet landed ready.
    const midState = await fixture.test.run(async (ctx) => {
      const derivations = await ctx.db.query("derivations").collect();
      const compression = derivations.find(
        (row) => row.instance === fixture.instance && row.subject === "t1" && row.deriv === "detailed_turn_compression",
      );
      const workItems = await ctx.db.query("workItems").collect();
      const queued = workItems.find(
        (row) => row.instance === fixture.instance && row.kind === "detailed_turn_compression",
      );
      return { compressionState: compression?.state, queuedStatus: queued?.status };
    });
    expect(midState.compressionState).not.toBe("ready");
    expect(midState.queuedStatus).toBe("queued");

    await drain(fixture.sdk, filePath);
    expect(await turnForm(fixture.sdk, filePath, "t1", "detailed_turn_compression")).toMatchObject({ state: "ready" });
  });

  test("renders structured turn text with message-kind markers in record order", async () => {
    const fixture = serviceFixture({ guards: { detailedTurnCompression: { tinyTurnTokens: 1000 } } });
    const filePath = await newThread(fixture);

    await send(fixture.sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "read runtime state" } }),
      validEvent("assistant_text", { payload: { text: "I will inspect it" } }),
      validEvent("tool_call", {
        payload: { toolCallId: "call-1", toolName: "read_file", arguments: { path: "state.txt" } },
      }),
      validEvent("tool_result", { payload: { toolCallId: "call-1", content: "state is ready", isError: false } }),
      validEvent("turn_end"),
    ]);
    await drain(fixture.sdk, filePath);

    const rendering = (await turnForm(fixture.sdk, filePath, "t1", "turn_rendering"))?.content ?? "";
    expect(rendering.indexOf("User prompt\n")).toBeLessThan(rendering.indexOf("Assistant response\n"));
    expect(rendering.indexOf("Assistant response\n")).toBeLessThan(
      rendering.indexOf("Tool call [outcome: succeeded]\n"),
    );
    expect(rendering).toContain("read_file");
    expect(rendering).toContain("state is ready");
  });

  test("passes concrete target tokens to compression and records size disposition", async () => {
    const output = tokenText(90);
    // Over-cap smoothing keeps the prompt text in the assembly's User section.
    const fixture = serviceFixture({
      models: { detailed_turn_compression: `success:${output}` },
      guards: { smoothedPrompt: { maxInferenceTokens: 1 } },
    });
    const filePath = await newThread(fixture);

    await sendTurn(fixture.sdk, filePath, "target ratios", tokenText(300));
    await drain(fixture.sdk, filePath);

    const dialogueText = (await turnForm(fixture.sdk, filePath, "t1", "pre_detailed_assembly"))?.content ?? "";
    const input = compressionInput(dialogueText);
    expect(dialogueText).toContain("User:\n");
    expect(dialogueText).toContain("target ratios");
    expect(dialogueText).toContain("⏺ ");
    expect(dialogueText).not.toContain("[1] User prompt");

    // The concrete target tokens (min/aim/max = round(inputTokens*0.35/0.5/0.65))
    // flow into the compression call: rebuild the exact rendered call from the
    // assembly and the ratio math and match it against what the host received.
    const compressionCall = capturedCalls.find((call) => call.model === `success:${output}`);
    expect(compressionCall?.messages).toEqual(renderByName("detailed-turn-compression-v3", input));

    const outputTokens = estimateTokens(output);
    const disposition =
      outputTokens < input.targetMinTokens
        ? "under_min"
        : outputTokens > input.targetMaxTokens
          ? "over_max"
          : "in_range";
    expect(await turnForm(fixture.sdk, filePath, "t1", "detailed_turn_compression")).toMatchObject({
      state: "ready",
      content: output,
      metadata: { sizeDisposition: disposition },
    });
  });

  test("uses the tuned prompt as the default for model-call hosts", async () => {
    const output = tokenText(120);
    const fixture = serviceFixture({
      models: { detailed_turn_compression: `success:${output}` },
      guards: { detailedTurnCompression: { tinyTurnTokens: 1 } },
    });
    const filePath = await newThread(fixture);

    await sendTurn(fixture.sdk, filePath, "target ratios", "assistant answer with enough content");
    await drain(fixture.sdk, filePath);

    const compression = await turnForm(fixture.sdk, filePath, "t1", "detailed_turn_compression");
    expect(compression).toMatchObject({
      state: "ready",
      metadata: { provenance: { prompt: "detailed-turn-compression-v3" } },
    });

    const compressionCall = capturedCalls.find((call) => call.model === `success:${output}`);
    const promptText = compressionCall?.messages.map((message) => message.content).join("\n") ?? "";
    expect(promptText).toContain("<instructions-for-summarizing>");
    expect(promptText).toContain("<content-for-summarizing>");
    expect(promptText).toContain("targetting approximately 20%-30%");

    const derivationLog = await fixture.sdk.logging.queryDerivationLog(
      { filePath },
      { subjectId: "t1", derivationType: "detailed_turn_compression" },
    );
    expect(derivationLog.ok).toBe(true);
    if (!derivationLog.ok) return;
    const succeeded = derivationLog.value.find((entry) => entry.eventKind === "inference_succeeded");
    expect(succeeded?.["payload"]).toMatchObject({
      provenance: { provider: "test", prompt: "detailed-turn-compression-v3" },
      requestMessages: compressionCall?.messages,
      rawResponse: output,
    });
  });

  test("compression failure logs requestMessages on inference_failed", async () => {
    const fixture = serviceFixture({
      models: { detailed_turn_compression: "whitespace" },
      guards: { detailedTurnCompression: { tinyTurnTokens: 1 } },
    });
    const filePath = await newThread(fixture);

    await sendTurn(fixture.sdk, filePath, "observable failure", tokenText(120));
    await drain(fixture.sdk, filePath);

    const dialogueText = (await turnForm(fixture.sdk, filePath, "t1", "pre_detailed_assembly"))?.content ?? "";
    const derivationLog = await fixture.sdk.logging.queryDerivationLog(
      { filePath },
      { subjectId: "t1", derivationType: "detailed_turn_compression" },
    );
    expect(derivationLog.ok).toBe(true);
    if (!derivationLog.ok) return;
    const failed = derivationLog.value.find((entry) => entry.eventKind === "inference_failed");
    expect(failed?.["payload"]).toMatchObject({
      reason: EMPTY_OUTPUT_REASON,
      requestMessages: renderByName("detailed-turn-compression-v3", compressionInput(dialogueText)),
    });
  });

  test("the first compression failure lands ready with the pre_detailed_assembly fallback", async () => {
    const fixture = serviceFixture({
      models: { detailed_turn_compression: "whitespace" },
      guards: { detailedTurnCompression: { tinyTurnTokens: 1 } },
    });
    const filePath = await newThread(fixture);

    await sendTurn(fixture.sdk, filePath, "fallback compression", tokenText(120));
    await drain(fixture.sdk, filePath);

    const assembly = await turnForm(fixture.sdk, filePath, "t1", "pre_detailed_assembly");
    const compression = await turnForm(fixture.sdk, filePath, "t1", "detailed_turn_compression");
    expect(await turnForm(fixture.sdk, filePath, "t1", "turn_rendering")).toMatchObject({ state: "ready" });
    expect(assembly).toMatchObject({ state: "ready" });
    expect(compression).toMatchObject({
      state: "ready",
      content: assembly?.content,
      metadata: {
        fallbackFloor: "pre_detailed_assembly",
        fallbackUsed: true,
        inferenceAttempted: true,
        inferenceSucceeded: false,
        lastError: EMPTY_OUTPUT_REASON,
      },
    });

    const derivationLog = await fixture.sdk.logging.queryDerivationLog(
      { filePath },
      { subjectId: "t1", derivationType: "detailed_turn_compression" },
    );
    expect(derivationLog.ok).toBe(true);
    if (!derivationLog.ok) return;
    expect(derivationLog.value.map((entry) => entry.eventKind)).toEqual(
      expect.arrayContaining(["inference_failed", "fallback_applied"]),
    );
    const failedEvents = derivationLog.value.filter((entry) => entry.eventKind === "inference_failed");
    const fallbackEvent = derivationLog.value.find((entry) => entry.eventKind === "fallback_applied");
    expect(failedEvents).toHaveLength(1);
    expect((failedEvents.at(-1)?.["payload"] as { reason: string }).reason).toContain("empty_output");
    expect(fallbackEvent?.["payload"]).toMatchObject({
      fallbackFloor: "pre_detailed_assembly",
      reason: expect.stringContaining("empty_output"),
    });

    // The turn is still placed in a chunk despite the compression fallback.
    const chunks = await fixture.sdk.turns.listChunks({ filePath });
    expect(chunks.ok).toBe(true);
    if (!chunks.ok) return;
    expect(chunks.value.some((chunk) => chunk.memberTurnIds.includes("t1"))).toBe(true);

    const logs = await fixture.sdk.logging.query(
      { filePath },
      { derivationType: "detailed_turn_compression", subjectId: "t1", level: "warning" },
    );
    expect(logs.ok).toBe(true);
    if (!logs.ok) return;
    expect(logs.value).toHaveLength(1);
    expect(logs.value[0]).toMatchObject({
      message: "turn compression fallback used",
      reason: EMPTY_OUTPUT_REASON,
      floorUsed: "pre_detailed_assembly",
    });
  });
});
