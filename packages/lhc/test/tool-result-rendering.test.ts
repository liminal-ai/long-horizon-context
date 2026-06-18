import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  countLiveItems,
  initLhc,
  threads,
  type BatchResult,
  type InferenceCallbacks,
  type DrainReport,
  type Lhc,
  type MessageEventInput,
} from "../src/index.js";
import { truncateForFallback } from "../src/shared-tech/tool-result-rendering.js";
import {
  createInferenceCallbacksDouble,
  openRaw,
  readDerivedForms,
  tempStore,
  validEvent,
  type TempStore,
} from "./fixtures/index.js";

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
});

async function newThread(): Promise<string> {
  const created = await threads.newThread({
    filePath: store.threadPath(),
    registryPath: store.registryPath,
  });
  if (!created.ok) throw new Error(`thread creation failed: ${created.error.reason}`);
  return created.value.filePath;
}

function sdkFor(inferenceCallbacks: InferenceCallbacks): Lhc {
  return initLhc({
    inferenceCallbacks,
    mode: "manual",
    retry: { budget: 3, backoffBaseMs: 0, backoffCapMs: 0 },
    lease: { durationMs: 200 },
  });
}

async function send(
  sdk: Lhc,
  filePath: string,
  batch: readonly MessageEventInput[],
): Promise<BatchResult> {
  const result = await sdk.intakeStream.messageEvents({ filePath }, batch);
  if (!result.ok) throw new Error(`batch failed: ${result.error.reason}`);
  return result.value;
}

async function drain(sdk: Lhc, filePath: string): Promise<DrainReport> {
  const result = await sdk.work.drain({ filePath });
  if (!result.ok) throw new Error(`drain failed: ${result.error.reason}`);
  return result.value;
}

function formOf(filePath: string, subjectId: string, derivationType: string) {
  return readDerivedForms(filePath).find(
    (f) => f.subjectId === subjectId && f.derivationType === derivationType,
  );
}

function liveCount(filePath: string): number {
  const db = openRaw(filePath);
  try {
    return countLiveItems(db);
  } finally {
    db.close();
  }
}

