import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BatchResult,
  estimateTokens,
  type InferenceCallbacks,
  initLhc,
  type Lhc,
  type MessageEventInput,
  type ModelCall,
  type ModelCallInput,
  type ModelCallResult,
  type SdkConfig,
  threads,
} from "../src/index.js";
import {
  createInferenceCallbacksDouble,
  openRaw,
  readChunks,
  readDerivedForms,
  type TempStore,
  tempStore,
  validEvent,
} from "./fixtures/index.js";

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
});

function tokenText(minTokens: number): string {
  let text = "";
  while (estimateTokens(text) < minTokens) text += "compressionword ";
  return text.trim();
}

async function newThread(): Promise<string> {
  const created = await threads.newThread({
    filePath: store.threadPath(),
    registryPath: store.registryPath,
  });
  if (!created.ok) throw new Error(`thread creation failed: ${created.error.reason}`);
  return created.value.filePath;
}

function sdkFor(inferenceCallbacks: InferenceCallbacks, config: Partial<Pick<SdkConfig, "guards">> = {}): Lhc {
  return initLhc({
    inferenceCallbacks,
    mode: "manual",
    retry: { budget: 3, backoffBaseMs: 0, backoffCapMs: 0 },
    lease: { durationMs: 200 },
    ...config,
  });
}

