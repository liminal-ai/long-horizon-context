// Story 2 (Epic 02): message-level derivation — Flow 2. The three real
// handlers (prompt smoothing, tool-call summary, tool-result summary) through
// Story 1's drain, mechanical outcome stamping (TC-2.4's identical-text
// fixture is the architecture-risk proof that provider text never drives the
// outcome), the hot-path locality assertion (TC-2.2: intake returns before
// any provider call), and the AC-2.8 late-result repair with its
// control leg. No registerTestWorkHandlers here: every drain dispatches the
// production handlers registered by the messages domain at createSdk.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  countLiveItems,
  createSdk,
  deterministicText,
  threads,
  type BatchResult,
  type DerivationProvider,
  type DrainReport,
  type Lhc,
  type MessageEventInput,
} from "../src/index.js";
import {
  createProviderDouble,
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

function manualSdk(provider: DerivationProvider): Lhc {
  return createSdk({
    provider,
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

function formOf(filePath: string, subjectId: string, form: string) {
  return readDerivedForms(filePath).find(
    (f) => f.subjectId === subjectId && f.form === form,
  );
}

describe("TC-2.1 / AC-2.1: prompt smoothing lands a ready form readable alongside the message", () => {
  it("intake a prompt, drain → smoothed form ready with the double's deterministic output", async () => {
    const double = createProviderDouble();
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
    // not a fixture read of derived_form.
    const listed = await sdk.messages.listMessages({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const message = listed.value[0];
    expect(message?.blocks[0]?.content["text"]).toBe(text);
    expect(message?.forms).toEqual([
      expect.objectContaining({
        subjectKind: "message",
        subjectId: "m1",
        form: "smoothed_prompt",
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

describe("TC-2.2 / AC-2.2: tool_call queues its summary additively; intake returns before any handler runs", () => {
  it("the batch reports the queued item with the capture log still empty; the drained summary names tool and args", async () => {
    const double = createProviderDouble();
    const captured = double.captureInputs();
    const sdk = manualSdk(double);
    const filePath = await newThread();

    const batch = await send(sdk, filePath, [validEvent("tool_call")]);
    // Hot-path NFR made testable: the intake result is in hand and the
    // provider has never been called — queueing and derivation are decoupled
    // in time, not just in code.
    expect(captured).toHaveLength(0);
    expect(batch.queuedWork).toEqual([
      {
        workItemId: "w-m1-tool_call_summary-v1",
        owner: "messages",
        kind: "tool_call_summary",
        sourceRef: { messageId: "m1" },
      },
    ]);

    const report = await drain(sdk, filePath);
    expect(report.ran).toEqual([
      expect.objectContaining({
        workItemId: "w-m1-tool_call_summary-v1",
        disposition: "done",
      }),
    ]);
    const form = formOf(filePath, "m1", "tool_call_summary");
    expect(form?.state).toBe("ready");
    // Names the tool and describes its arguments (fixture default payload).
    expect(form?.content).toContain("read_file");
    expect(form?.content).toContain('{"path":"notes.txt"}');
    // No paired result intaken: outcome stamped unknown, in metadata.
    expect(form?.metadata).toEqual({ outcome: "unknown" });
  });
});

describe("TC-2.3 / AC-2.3: the result summary abbreviates; the full content stays byte-identical in the record", () => {
  it("a 300KB result drains to a bounded summary and reads back whole through the Epic 01 surface", async () => {
    const big = "result-bytes ".repeat(24000); // ~300KB
    const double = createProviderDouble();
    const sdk = manualSdk(double);
    const { filePath } = await threadWithToolRun(store, { resultContent: big });

    await drain(sdk, filePath);
    const summary = formOf(filePath, "m3", "tool_result_summary");
    expect(summary?.state).toBe("ready");
    expect(summary?.content?.startsWith("toolresult(")).toBe(true);
    // Summarized means abbreviated: marker + digest + 40-char prefix.
    expect(summary?.content?.length ?? 0).toBeLessThan(100);
    expect(summary?.metadata).toEqual({ outcome: "succeeded" });

    const listed = await sdk.messages.listMessages({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const resultMessage = listed.value.find((m) => m.kind === "tool_result");
    expect(resultMessage?.blocks[0]?.content["content"]).toBe(big);
  });
});

describe("TC-2.4 / AC-2.4 (architecture risk): outcome is stamped from the record, never from provider text", () => {
  it("three variants with identical provider text land succeeded / failed / unknown from metadata alone", async () => {
    // The identical-text fixture: summarizeToolCall returns one constant
    // string no matter the input, at the same production seam. If any code
    // path inferred outcome from text, all three variants would agree.
    const constantText = "the tool was invoked with some arguments";
    const double = createProviderDouble();
    const provider: DerivationProvider = {
      smoothPrompt: (i) => double.smoothPrompt(i),
      summarizeToolCall: () => Promise.resolve({ ok: true, text: constantText }),
      summarizeToolResult: (i) => double.summarizeToolResult(i),
      composeTurnRendering: (i) => double.composeTurnRendering(i),
      projectLowerBand: (i) => double.projectLowerBand(i),
      summarizeChunkDetailed: (i) => double.summarizeChunkDetailed(i),
      summarizeChunkBrief: (i) => double.summarizeChunkBrief(i),
    };
    const sdk = manualSdk(provider);

    const ok = await threadWithToolRun(store);
    const errored = await threadWithToolRun(store, { isError: true });
    const missing = await threadWithToolRun(store, { missingResult: true });
    for (const { filePath } of [ok, errored, missing]) await drain(sdk, filePath);

    const summaries = [ok, errored, missing].map(({ filePath }) =>
      formOf(filePath, "m2", "tool_call_summary"),
    );
    expect(summaries.map((f) => f?.state)).toEqual(["ready", "ready", "ready"]);
    // Text identical across all three…
    expect(summaries.map((f) => f?.content)).toEqual([
      constantText,
      constantText,
      constantText,
    ]);
    // …while the outcome differs, read from metadata — machine-readable
    // apart from the provider's prose, which mentions no outcome at all.
    expect(summaries.map((f) => f?.metadata?.outcome)).toEqual([
      "succeeded",
      "failed",
      "unknown",
    ]);
  });
});

describe("TC-2.5 / AC-2.5: message-level input discipline — the message and its call-id pair only", () => {
  it("the captured tool-call summary input is exactly the call plus its paired result", async () => {
    const double = createProviderDouble();
    const captured = double.captureInputs();
    const sdk = manualSdk(double);
    const { filePath } = await threadWithToolRun(store);

    await drain(sdk, filePath);
    const inputs = captured.filter((entry) => entry.op === "summarizeToolCall");
    expect(inputs).toHaveLength(1);
    // Exact equality: no turn ids, no membership, no chunk context — the
    // production seam receives the pair and nothing else.
    expect(inputs[0]?.input).toEqual({
      toolName: "read_file",
      argsJson: '{"path":"notes.txt"}',
      pairedResult: { content: "contents of notes.txt", isError: false },
    });
  });
});

describe("TC-2.6 / AC-2.6: provider exhaustion lands the form failed; the message stays readable", () => {
  it("smoothing exhausts the retry budget → form failed with the provider's reason; read-back unaffected", async () => {
    const double = createProviderDouble();
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
  it("assistant text and a runtime note: no items, no derivation rows, an empty drain", async () => {
    const double = createProviderDouble();
    const sdk = manualSdk(double);
    const filePath = await newThread();

    const batch = await send(sdk, filePath, [
      validEvent("assistant_text"),
      validEvent("runtime_note"),
    ]);
    expect(batch.queuedWork).toEqual([]);
    expect(liveCount(filePath)).toBe(0);

    const report = await drain(sdk, filePath);
    expect(report.ran).toEqual([]);
    expect(report.stoppedBecause).toBe("empty");
    expect(readDerivedForms(filePath)).toEqual([]);
  });
});

describe("TC-2.8 / AC-2.8 (architecture risk): a late result re-queues an unknown-outcome summary at intake", () => {
  it("split batches: the result's intake re-queues the summary; the repair is a real queue round-trip", async () => {
    const double = createProviderDouble();
    const sdk = manualSdk(double);
    const filePath = await newThread();

    // Batch 1: the call alone. Its summary derives with no pair in sight.
    await send(sdk, filePath, [validEvent("tool_call")]);
    await drain(sdk, filePath);
    const before = formOf(filePath, "m1", "tool_call_summary");
    expect(before?.state).toBe("ready");
    expect(before?.metadata).toEqual({ outcome: "unknown" });
    expect(before?.sourceVersion).toBe(1);

    // Batch 2: the paired result lands later. The intake result itself
    // reports the re-queued summary — repair is intake-time and visible,
    // not a read-time join.
    const batch = await send(sdk, filePath, [validEvent("tool_result")]);
    expect(batch.queuedWork).toContainEqual({
      workItemId: "w-m2-tool_result_summary-v1",
      owner: "messages",
      kind: "tool_result_summary",
      sourceRef: { messageId: "m2" },
    });
    expect(batch.queuedWork).toContainEqual({
      workItemId: "w-m1-tool_call_summary-v2",
      owner: "messages",
      kind: "tool_call_summary",
      sourceRef: { messageId: "m1" },
    });
    // The clear half of clear-and-regenerate rode the batch transaction.
    const cleared = formOf(filePath, "m1", "tool_call_summary");
    expect(cleared?.state).toBe("pending");
    expect(cleared?.sourceVersion).toBe(2);

    const report = await drain(sdk, filePath);
    expect(report.ran.map((entry) => [entry.workItemId, entry.disposition])).toEqual([
      ["w-m2-tool_result_summary-v1", "done"],
      ["w-m1-tool_call_summary-v2", "done"],
    ]);

    // One summary form, outcome repaired, source version advanced — the
    // proof the artifact was re-derived through the queue, not patched.
    const summaries = readDerivedForms(filePath).filter(
      (f) => f.form === "tool_call_summary",
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      subjectId: "m1",
      state: "ready",
      sourceVersion: 2,
      metadata: { outcome: "succeeded" },
    });
    expect(liveCount(filePath)).toBe(0);
  });

  it("control: call and result in one batch never trigger the re-queue; the summary runs exactly once", async () => {
    const double = createProviderDouble();
    const captured = double.captureInputs();
    const sdk = manualSdk(double);
    const filePath = await newThread();

    const batch = await send(sdk, filePath, [
      validEvent("tool_call"),
      validEvent("tool_result"),
    ]);
    const summaryItems = batch.queuedWork.filter((item) => item.kind === "tool_call_summary");
    expect(summaryItems.map((item) => item.workItemId)).toEqual([
      "w-m1-tool_call_summary-v1",
    ]);

    await drain(sdk, filePath);
    // The capture log proves the summary ran once — after both halves of its
    // pair landed, so it saw the result and stamped succeeded directly.
    expect(captured.filter((entry) => entry.op === "summarizeToolCall")).toHaveLength(1);
    const form = formOf(filePath, "m1", "tool_call_summary");
    expect(form).toMatchObject({
      state: "ready",
      sourceVersion: 1,
      metadata: { outcome: "succeeded" },
    });
    expect(liveCount(filePath)).toBe(0);
  });
});
