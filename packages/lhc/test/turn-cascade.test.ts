import type { SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  countLiveItems,
  estimateTokens,
  type InferenceCallbacks,
  initLhc,
  type Lhc,
  type MessageEventInput,
  queueDetail,
  type SdkConfig,
  threads,
} from "../src/index.js";
import { truncateForFallback } from "../src/shared-tech/tool-result-rendering.js";
import {
  createInferenceCallbacksDouble,
  openRaw,
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

async function newThread(): Promise<string> {
  const created = await threads.newThread({
    filePath: store.threadPath(),
    registryPath: store.registryPath,
  });
  if (!created.ok) throw new Error(created.error.reason);
  return created.value.filePath;
}

function sdkFor(inferenceCallbacks: InferenceCallbacks, overrides: Partial<SdkConfig> = {}): Lhc {
  return initLhc({
    inferenceCallbacks,
    mode: "manual",
    retry: { budget: 3, backoffBaseMs: 0, backoffCapMs: 0 },
    lease: { durationMs: 200 },
    ...overrides,
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

function formOf(filePath: string, subjectId: string, derivationType: string) {
  return readDerivedForms(filePath).find(
    (form) => form.subjectId === subjectId && form.derivationType === derivationType,
  );
}

// turn_rendering is deterministic (AC-6.3): the rendering is the joined part
// texts, stored as the turn_rendering derivation. The composition tests read
// it back here instead of capturing a model call.
function renderingContent(filePath: string): string {
  return readDerivedForms(filePath).find((form) => form.derivationType === "turn_rendering")?.content ?? "";
}

function execSql(filePath: string, sql: string, ...params: SQLInputValue[]): void {
  const db = openRaw(filePath);
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

function deleteWorkItem(filePath: string, workItemId: string): void {
  execSql(filePath, `DELETE FROM work_item WHERE work_item_id = ?`, workItemId);
}

describe("Story 3: turn construction recovery cascade", () => {
  it("uses ready derivations directly and writes no fallback log", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = sdkFor(double);
    const filePath = await newThread();

    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "ready prompt" } }),
      validEvent("assistant_text", { payload: { text: "answer" } }),
      validEvent("turn_end"),
    ]);
    await drain(sdk, filePath);

    const smoothed = formOf(filePath, "m1", "smoothed_prompt")?.content;
    // turn_rendering is deterministic; its first segment is the ready smoothed prompt.
    expect(renderingContent(filePath).split(" | ")[0]).toBe(smoothed);

    const logs = await sdk.logging.query({ filePath }, { reason: "not_ready" });
    expect(logs.ok).toBe(true);
    if (!logs.ok) return;
    expect(logs.value).toEqual([]);
  });

  it("falls pending derivations to deterministic floors when re-derivation does not complete", async () => {
    const double = createInferenceCallbacksDouble();
    double.failKind("smoothed_prompt", 1, { retryable: true, reason: "recovery unavailable" });
    const sdk = sdkFor(double);
    const filePath = await newThread();

    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "  pending    prompt because i asked  " } }),
      validEvent("assistant_text", { payload: { text: "answer" } }),
      validEvent("turn_end"),
    ]);
    deleteWorkItem(filePath, "w-m1-prompt_smoothing-v1");

    await drain(sdk, filePath);

    // The rendering falls back to the prompt floor (smoothed not ready), so its
    // first segment is the deterministic floor text.
    expect(renderingContent(filePath).split(" | ")[0]).toBe("pending prompt because I asked");
    expect(formOf(filePath, "m1", "smoothed_prompt")).toMatchObject({
      state: "ready",
      content: "pending prompt because I asked",
    });

    const logs = await sdk.logging.query({ filePath }, { derivationType: "smoothed_prompt" });
    expect(logs.ok).toBe(true);
    if (!logs.ok) return;
    expect(logs.value.map((entry) => [entry.subjectId, entry.reason, entry.floorUsed])).toEqual([
      ["m1", "not_ready", "pending prompt because I asked"],
    ]);
  });

  it("falls back to original prompt source when the deterministic floor is unavailable", async () => {
    const double = createInferenceCallbacksDouble();
    double.failKind("smoothed_prompt", 1, { retryable: true, reason: "recovery unavailable" });
    const sdk = sdkFor(double);
    const filePath = await newThread();
    const original = " \t\n  ";

    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: original } }),
      validEvent("assistant_text", { payload: { text: "answer" } }),
      validEvent("turn_end"),
    ]);
    deleteWorkItem(filePath, "w-m1-prompt_smoothing-v1");

    await drain(sdk, filePath);

    expect(renderingContent(filePath).split(" | ")[0]).toBe(original);
    expect(formOf(filePath, "m1", "smoothed_prompt")).toMatchObject({
      state: "ready",
      content: original,
    });
  });

  it("falls failed derivations through the same floor path when re-derivation does not complete", async () => {
    const double = createInferenceCallbacksDouble();
    double.failKind("smoothed_prompt", 1, { retryable: true, reason: "recovery unavailable" });
    const sdk = sdkFor(double);
    const filePath = await newThread();

    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "  failed    prompt because i asked  " } }),
      validEvent("assistant_text", { payload: { text: "answer" } }),
      validEvent("turn_end"),
    ]);
    deleteWorkItem(filePath, "w-m1-prompt_smoothing-v1");
    execSql(
      filePath,
      `UPDATE derivation SET state = 'failed', reason = 'terminal'
       WHERE subject_id = ? AND derivation_type = 'smoothed_prompt'`,
      "m1",
    );

    await drain(sdk, filePath);

    expect(renderingContent(filePath).split(" | ")[0]).toBe("failed prompt because I asked");
    expect(formOf(filePath, "m1", "smoothed_prompt")).toMatchObject({
      state: "ready",
      content: "failed prompt because I asked",
    });
  });

  it("re-derives a failed component outside the completion write and persists plain ready", async () => {
    let probeAcquired = false;
    let filePath = "";
    const double = createInferenceCallbacksDouble();
    const callbacks: InferenceCallbacks = {
      smoothPrompt: async (input) => {
        const probe = openRaw(filePath);
        try {
          probe.exec("BEGIN IMMEDIATE;");
          probeAcquired = true;
          probe.exec("ROLLBACK;");
        } finally {
          probe.close();
        }
        return { ok: true, text: `recovered:${input.text}` };
      },
      summarizeToolResult: (input) => double.summarizeToolResult(input),
      composeTurnRendering: (input) => double.composeTurnRendering(input),
      compressSmoothTurn: (input) => double.compressSmoothTurn(input),
      summarizeChunkDetailed: (input) => double.summarizeChunkDetailed(input),
      summarizeChunkBrief: (input) => double.summarizeChunkBrief(input),
    };
    const sdk = sdkFor(callbacks);
    filePath = await newThread();

    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "  recover    me  " } }),
      validEvent("assistant_text", { payload: { text: "answer" } }),
      validEvent("turn_end"),
    ]);
    deleteWorkItem(filePath, "w-m1-prompt_smoothing-v1");
    execSql(
      filePath,
      `UPDATE derivation SET state = 'failed', reason = 'terminal'
       WHERE subject_id = ? AND derivation_type = 'smoothed_prompt'`,
      "m1",
    );

    await drain(sdk, filePath);

    expect(probeAcquired).toBe(true);
    expect(formOf(filePath, "m1", "smoothed_prompt")).toMatchObject({
      state: "ready",
      content: "recovered:recover me",
    });
    expect(formOf(filePath, "m1", "smoothed_prompt")?.reason).toBeUndefined();
    const logs = await sdk.logging.query({ filePath }, { derivationType: "smoothed_prompt" });
    expect(logs.ok).toBe(true);
    if (!logs.ok) return;
    expect(logs.value).toEqual([]);
  });

  it("does not overwrite a ready row written before floor recovery persists", async () => {
    let filePath = "";
    let workerCompleted = false;
    const double = createInferenceCallbacksDouble();
    const callbacks: InferenceCallbacks = {
      smoothPrompt: async () => {
        execSql(
          filePath,
          `UPDATE derivation
           SET state = 'ready', content = ?, reason = NULL, derived_at = ?
           WHERE subject_id = ? AND derivation_type = 'smoothed_prompt'`,
          "real worker output",
          "2026-01-01T00:00:00.000Z",
          "m1",
        );
        workerCompleted = true;
        return { ok: false, retryable: true, reason: "recovery unavailable" };
      },
      summarizeToolResult: (input) => double.summarizeToolResult(input),
      composeTurnRendering: (input) => double.composeTurnRendering(input),
      compressSmoothTurn: (input) => double.compressSmoothTurn(input),
      summarizeChunkDetailed: (input) => double.summarizeChunkDetailed(input),
      summarizeChunkBrief: (input) => double.summarizeChunkBrief(input),
    };
    const sdk = sdkFor(callbacks);
    filePath = await newThread();

    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "  race    prompt because i asked  " } }),
      validEvent("assistant_text", { payload: { text: "answer" } }),
      validEvent("turn_end"),
    ]);
    deleteWorkItem(filePath, "w-m1-prompt_smoothing-v1");

    await drain(sdk, filePath);

    expect(workerCompleted).toBe(true);
    expect(renderingContent(filePath).split(" | ")[0]).toBe("race prompt because I asked");
    expect(formOf(filePath, "m1", "smoothed_prompt")).toMatchObject({
      state: "ready",
      content: "real worker output",
    });
  });

  it("renders assistant text, thinking, and runtime notes verbatim in record order", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = sdkFor(double);
    const filePath = await newThread();

    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "order check" } }),
      validEvent("assistant_text", { payload: { text: "first answer" } }),
      validEvent("assistant_thinking", { payload: { text: "thinking exactly" } }),
      validEvent("runtime_note", { payload: { text: "runtime changed exactly" } }),
      validEvent("assistant_text", { payload: { text: "second answer" } }),
      validEvent("turn_end"),
    ]);

    await drain(sdk, filePath);

    // turn_rendering is the parts' text joined in record order; thinking and
    // runtime notes render verbatim, in position, between the answer texts.
    const smoothed = formOf(filePath, "m1", "smoothed_prompt")?.content;
    expect(renderingContent(filePath)).toEqual(
      [smoothed, "first answer", "thinking exactly", "runtime changed exactly", "second answer"].join(" | "),
    );
  });

  it("uses and writes tool-result truncation floors, never raw full results", async () => {
    const double = createInferenceCallbacksDouble();
    double.failKind("tool_result_summary", 1, { retryable: true, reason: "recovery unavailable" });
    const sdk = sdkFor(double);
    const filePath = await newThread();
    const content = "tool-output ".repeat(100);

    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "summarize tool" } }),
      validEvent("tool_call", {
        payload: { toolCallId: "call", toolName: "read_file", arguments: { path: "large.txt" } },
      }),
      validEvent("tool_result", { payload: { toolCallId: "call", content, isError: false } }),
      validEvent("turn_end"),
    ]);
    deleteWorkItem(filePath, "w-m3-tool_result_summary-v1");

    await drain(sdk, filePath);

    const floor = truncateForFallback(content);
    // The rendering carries the truncated tool-result floor, never the full result.
    expect(renderingContent(filePath)).toContain(floor);
    expect(renderingContent(filePath)).not.toContain(content);
    expect(formOf(filePath, "m3", "tool_result_summary")).toMatchObject({
      state: "ready",
      content: floor,
    });
  });

  it("recovers over-large failed tool-result summaries with deterministic truncation and no model call", async () => {
    const double = createInferenceCallbacksDouble();
    const captured = double.captureInputs();
    const sdk = sdkFor(double);
    const filePath = await newThread();
    const content = "large-result-token ".repeat(6000);

    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "summarize the large result" } }),
      validEvent("tool_call", {
        payload: { toolCallId: "call", toolName: "read_file", arguments: { path: "huge.log" } },
      }),
      validEvent("tool_result", { payload: { toolCallId: "call", content, isError: false } }),
      validEvent("turn_end"),
    ]);
    execSql(
      filePath,
      `UPDATE derivation
       SET state = 'failed', content = NULL, reason = 'scripted failure'
       WHERE subject_kind = 'message'
         AND subject_id = 'm3'
         AND derivation_type = 'tool_result_summary'`,
    );

    await drain(sdk, filePath);

    const floor = truncateForFallback(content);
    expect(captured.filter((entry) => entry.op === "summarizeToolResult")).toEqual([]);
    expect(formOf(filePath, "m3", "tool_result_summary")).toMatchObject({
      state: "ready",
      content: floor,
      metadata: { outcome: "succeeded" },
    });
  });

  it("recovers in-threshold tool-result summaries with paired tool guidance and tier target", async () => {
    const double = createInferenceCallbacksDouble();
    const captured = double.captureInputs();
    const sdk = sdkFor(double);
    const filePath = await newThread();
    const content = "search-hit ".repeat(80);
    const tokens = estimateTokens(content);

    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "summarize search output" } }),
      validEvent("tool_call", {
        payload: { toolCallId: "call", toolName: "grep", arguments: { pattern: "TODO" } },
      }),
      validEvent("tool_result", { payload: { toolCallId: "call", content, isError: true } }),
      validEvent("turn_end"),
    ]);
    deleteWorkItem(filePath, "w-m3-tool_result_summary-v1");

    await drain(sdk, filePath);

    const calls = captured.filter((entry) => entry.op === "summarizeToolResult");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toMatchObject({
      toolName: "grep",
      content,
      outcome: "failed",
      targetTokens: Math.ceil(tokens * 0.15),
      guidance: expect.stringContaining("line numbers"),
    });
    expect(formOf(filePath, "m3", "tool_result_summary")).toMatchObject({
      state: "ready",
      metadata: { outcome: "failed" },
    });
  });

  it("recovers over-cap prompts with deterministic cleaned text and no smoothing model call", async () => {
    const double = createInferenceCallbacksDouble();
    const captured = double.captureInputs();
    const sdk = sdkFor(double, { smoothing: { maxInferenceTokens: 1 } });
    const filePath = await newThread();

    await send(sdk, filePath, [
      validEvent("user_prompt", {
        payload: { text: "  please    fix this because i asked  " },
      }),
      validEvent("assistant_text", { payload: { text: "answer" } }),
      validEvent("turn_end"),
    ]);
    deleteWorkItem(filePath, "w-m1-prompt_smoothing-v1");

    await drain(sdk, filePath);

    expect(captured.filter((entry) => entry.op === "smoothPrompt")).toEqual([]);
    expect(formOf(filePath, "m1", "smoothed_prompt")).toMatchObject({
      state: "ready",
      content: "please fix this because I asked",
    });
  });

  it("logs fallback when a message derivation row is absent", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = sdkFor(double);
    const filePath = await newThread();

    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "summarize the missing row" } }),
      validEvent("tool_call", {
        payload: { toolCallId: "call", toolName: "read_file", arguments: { path: "missing.txt" } },
      }),
      validEvent("tool_result", {
        payload: { toolCallId: "call", content: "rowless output", isError: false },
      }),
      validEvent("turn_end"),
    ]);
    deleteWorkItem(filePath, "w-m3-tool_result_summary-v1");
    execSql(
      filePath,
      `DELETE FROM derivation
       WHERE subject_kind = 'message'
         AND subject_id = 'm3'
         AND derivation_type = 'tool_result_summary'`,
    );

    await drain(sdk, filePath);

    const queried = await sdk.logging.query({ filePath }, { derivationType: "tool_result_summary" });
    expect(queried.ok).toBe(true);
    if (!queried.ok) return;
    expect(queried.value).toEqual([
      expect.objectContaining({
        level: "warning",
        message: "derivation fallback used",
        derivationType: "tool_result_summary",
        subjectId: "m3",
        reason: "not_ready",
        floorUsed: "rowless output",
      }),
    ]);
    expect(formOf(filePath, "m3", "tool_result_summary")).toBeUndefined();
  });

  it("constructs a turn with every component present when multiple derivations are not ready", async () => {
    const double = createInferenceCallbacksDouble();
    double.failKind("smoothed_prompt", 1, { retryable: true, reason: "recovery unavailable" });
    double.failKind("tool_result_summary", 1, {
      retryable: true,
      reason: "recovery unavailable",
    });
    const sdk = sdkFor(double);
    const filePath = await newThread();

    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "  multi    fallback because i asked  " } }),
      validEvent("tool_call", {
        payload: { toolCallId: "call", toolName: "read_file", arguments: { path: "multi.txt" } },
      }),
      validEvent("tool_result", {
        payload: { toolCallId: "call", content: "tool-output", isError: false },
      }),
      validEvent("assistant_text", { payload: { text: "answer after tool" } }),
      validEvent("turn_end"),
    ]);
    deleteWorkItem(filePath, "w-m1-prompt_smoothing-v1");
    deleteWorkItem(filePath, "w-m3-tool_result_summary-v1");

    await drain(sdk, filePath);

    // The rendering carries the prompt floor, the tool run (call args + result
    // floor), and the assistant text — verifying the composed content without
    // an inference-callback capture (turn_rendering is deterministic, AC-6.3).
    const rendering = renderingContent(filePath);
    expect(rendering).toContain("multi fallback because I asked");
    expect(rendering).toContain('read_file({"path":"multi.txt"})');
    expect(rendering).toContain("tool-output");
    expect(rendering).toContain("answer after tool");
    expect(formOf(filePath, "m1", "smoothed_prompt")).toMatchObject({
      state: "ready",
      content: "multi fallback because I asked",
    });
    expect(formOf(filePath, "m3", "tool_result_summary")).toMatchObject({
      state: "ready",
      content: "tool-output",
    });
  });

  it("leaves derivation rows untouched when live work exists but still renders a floor", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = sdkFor(double);
    const filePath = await newThread();

    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "  live    work because i asked  " } }),
      validEvent("assistant_text", { payload: { text: "answer" } }),
      validEvent("turn_end"),
    ]);
    deleteWorkItem(filePath, "w-m1-prompt_smoothing-v1");
    execSql(
      filePath,
      `INSERT INTO work_item (work_item_id, owner, kind, source_ref, status, queued_at, payload)
       VALUES (?, 'messages', 'prompt_smoothing', ?, 'queued', ?, ?)`,
      "w-m1-prompt_smoothing-v1-live",
      JSON.stringify({ messageId: "m1" }),
      "2026-01-01T00:00:00.000Z",
      JSON.stringify({
        sourceVersion: 1,
        derivations: [{ subjectKind: "message", subjectId: "m1", derivationType: "smoothed_prompt" }],
      }),
    );

    await drain(sdk, filePath, { maxItems: 1 });

    expect(renderingContent(filePath).split(" | ")[0]).toBe("live work because I asked");
    expect(formOf(filePath, "m1", "smoothed_prompt")).toMatchObject({ state: "pending" });

    const db = openRaw(filePath);
    try {
      expect(countLiveItems(db)).toBe(1);
      expect(queueDetail(db)[0]?.workItemId).toBe("w-m1-prompt_smoothing-v1-live");
    } finally {
      db.close();
    }
  });
});