async function send(sdk: Lhc, filePath: string, batch: readonly MessageEventInput[]): Promise<BatchResult> {
  const result = await sdk.intakeStream.messageEvents({ filePath }, batch);
  if (!result.ok) throw new Error(`batch failed: ${result.error.reason}`);
  return result.value;
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

function formOf(filePath: string, subjectId: string, derivationType: string) {
  return readDerivedForms(filePath).find((f) => f.subjectId === subjectId && f.derivationType === derivationType);
}

function recordingModelCall(text: string): { call: ModelCall; log: ModelCallInput[] } {
  const log: ModelCallInput[] = [];
  return {
    log,
    call: (input): Promise<ModelCallResult> => {
      log.push(structuredClone(input));
      return Promise.resolve({ ok: true, text });
    },
  };
}

describe("Story 3: smooth turn compression", () => {
  it("stores tiny turns as smooth_turn_compression without calling compression inference", async () => {
    const double = createInferenceCallbacksDouble();
    const captured = double.captureInputs();
    const sdk = sdkFor(double, { guards: { smoothTurnCompression: { tinyTurnTokens: 1000 } } });
    const filePath = await newThread();

    await sendTurn(sdk, filePath, "tiny turn", "short answer");
    await drain(sdk, filePath);

    const rendering = formOf(filePath, "t1", "turn_rendering");
    const compression = formOf(filePath, "t1", "smooth_turn_compression");
    expect(captured.filter((entry) => entry.op === "compressSmoothTurn")).toEqual([]);
    expect(rendering).toMatchObject({ state: "ready" });
    expect(compression).toMatchObject({
      state: "ready",
      content: rendering?.content,
    });
    expect(compression?.metadata?.sizeDisposition).toBeUndefined();
  });

  it("renders structured turn text with message-kind markers in record order", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = sdkFor(double, { guards: { smoothTurnCompression: { tinyTurnTokens: 1000 } } });
    const filePath = await newThread();

    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "read runtime state" } }),
      validEvent("assistant_text", { payload: { text: "I will inspect it" } }),
      validEvent("tool_call", {
        payload: { toolCallId: "call-1", toolName: "read_file", arguments: { path: "state.txt" } },
      }),
      validEvent("tool_result", { payload: { toolCallId: "call-1", content: "state is ready", isError: false } }),
      validEvent("turn_end"),
    ]);
    await drain(sdk, filePath);

    const rendering = formOf(filePath, "t1", "turn_rendering")?.content ?? "";
    expect(rendering.indexOf("[1] User prompt (m1)")).toBeLessThan(rendering.indexOf("[2] Assistant response (m2)"));
    expect(rendering.indexOf("[2] Assistant response (m2)")).toBeLessThan(
      rendering.indexOf("[3] Tool call (m3) [outcome: succeeded]"),
    );
    expect(rendering).toContain("read_file");
    expect(rendering).toContain("state is ready");
  });

  it("passes concrete target tokens to compression and records size disposition", async () => {
    const double = createInferenceCallbacksDouble();
    const captured: Array<{ op: "compressSmoothTurn"; input: unknown }> = [];
    const output = tokenText(90);
    const callbacks: InferenceCallbacks = {
      smoothPrompt: (input) => double.smoothPrompt(input),
      summarizeToolResult: (input) => double.summarizeToolResult(input),
      compressSmoothTurn: async (input) => {
        captured.push({ op: "compressSmoothTurn", input: structuredClone(input) });
        return { ok: true, text: output };
      },
      summarizeChunkBrief: (input) => double.summarizeChunkBrief(input),
    };
    const sdk = sdkFor(callbacks);
    const filePath = await newThread();

    await sendTurn(sdk, filePath, "target ratios", tokenText(300));
    await drain(sdk, filePath);

    const call = captured.find((entry) => entry.op === "compressSmoothTurn")?.input as
      | {
          rendering: string;
          inputTokens: number;
          targetMinTokens: number;
          targetAimTokens: number;
          targetMaxTokens: number;
        }
      | undefined;
    expect(call).toBeDefined();
    if (call === undefined) return;
    expect(call.rendering).toContain("[1] User prompt (m1)");
    expect(call.rendering).toContain("[2] Assistant response (m2)");
    expect(call.inputTokens).toBe(estimateTokens(call.rendering));
    expect(call.targetMinTokens).toBe(Math.max(1, Math.round(call.inputTokens * 0.35)));
    expect(call.targetAimTokens).toBe(Math.max(1, Math.round(call.inputTokens * 0.5)));
    expect(call.targetMaxTokens).toBe(Math.max(1, Math.round(call.inputTokens * 0.65)));
    expect(formOf(filePath, "t1", "smooth_turn_compression")).toMatchObject({
      state: "ready",
      content: output,
      metadata: { sizeDisposition: "under_min" },
    });
  });

  it("uses the tuned prompt as the default for model-call hosts", async () => {
    const host = recordingModelCall(tokenText(120));
    const sdk = initLhc({
      mode: "manual",
      inference: { call: host.call },
      guards: { smoothTurnCompression: { tinyTurnTokens: 1 } },
      retry: { budget: 3, backoffBaseMs: 0, backoffCapMs: 0 },
      lease: { durationMs: 200 },
    });
    const filePath = await newThread();

    await sendTurn(sdk, filePath, "target ratios", "assistant answer with enough content");
    await drain(sdk, filePath);

    const compression = formOf(filePath, "t1", "smooth_turn_compression");
    expect(compression).toMatchObject({
      state: "ready",
      metadata: {
        provenance: {
          prompt: "smooth-turn-compression-v1",
        },
      },
    });
    const rendered = host.log.at(-1);
    const promptText = rendered?.messages.map((message) => message.content).join("\n");
    expect(promptText).toContain("Below is one exchange from a coding conversation.");
    expect(promptText).toContain("The final answer must be within");
    expect(promptText).toContain("<turn_rendering_to_compress>");
  });

  it("retries compression while budget remains and does not land fallback yet", async () => {
    const double = createInferenceCallbacksDouble();
    double.failKind("smooth_turn_compression", 99, {
      retryable: true,
      reason: "provider_failure: empty_output: model returned empty or whitespace-only text",
    });
    const sdk = sdkFor(double, { guards: { smoothTurnCompression: { tinyTurnTokens: 1 } } });
    const filePath = await newThread();

    await sendTurn(sdk, filePath, "retry compression", tokenText(120));
    await drain(sdk, filePath, { maxItems: 1 });

    const retrying = await sdk.turns.deriveTurn({ filePath }, "t1");
    expect(retrying.ok).toBe(true);
    if (!retrying.ok) return;
    expect(retrying.value).toMatchObject({
      outcome: "failed",
      error: { code: "derivation_retry_scheduled" },
    });

    const rendering = formOf(filePath, "t1", "turn_rendering");
    const compression = formOf(filePath, "t1", "smooth_turn_compression");
    expect(rendering?.state).toBe("pending");
    expect(compression?.state).toBe("pending");

    const db = openRaw(filePath);
    try {
      const live = db
        .prepare(`SELECT status, attempts FROM work_item WHERE work_item_id = 'w-t1-turn_derivation-v1'`)
        .get() as { status: string; attempts: number } | undefined;
      expect(live).toMatchObject({ status: "queued", attempts: 1 });
    } finally {
      db.close();
    }
  });

  it("terminal compression failure lands turn_rendering and smooth_turn_compression ready with rendering fallback", async () => {
    const double = createInferenceCallbacksDouble();
    double.failKind("smooth_turn_compression", 99, {
      retryable: true,
      reason: "provider_failure: empty_output: model returned empty or whitespace-only text",
    });
    const sdk = sdkFor(double, { guards: { smoothTurnCompression: { tinyTurnTokens: 1 } } });
    const filePath = await newThread();

    await sendTurn(sdk, filePath, "fallback compression", tokenText(120));
    const drained = await sdk.work.drain({ filePath });
    expect(drained.ok).toBe(true);
    if (!drained.ok) return;
    expect(drained.value.ran).toContainEqual(
      expect.objectContaining({
        workItemId: "w-t1-turn_derivation-v1",
        disposition: "done",
      }),
    );

    const rendering = formOf(filePath, "t1", "turn_rendering");
    const compression = formOf(filePath, "t1", "smooth_turn_compression");
    expect(rendering).toMatchObject({ state: "ready" });
    expect(compression).toMatchObject({
      state: "ready",
      content: rendering?.content,
      metadata: {
        fallbackFloor: "turn_rendering",
        fallbackUsed: true,
        inferenceAttempted: true,
        inferenceSucceeded: false,
        lastError: "provider_failure: empty_output: model returned empty or whitespace-only text",
      },
    });

    const derivationLog = await sdk.logging.queryDerivationLog(
      { filePath },
      { subjectId: "t1", derivationType: "smooth_turn_compression" },
    );
    expect(derivationLog.ok).toBe(true);
    if (!derivationLog.ok) return;
    expect(derivationLog.value.map((entry) => entry.eventKind)).toEqual(
      expect.arrayContaining(["inference_failed", "retry_scheduled", "fallback_applied"]),
    );
    const failedEvents = derivationLog.value.filter((entry) => entry.eventKind === "inference_failed");
    const fallbackEvent = derivationLog.value.find((entry) => entry.eventKind === "fallback_applied");
    expect(failedEvents.length).toBeGreaterThanOrEqual(1);
    expect(failedEvents.at(-1)?.payload.reason).toContain("empty_output");
    expect(fallbackEvent?.payload).toMatchObject({
      fallbackFloor: "turn_rendering",
      reason: expect.stringContaining("empty_output"),
    });

    const chunks = readChunks(filePath);
    expect(chunks.members.some((member) => member.turnId === "t1")).toBe(true);

    const logs = await sdk.logging.query(
      { filePath },
      { derivationType: "smooth_turn_compression", subjectId: "t1", level: "warning" },
    );
    expect(logs.ok).toBe(true);
    if (!logs.ok) return;
    expect(logs.value).toEqual([
      expect.objectContaining({
        message: "turn compression fallback used",
        reason: "provider_failure: empty_output: model returned empty or whitespace-only text",
        floorUsed: "turn_rendering",
      }),
    ]);
  });
});