describe("Story 2: tool-result rendering", () => {
  it("large tool results satisfy tool_result_summary by deterministic truncation with no work item", async () => {
    const double = createInferenceCallbacksDouble();
    const captured = double.captureInputs();
    const sdk = sdkFor(double);
    const filePath = await newThread();
    const content = "result-token ".repeat(6000);

    const batch = await send(sdk, filePath, [
      validEvent("tool_call", {
        payload: { toolCallId: "large", toolName: "read_file", arguments: { path: "huge.log" } },
      }),
      validEvent("tool_result", {
        payload: { toolCallId: "large", content, isError: false },
      }),
    ]);

    expect(batch.queuedWork).toEqual([]);
    expect(captured).toEqual([]);
    expect(liveCount(filePath)).toBe(0);
    expect(formOf(filePath, "m1", "tool_call_summary")).toBeUndefined();
    expect(formOf(filePath, "m2", "tool_result_summary")).toMatchObject({
      state: "ready",
      content: truncateForFallback(content),
      metadata: { outcome: "succeeded" },
    });

    const listed = await sdk.messages.listMessages({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.find((m) => m.messageId === "m2")?.blocks[0]?.content["content"]).toBe(
      content,
    );
  });

  it("in-threshold tool-result summaries run through queued inference with tier target and guidance", async () => {
    const double = createInferenceCallbacksDouble();
    const captured = double.captureInputs();
    const sdk = sdkFor(double);
    const filePath = await newThread();

    const small = "small-result ".repeat(100);
    const mid = "mid-result ".repeat(1500);
    const batch = await send(sdk, filePath, [
      validEvent("tool_call", {
        payload: { toolCallId: "small", toolName: "read_file", arguments: { path: "a.txt" } },
      }),
      validEvent("tool_result", {
        payload: { toolCallId: "small", content: small, isError: false },
      }),
      validEvent("tool_call", {
        payload: { toolCallId: "mid", toolName: "grep", arguments: { pattern: "TODO" } },
      }),
      validEvent("tool_result", {
        payload: { toolCallId: "mid", content: mid, isError: true },
      }),
    ]);

    expect(batch.queuedWork.map((item) => item.workItemId)).toEqual([
      "w-m2-tool_result_summary-v1",
      "w-m4-tool_result_summary-v1",
    ]);
    const report = await drain(sdk, filePath);
    expect(report.ran.map((entry) => entry.disposition)).toEqual(["done", "done"]);

    const calls = captured.filter((entry) => entry.op === "summarizeToolResult");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.input).toMatchObject({
      toolName: "read_file",
      content: small,
      outcome: "succeeded",
      guidance: expect.stringContaining("paths"),
    });
    expect(calls[1]?.input).toMatchObject({
      toolName: "grep",
      content: mid,
      outcome: "failed",
      guidance: expect.stringContaining("line numbers"),
    });
    expect((calls[1]?.input as { targetTokens?: number }).targetTokens).toBeGreaterThan(
      (calls[0]?.input as { targetTokens?: number }).targetTokens ?? 0,
    );
    expect(formOf(filePath, "m4", "tool_result_summary")?.metadata).toEqual({
      outcome: "failed",
    });
  });

  it("tool-call arguments render as recorded with no tool_call_summary derivation", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = sdkFor(double);
    const filePath = await newThread();

    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "run it" } }),
      validEvent("tool_call", {
        payload: { toolCallId: "call", toolName: "exec", arguments: { cmd: "pnpm test" } },
      }),
      validEvent("tool_result", {
        payload: { toolCallId: "call", content: "passed", isError: false },
      }),
      validEvent("turn_end"),
    ]);
    await drain(sdk, filePath);

    const derivationTypes = readDerivedForms(filePath).map((f) => f.derivationType);
    expect(derivationTypes).not.toContain("tool_call_summary");
    const rendering = readDerivedForms(filePath).find((f) => f.derivationType === "turn_rendering");
    expect(rendering?.content).toContain('exec({"cmd":"pnpm test"})');
  });

  it("tail tool-call rendering preserves long recorded arguments without truncation", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = sdkFor(double);
    const filePath = await newThread();
    const cmd = "x".repeat(240);
    const args = JSON.stringify({ cmd });

    await send(sdk, filePath, [
      validEvent("tool_call", {
        payload: { toolCallId: "long-call", toolName: "exec", arguments: { cmd } },
      }),
    ]);

    const pulled = await sdk.threadView.pull({ filePath });
    expect(pulled.ok).toBe(true);
    if (!pulled.ok) return;
    const rendered = pulled.value.messages.map((message) => message.content).join("\n");
    expect(rendered).toContain(`[tool call · exec] ${args}`);
    expect(rendered).not.toContain("truncated");
    expect(formOf(filePath, "m1", "tool_call_summary")).toBeUndefined();
  });

  it("terminal in-threshold summary failure lands failed with reason while the source result remains intact", async () => {
    const double = createInferenceCallbacksDouble();
    double.failKind("tool_result_summary", 99, {
      retryable: true,
      reason: "scripted tool summary failure",
    });
    const sdk = sdkFor(double);
    const filePath = await newThread();

    await send(sdk, filePath, [
      validEvent("tool_call", {
        payload: { toolCallId: "fail", toolName: "read_file", arguments: { path: "x" } },
      }),
      validEvent("tool_result", {
        payload: { toolCallId: "fail", content: "short failure target", isError: true },
      }),
    ]);
    const report = await drain(sdk, filePath);
    expect(report.ran).toEqual([
      expect.objectContaining({
        workItemId: "w-m2-tool_result_summary-v1",
        disposition: "failed_terminal",
        reason: "scripted tool summary failure",
      }),
    ]);
    expect(formOf(filePath, "m2", "tool_result_summary")).toMatchObject({
      state: "failed",
      reason: "scripted tool summary failure",
    });

    const listed = await sdk.messages.listMessages({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.find((m) => m.messageId === "m2")?.blocks[0]?.content["content"]).toBe(
      "short failure target",
    );
  });
});
