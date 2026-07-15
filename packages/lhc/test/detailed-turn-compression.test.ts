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

describe("Story 3: detailed turn compression", () => {
  it("stores tiny turns as detailed_turn_compression without calling compression inference", async () => {
    const double = createInferenceCallbacksDouble();
    const captured = double.captureInputs();
    const sdk = sdkFor(double, { guards: { detailedTurnCompression: { tinyTurnTokens: 1000 } } });
    const filePath = await newThread();

    await sendTurn(sdk, filePath, "tiny turn", "short answer");
    await drain(sdk, filePath);

    const assembly = formOf(filePath, "t1", "pre_detailed_assembly");
    const compression = formOf(filePath, "t1", "detailed_turn_compression");
    expect(captured.filter((entry) => entry.op === "compressDetailedTurn")).toEqual([]);
    expect(assembly).toMatchObject({ state: "ready" });
    expect(compression).toMatchObject({
      state: "ready",
      content: assembly?.content,
    });
    expect(compression?.metadata?.sizeDisposition).toBeUndefined();
  });

  it("composes pre_detailed_assembly from dialog only in User/Assistant sections", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = sdkFor(double, { guards: { detailedTurnCompression: { tinyTurnTokens: 1000 } } });
    const filePath = await newThread();

    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "read runtime state" } }),
      validEvent("assistant_thinking", { payload: { text: "planning the read" } }),
      validEvent("assistant_text", { payload: { text: "I will inspect it" } }),
      validEvent("tool_call", {
        payload: { toolCallId: "call-1", toolName: "read_file", arguments: { path: "state.txt" } },
      }),
      validEvent("tool_result", { payload: { toolCallId: "call-1", content: "state is ready", isError: false } }),
      validEvent("turn_end"),
    ]);
    await drain(sdk, filePath);

    const assembly = formOf(filePath, "t1", "pre_detailed_assembly")?.content ?? "";
    expect(assembly).toContain("User:\n");
    expect(assembly).toContain("read runtime state");
    expect(assembly).toContain("⏺ I will inspect it");
    expect(assembly).not.toContain("planning the read");
    expect(assembly).not.toContain("read_file");
    expect(assembly).not.toContain("state is ready");
    expect(assembly).not.toMatch(/\[1\]/);
  });

  it("item 1 writes deterministic derivations and enqueues detailed_turn_compression", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = sdkFor(double, { guards: { detailedTurnCompression: { tinyTurnTokens: 1 } } });
    const filePath = await newThread();

    await sendTurn(sdk, filePath, "two item flow", tokenText(120));
    const partial = await drain(sdk, filePath, { maxItems: 2 });
    expect(partial.ran).toContainEqual(
      expect.objectContaining({ workItemId: "w-t1-turn_derivation-v1", disposition: "done" }),
    );

    expect(formOf(filePath, "t1", "turn_rendering")).toMatchObject({ state: "ready" });
    expect(formOf(filePath, "t1", "pre_detailed_assembly")).toMatchObject({ state: "ready" });
    expect(formOf(filePath, "t1", "detailed_turn_compression")).toMatchObject({ state: "pending" });

    const db = openRaw(filePath);
    try {
      const queued = db
        .prepare(`SELECT kind, status FROM work_item WHERE work_item_id = 'w-t1-detailed_turn_compression-v1'`)
        .get() as { kind: string; status: string } | undefined;
      expect(queued).toMatchObject({ kind: "detailed_turn_compression", status: "queued" });
    } finally {
      db.close();
    }

    await drain(sdk, filePath, { maxItems: 1 });
    expect(formOf(filePath, "t1", "detailed_turn_compression")).toMatchObject({ state: "ready" });
  });

  it("renders structured turn text with message-kind markers in record order", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = sdkFor(double, { guards: { detailedTurnCompression: { tinyTurnTokens: 1000 } } });
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
    expect(rendering.indexOf("User prompt\n")).toBeLessThan(rendering.indexOf("Assistant response\n"));
    expect(rendering.indexOf("Assistant response\n")).toBeLessThan(
      rendering.indexOf("Tool call [outcome: succeeded]\n"),
    );
    expect(rendering).toContain("read_file");
    expect(rendering).toContain("state is ready");
  });

  it("passes concrete target tokens to compression and records size disposition", async () => {
    const double = createInferenceCallbacksDouble();
    const captured: Array<{ op: "compressDetailedTurn"; input: unknown }> = [];
    const output = tokenText(90);
    const callbacks: InferenceCallbacks = {
      smoothPrompt: (input) => double.smoothPrompt(input),
      summarizeToolResult: (input) => double.summarizeToolResult(input),
      compressDetailedTurn: async (input) => {
        captured.push({ op: "compressDetailedTurn", input: structuredClone(input) });
        return { ok: true, text: output };
      },
      summarizeChunkBrief: (input) => double.summarizeChunkBrief(input),
    };
    const sdk = sdkFor(callbacks);
    const filePath = await newThread();

    await sendTurn(sdk, filePath, "target ratios", tokenText(300));
    await drain(sdk, filePath);

    const call = captured.find((entry) => entry.op === "compressDetailedTurn")?.input as
      | {
          dialogueText: string;
          inputTokens: number;
          targetMinTokens: number;
          targetAimTokens: number;
          targetMaxTokens: number;
        }
      | undefined;
    expect(call).toBeDefined();
    if (call === undefined) return;
    expect(call.dialogueText).toContain("User:\n");
    expect(call.dialogueText).toContain("target ratios");
    expect(call.dialogueText).toContain("⏺ ");
    expect(call.dialogueText).not.toContain("[1] User prompt");
    expect(call.inputTokens).toBe(estimateTokens(call.dialogueText));
    expect(call.targetMinTokens).toBe(Math.max(1, Math.round(call.inputTokens * 0.35)));
    expect(call.targetAimTokens).toBe(Math.max(1, Math.round(call.inputTokens * 0.5)));
    expect(call.targetMaxTokens).toBe(Math.max(1, Math.round(call.inputTokens * 0.65)));
    expect(formOf(filePath, "t1", "detailed_turn_compression")).toMatchObject({
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
      guards: { detailedTurnCompression: { tinyTurnTokens: 1 } },
      lease: { durationMs: 200 },
    });
    const filePath = await newThread();

    await sendTurn(sdk, filePath, "target ratios", "assistant answer with enough content");
    await drain(sdk, filePath);

    const compression = formOf(filePath, "t1", "detailed_turn_compression");
    expect(compression).toMatchObject({
      state: "ready",
      metadata: {
        provenance: {
          prompt: "detailed-turn-compression-v3",
        },
      },
    });
    const rendered = host.log.at(-1);
    const promptText = rendered?.messages.map((message) => message.content).join("\n");
    expect(promptText).toContain("<instructions-for-summarizing>");
    expect(promptText).toContain("<content-for-summarizing>");
    expect(promptText).toContain("targetting approximately 20%-30%");

    const derivationLog = await sdk.logging.queryDerivationLog(
      { filePath },
      { subjectId: "t1", derivationType: "detailed_turn_compression" },
    );
    expect(derivationLog.ok).toBe(true);
    if (!derivationLog.ok) return;
    const succeeded = derivationLog.value.find((entry) => entry.eventKind === "inference_succeeded");
    expect(succeeded).toEqual(
      expect.objectContaining({
        eventKind: "inference_succeeded",
        payload: {
          provenance: {
            provider: expect.any(String),
            model: expect.any(String),
            prompt: "detailed-turn-compression-v3",
          },
          requestMessages: rendered?.messages,
          rawResponse: tokenText(120),
        },
      }),
    );
  });

  it("compression failure logs requestMessages on inference_failed", async () => {
    const log: ModelCallInput[] = [];
    const call: ModelCall = (input) => {
      log.push(structuredClone(input));
      return Promise.resolve({ ok: true, text: "   " });
    };
    const sdk = initLhc({
      mode: "manual",
      inference: { call },
      guards: { detailedTurnCompression: { tinyTurnTokens: 1 } },
      lease: { durationMs: 200 },
    });
    const filePath = await newThread();

    await sendTurn(sdk, filePath, "observable failure", tokenText(120));
    await drain(sdk, filePath);

    const derivationLog = await sdk.logging.queryDerivationLog(
      { filePath },
      { subjectId: "t1", derivationType: "detailed_turn_compression" },
    );
    expect(derivationLog.ok).toBe(true);
    if (!derivationLog.ok) return;
    const failed = derivationLog.value.find((entry) => entry.eventKind === "inference_failed");
    const compressionCall = log.at(-1);
    expect(failed).toEqual(
      expect.objectContaining({
        eventKind: "inference_failed",
        payload: {
          reason: "provider_failure: empty_output: model returned empty or whitespace-only text",
          requestMessages: compressionCall?.messages,
        },
      }),
    );
  });

  it("the first compression failure lands ready with the pre_detailed_assembly fallback", async () => {
    const double = createInferenceCallbacksDouble();
    double.failKind("detailed_turn_compression", 99, {
      reason: "provider_failure: empty_output: model returned empty or whitespace-only text",
    });
    const sdk = sdkFor(double, { guards: { detailedTurnCompression: { tinyTurnTokens: 1 } } });
    const filePath = await newThread();

    await sendTurn(sdk, filePath, "fallback compression", tokenText(120));
    const drained = await sdk.work.drain({ filePath });
    expect(drained.ok).toBe(true);
    if (!drained.ok) return;
    expect(drained.value.ran).toContainEqual(
      expect.objectContaining({
        workItemId: "w-t1-detailed_turn_compression-v1",
        disposition: "done",
      }),
    );

    const assembly = formOf(filePath, "t1", "pre_detailed_assembly");
    const compression = formOf(filePath, "t1", "detailed_turn_compression");
    expect(formOf(filePath, "t1", "turn_rendering")).toMatchObject({ state: "ready" });
    expect(assembly).toMatchObject({ state: "ready" });
    expect(compression).toMatchObject({
      state: "ready",
      content: assembly?.content,
      metadata: {
        fallbackFloor: "pre_detailed_assembly",
        fallbackUsed: true,
        inferenceAttempted: true,
        inferenceSucceeded: false,
        lastError: "provider_failure: empty_output: model returned empty or whitespace-only text",
      },
    });

    const derivationLog = await sdk.logging.queryDerivationLog(
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
    expect(failedEvents.at(-1)?.payload.reason).toContain("empty_output");
    expect(fallbackEvent?.payload).toMatchObject({
      fallbackFloor: "pre_detailed_assembly",
      reason: expect.stringContaining("empty_output"),
    });

    const chunks = readChunks(filePath);
    expect(chunks.members.some((member) => member.turnId === "t1")).toBe(true);

    const logs = await sdk.logging.query(
      { filePath },
      { derivationType: "detailed_turn_compression", subjectId: "t1", level: "warning" },
    );
    expect(logs.ok).toBe(true);
    if (!logs.ok) return;
    expect(logs.value).toEqual([
      expect.objectContaining({
        message: "turn compression fallback used",
        reason: "provider_failure: empty_output: model returned empty or whitespace-only text",
        floorUsed: "pre_detailed_assembly",
      }),
    ]);
  });
});
