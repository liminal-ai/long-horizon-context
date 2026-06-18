// Story 2 (Epic 02): message-level derivation — Flow 2. The three real
// handlers (prompt smoothing, tool-call summary, tool-result summary) through
// Story 1's drain, mechanical outcome stamping (TC-2.4's identical-text
// fixture is the architecture-risk proof that model text never drives the
// outcome), the hot-path locality assertion (TC-2.2: intake returns before
// any model call), and the AC-2.8 late-result repair with its
// control leg. No registerTestWorkHandlers here: every drain dispatches the
// production handlers registered by the messages domain at initLhc.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  countLiveItems,
  initLhc,
  deterministicText,
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
  threadWithToolRun,
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

function manualSdk(inferenceCallbacks: InferenceCallbacks): Lhc {
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

function liveCount(filePath: string): number {
  const db = openRaw(filePath);
  try {
    return countLiveItems(db);
  } finally {
    db.close();
  }
}

function formOf(filePath: string, subjectId: string, derivationType: string) {
  return readDerivedForms(filePath).find(
    (f) => f.subjectId === subjectId && f.derivationType === derivationType,
  );
}

describe("TC-2.1 / AC-2.1: prompt smoothing lands a ready form readable alongside the message", () => {
  it("intake a prompt, drain → smoothed form ready with the double's deterministic output", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = manualSdk(double);
    const filePath = await newThread();
    const text = "please smooth this prompt";
    await send(sdk, filePath, [validEvent("user_prompt", { payload: { text } })]);

    const report = await drain(sdk, filePath);
    expect(report.ran).toEqual([
      expect.objectContaining({
        workItemId: "w-m1-prompt_smoothing-v1",
        disposition: "done",
      }),
    ]);

    // Readable alongside the message through the production read surface
    // (02F-001): listMessages carries the stored form on the message record —
    // not a fixture read of derivation.
    const listed = await sdk.messages.listMessages({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const message = listed.value[0];
    expect(message?.blocks[0]?.content["text"]).toBe(text);
    expect(message?.derivations).toEqual([
      expect.objectContaining({
        subjectKind: "message",
        subjectId: "m1",
        derivationType: "smoothed_prompt",
        state: "ready",
        // The content is the double's pure function of the prompt text — the
        // production smoothPrompt input shape, nothing else mixed in.
        content: deterministicText("smoothPrompt", { text }, text),
        sourceVersion: 1,
      }),
    ]);

    // The raw row agrees with the surfaced read: stored state, not a
    // read-time derivation.
    const raw = formOf(filePath, "m1", "smoothed_prompt");
    expect(raw?.state).toBe("ready");
    expect(raw?.content).toBe(deterministicText("smoothPrompt", { text }, text));
  });
});

describe("TC-2.5 / AC-2.5: tool_call queues no summary", () => {
  it("the batch reports no queued item and no derivation row", async () => {
    const double = createInferenceCallbacksDouble();
    const captured = double.captureInputs();
    const sdk = manualSdk(double);
    const filePath = await newThread();

    const batch = await send(sdk, filePath, [validEvent("tool_call")]);
    expect(captured).toHaveLength(0);
    expect(batch.queuedWork).toEqual([]);

    const report = await drain(sdk, filePath);
    expect(report.ran).toEqual([]);
    expect(formOf(filePath, "m1", "tool_result_summary")).toBeUndefined();
  });
});

describe("TC-2.3 / AC-2.3: the result summary abbreviates; the full content stays byte-identical in the record", () => {
  it("a 300KB result drains to a bounded summary and reads back whole through the Epic 01 surface", async () => {
    const big = "result-bytes ".repeat(24000); // ~300KB
    const double = createInferenceCallbacksDouble();
    const sdk = manualSdk(double);
    const { filePath } = await threadWithToolRun(store, { resultContent: big });

    await drain(sdk, filePath);
    const summary = formOf(filePath, "m3", "tool_result_summary");
    expect(summary?.state).toBe("ready");
    expect(summary?.content).toBe(truncateForFallback(big));
    expect(summary?.metadata).toEqual({ outcome: "succeeded" });

    const listed = await sdk.messages.listMessages({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const resultMessage = listed.value.find((m) => m.kind === "tool_result");
    expect(resultMessage?.blocks[0]?.content["content"]).toBe(big);
  });
});

describe("TC-2.4 / AC-2.4 (architecture risk): outcome is stamped from the record, never from model text", () => {
  it("tool-result summaries preserve succeeded / failed outcome from metadata alone", async () => {
    const double = createInferenceCallbacksDouble();
    const constantText = "the tool output says nothing reliable about status";
    const callbacks: InferenceCallbacks = {
      smoothPrompt: (i) => double.smoothPrompt(i),
      summarizeToolResult: () => Promise.resolve({ ok: true, text: constantText }),
      composeTurnRendering: (i) => double.composeTurnRendering(i),
      compressSmoothTurn: (i) => double.compressSmoothTurn(i),
      summarizeChunkDetailed: (i) => double.summarizeChunkDetailed(i),
      summarizeChunkBrief: (i) => double.summarizeChunkBrief(i),
    };
    const sdk = manualSdk(callbacks);

    const ok = await threadWithToolRun(store);
    const errored = await threadWithToolRun(store, { isError: true });
    for (const { filePath } of [ok, errored]) await drain(sdk, filePath);

    const summaries = [ok, errored].map(({ filePath }) =>
      formOf(filePath, "m3", "tool_result_summary"),
    );
    expect(summaries.map((f) => f?.state)).toEqual(["ready", "ready"]);
    expect(summaries.map((f) => f?.content)).toEqual([constantText, constantText]);
    expect(summaries.map((f) => f?.metadata?.outcome)).toEqual(["succeeded", "failed"]);
  });
});

describe("TC-2.5 / AC-2.5: message-level input discipline — the message and its call-id pair only", () => {
  it("the captured tool-result summary input carries tool guidance and outcome", async () => {
    const double = createInferenceCallbacksDouble();
    const captured = double.captureInputs();
    const sdk = manualSdk(double);
    const { filePath } = await threadWithToolRun(store);

    await drain(sdk, filePath);
    const inputs = captured.filter((entry) => entry.op === "summarizeToolResult");
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.input).toEqual({
      toolName: "read_file",
      content: "contents of notes.txt",
      outcome: "succeeded",
      targetTokens: expect.any(Number),
      guidance: expect.stringContaining("paths"),
    });
  });
});

describe("TC-2.6 / AC-2.6: inference callback exhaustion lands the form failed; the message stays readable", () => {
  it("smoothing exhausts the retry budget → form failed with the inference callback reason; read-back unaffected", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = manualSdk(double);
    const filePath = await newThread();
    const text = "this prompt will never smooth";
    await send(sdk, filePath, [validEvent("user_prompt", { payload: { text } })]);

    double.failKind("prompt_smoothing", 99, {
      retryable: true,
      reason: "scripted exhaustion (smoothPrompt)",
    });
    const report = await drain(sdk, filePath);
    expect(report.ran).toEqual([
      expect.objectContaining({
        workItemId: "w-m1-prompt_smoothing-v1",
        disposition: "failed_terminal",
        attempts: 3,
        reason: "scripted exhaustion (smoothPrompt)",
      }),
    ]);

    const form = formOf(filePath, "m1", "smoothed_prompt");
    expect(form?.state).toBe("failed");
    expect(form?.reason).toBe("scripted exhaustion (smoothPrompt)");
    expect(form?.content).toBeUndefined();

    const listed = await sdk.messages.listMessages({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value).toHaveLength(1);
    expect(listed.value[0]?.blocks[0]?.content["text"]).toBe(text);
  });
});

describe("TC-2.7 / AC-2.7: kinds with no derivable form queue no work and carry no state rows", () => {
  it("assistant text, a runtime note, and assistant thinking: no items, no derivation rows, an empty drain", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = manualSdk(double);
    const filePath = await newThread();

    // assistant_thinking joins the no-derivable-form kinds (Fix 3.2 coverage):
    // like assistant text and runtime notes it queues no work and carries no
    // derivation state row.
    const batch = await send(sdk, filePath, [
      validEvent("assistant_text"),
      validEvent("runtime_note"),
      validEvent("assistant_thinking"),
    ]);
    expect(batch.queuedWork).toEqual([]);
    expect(liveCount(filePath)).toBe(0);

    const report = await drain(sdk, filePath);
    expect(report.ran).toEqual([]);
    expect(report.stoppedBecause).toBe("empty");
    expect(readDerivedForms(filePath)).toEqual([]);
  });
});

describe("TC-2.5 / AC-2.5: tool calls render as recorded and queue no summary", () => {
  it("tool calls create no work item or derivation row", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = manualSdk(double);
    const filePath = await newThread();

    const batch = await send(sdk, filePath, [
      validEvent("tool_call"),
      validEvent("tool_result"),
    ]);
    expect(batch.queuedWork.map((item) => item.kind)).toEqual(["tool_result_summary"]);

    await drain(sdk, filePath);
    expect(readDerivedForms(filePath).map((f) => f.derivationType)).toEqual([
      "tool_result_summary",
    ]);
    expect(liveCount(filePath)).toBe(0);
  });
});
