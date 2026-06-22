import type { SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type DrainReport,
  estimateTokens,
  type InferenceCallbacks,
  type InferenceResult,
  initLhc,
  type Lhc,
  type MessageEventInput,
  queueDetail,
  type SdkConfig,
  threads,
} from "../src/index.js";
import {
  createInferenceCallbacksDouble,
  openRaw,
  readDerivedForms,
  setFormState,
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

const SELF_CHUNK = { targetProjectedTokens: 1, maxProjectedTokens: 1 };
const FIXED_PROJECTION = "fixed projected turn text";

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
    retry: { budget: 3, backoffBaseMs: 1000, backoffCapMs: 1000 },
    lease: { durationMs: 200 },
    guards: { smoothTurnCompression: { tinyTurnTokens: 1 } },
    chunkPolicy: SELF_CHUNK,
    ...overrides,
  });
}

function withScriptedProjection(base: InferenceCallbacks, projection = FIXED_PROJECTION): InferenceCallbacks {
  return {
    smoothPrompt: (input) => base.smoothPrompt(input),
    summarizeToolResult: (input) => base.summarizeToolResult(input),
    composeTurnRendering: (input) => base.composeTurnRendering(input),
    compressSmoothTurn: (): Promise<InferenceResult> => Promise.resolve({ ok: true, text: projection }),
    summarizeChunkDetailed: (input) => base.summarizeChunkDetailed(input),
    summarizeChunkBrief: (input) => base.summarizeChunkBrief(input),
  };
}

async function send(sdk: Lhc, filePath: string, batch: readonly MessageEventInput[]): Promise<void> {
  const result = await sdk.intakeStream.messageEvents({ filePath }, batch);
  if (!result.ok) throw new Error(result.error.reason);
}

async function drain(sdk: Lhc, filePath: string, opts?: { maxItems?: number }): Promise<DrainReport> {
  const result = await sdk.work.drain({ filePath }, opts);
  if (!result.ok) throw new Error(result.error.reason);
  return result.value;
}

async function sendPromptTurn(sdk: Lhc, filePath: string, prompt: string, answer: string): Promise<void> {
  await send(sdk, filePath, [
    validEvent("user_prompt", { payload: { text: prompt } }),
    validEvent("assistant_text", { payload: { text: answer } }),
    validEvent("turn_end"),
  ]);
}

async function sendToolTurn(sdk: Lhc, filePath: string): Promise<void> {
  await send(sdk, filePath, [
    validEvent("user_prompt", { payload: { text: "read the project plan" } }),
    validEvent("tool_call", {
      payload: { toolCallId: "tool-a", toolName: "read_file", arguments: { path: "docs/plan.md" } },
    }),
    validEvent("tool_result", { payload: { toolCallId: "tool-a", content: "plan contents", isError: false } }),
    validEvent("turn_end"),
  ]);
}

function execSql(filePath: string, sql: string, ...params: SQLInputValue[]): void {
  const db = openRaw(filePath);
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

function formOf(filePath: string, subjectId: string, derivationType: string) {
  return readDerivedForms(filePath).find(
    (form) => form.subjectId === subjectId && form.derivationType === derivationType,
  );
}

function liveQueue(filePath: string) {
  const db = openRaw(filePath);
  try {
    return queueDetail(db);
  } finally {
    db.close();
  }
}

function enqueueChunkSummaryWork(
  filePath: string,
  workItemId: string,
  chunkId: string,
  derivationType: "chunk_summary_detailed" | "chunk_summary_brief",
): void {
  execSql(
    filePath,
    `INSERT INTO work_item (work_item_id, owner, kind, source_ref, status, queued_at, payload)
     VALUES (?, 'turns', ?, ?, 'queued', '2026-06-22T00:00:00.000Z', ?)`,
    workItemId,
    derivationType,
    JSON.stringify({ chunkId }),
    JSON.stringify({
      sourceVersion: 1,
      derivations: [{ subjectKind: "chunk", subjectId: chunkId, derivationType }],
    }),
  );
}

function resetChunkSummary(
  filePath: string,
  chunkId: string,
  derivationType: "chunk_summary_detailed" | "chunk_summary_brief",
): void {
  setFormState(filePath, { subjectKind: "chunk", subjectId: chunkId, derivationType }, { state: "pending" });
}

function setCompressionState(
  filePath: string,
  turnId: string,
  update: { state: "pending" | "failed" | "blocked"; reason?: string; content?: string },
): void {
  setFormState(filePath, { subjectKind: "turn", subjectId: turnId, derivationType: "smooth_turn_compression" }, update);
}

describe("Story 4: chunk_summary_detailed concatenation format", () => {
  it("derives marker-separated member text in order without a detailed model call", async () => {
    const double = createInferenceCallbacksDouble();
    const captured = double.captureInputs();
    const projectedTokens = estimateTokens(FIXED_PROJECTION);
    const sdk = sdkFor(withScriptedProjection(double), {
      chunkPolicy: { targetProjectedTokens: 4 * projectedTokens, maxProjectedTokens: 999999 },
    });
    const filePath = await newThread();

    await sendPromptTurn(sdk, filePath, "first prompt", "first answer");
    await sendPromptTurn(sdk, filePath, "second prompt", "second answer");
    await sendPromptTurn(sdk, filePath, "third prompt", "third answer");
    await sendPromptTurn(sdk, filePath, "fourth prompt", "fourth answer");
    await drain(sdk, filePath);

    const detailedText = formOf(filePath, "c1", "chunk_summary_detailed")?.content;

    expect(captured.some((entry) => entry.op === "summarizeChunkDetailed")).toBe(false);
    expect(detailedText).toBe(
      `[turn 0001]\n${FIXED_PROJECTION}\n\n[turn 0002]\n${FIXED_PROJECTION}\n\n[turn 0003]\n${FIXED_PROJECTION}`,
    );
    expect(detailedText).not.toContain(" | ");
  });

  it("embeds receipts only in the member section that owns tool activity", async () => {
    const double = createInferenceCallbacksDouble();
    const projectedTokens = estimateTokens(FIXED_PROJECTION);
    const sdk = sdkFor(withScriptedProjection(double), {
      chunkPolicy: { targetProjectedTokens: 3 * projectedTokens, maxProjectedTokens: 999999 },
    });
    const filePath = await newThread();
    await sendToolTurn(sdk, filePath);
    await sendPromptTurn(sdk, filePath, "plain prompt", "plain answer");
    await sendPromptTurn(sdk, filePath, "closing prompt", "closing answer");

    await drain(sdk, filePath);

    const receipt = formOf(filePath, "t1", "turn_rendering")?.metadata?.receipts?.[0];
    const detailed = formOf(filePath, "c1", "chunk_summary_detailed");
    expect(receipt).toBeDefined();
    expect(detailed?.content).toBe(
      `[turn 0001]\n${FIXED_PROJECTION}\n[receipts ${receipt?.account}=>succeeded]\n\n[turn 0002]\n${FIXED_PROJECTION}`,
    );
    expect(detailed?.content?.endsWith(`[receipts ${receipt?.account}=>succeeded]`)).toBe(false);
  });

  it("uses ready turn_rendering as the floor for failed detailed members and logs the fallback", async () => {
    const sdk = sdkFor(createInferenceCallbacksDouble());
    const filePath = await newThread();
    await sendPromptTurn(sdk, filePath, "floor prompt", "floor answer");
    await drain(sdk, filePath);
    const rendering = formOf(filePath, "t1", "turn_rendering")?.content;
    expect(rendering).toBeDefined();

    setCompressionState(filePath, "t1", { state: "failed", reason: "scripted compression failure" });
    resetChunkSummary(filePath, "c1", "chunk_summary_detailed");
    enqueueChunkSummaryWork(filePath, "w-c1-chunk_summary_detailed-v1", "c1", "chunk_summary_detailed");

    const report = await drain(sdk, filePath, { maxItems: 1 });

    expect(report.ran.map((entry) => [entry.workItemId, entry.disposition])).toEqual([
      ["w-c1-chunk_summary_detailed-v1", "done"],
    ]);
    expect(formOf(filePath, "c1", "chunk_summary_detailed")).toMatchObject({
      state: "ready",
      content: `[turn 0001]\n${rendering}`,
    });
    const logs = await sdk.logging.query({ filePath }, { derivationType: "chunk_summary_detailed", subjectId: "c1" });
    expect(logs.ok).toBe(true);
    if (!logs.ok) return;
    expect(logs.value).toContainEqual(
      expect.objectContaining({ reason: "failed_floor", floorUsed: "t1", level: "warning" }),
    );
  });

  it("does not log failed-floor fallback when completion is stale-discarded", async () => {
    const sdk = sdkFor(createInferenceCallbacksDouble());
    const filePath = await newThread();
    await sendPromptTurn(sdk, filePath, "stale floor prompt", "stale floor answer");
    await drain(sdk, filePath);

    setCompressionState(filePath, "t1", { state: "failed", reason: "scripted compression failure" });
    resetChunkSummary(filePath, "c1", "chunk_summary_detailed");
    enqueueChunkSummaryWork(filePath, "w-c1-chunk_summary_detailed-v1", "c1", "chunk_summary_detailed");
    execSql(
      filePath,
      `UPDATE derivation SET source_version = 2
       WHERE subject_kind = 'chunk' AND subject_id = 'c1' AND derivation_type = 'chunk_summary_detailed'`,
    );

    const report = await drain(sdk, filePath, { maxItems: 1 });

    expect(report.ran.map((entry) => [entry.workItemId, entry.disposition])).toEqual([
      ["w-c1-chunk_summary_detailed-v1", "stale_discarded"],
    ]);
    const logs = await sdk.logging.query({ filePath }, { derivationType: "chunk_summary_detailed", subjectId: "c1" });
    expect(logs.ok).toBe(true);
    if (!logs.ok) return;
    expect(logs.value).toEqual([]);
  });

  it("requeues pending members and blocks blocked members", async () => {
    const sdk = sdkFor(createInferenceCallbacksDouble());
    const filePath = await newThread();
    await sendPromptTurn(sdk, filePath, "pending prompt", "pending answer");
    await sendPromptTurn(sdk, filePath, "blocked prompt", "blocked answer");
    await drain(sdk, filePath);

    setCompressionState(filePath, "t1", { state: "pending" });
    resetChunkSummary(filePath, "c1", "chunk_summary_detailed");
    enqueueChunkSummaryWork(filePath, "w-c1-chunk_summary_detailed-v1", "c1", "chunk_summary_detailed");
    await drain(sdk, filePath, { maxItems: 1 });

    expect(formOf(filePath, "c1", "chunk_summary_detailed")?.state).toBe("pending");
    expect(liveQueue(filePath).find((row) => row.workItemId === "w-c1-chunk_summary_detailed-v1")).toMatchObject({
      attempts: 1,
      lastError: expect.stringContaining("member_projection_not_ready"),
    });
    execSql(filePath, `DELETE FROM work_item WHERE work_item_id = ?`, "w-c1-chunk_summary_detailed-v1");

    setCompressionState(filePath, "t2", { state: "blocked", reason: "source damaged" });
    resetChunkSummary(filePath, "c2", "chunk_summary_detailed");
    enqueueChunkSummaryWork(filePath, "w-c2-chunk_summary_detailed-v1", "c2", "chunk_summary_detailed");
    await drain(sdk, filePath, { maxItems: 1 });

    expect(formOf(filePath, "c2", "chunk_summary_detailed")).toMatchObject({
      state: "blocked",
      reason: expect.stringContaining("source_damaged"),
    });
  });

  it("does not use the failed-member floor for brief summaries", async () => {
    const sdk = sdkFor(createInferenceCallbacksDouble());
    const filePath = await newThread();
    await sendPromptTurn(sdk, filePath, "brief floor prompt", "brief floor answer");
    await drain(sdk, filePath);

    setCompressionState(filePath, "t1", { state: "failed", reason: "scripted compression failure" });
    resetChunkSummary(filePath, "c1", "chunk_summary_detailed");
    resetChunkSummary(filePath, "c1", "chunk_summary_brief");
    enqueueChunkSummaryWork(filePath, "w-c1-chunk_summary_detailed-v1", "c1", "chunk_summary_detailed");
    enqueueChunkSummaryWork(filePath, "w-c1-chunk_summary_brief-v1", "c1", "chunk_summary_brief");

    await drain(sdk, filePath, { maxItems: 2 });

    expect(formOf(filePath, "c1", "chunk_summary_detailed")?.state).toBe("ready");
    expect(formOf(filePath, "c1", "chunk_summary_brief")?.state).toBe("pending");
    expect(liveQueue(filePath).find((row) => row.workItemId === "w-c1-chunk_summary_brief-v1")).toMatchObject({
      attempts: 1,
      lastError: expect.stringContaining("member_projection_not_ready"),
    });
  });

  it("produces byte-identical detailed output for identical input", async () => {
    async function build(): Promise<string> {
      const double = createInferenceCallbacksDouble();
      const projectedTokens = estimateTokens(FIXED_PROJECTION);
      const sdk = sdkFor(withScriptedProjection(double), {
        chunkPolicy: { targetProjectedTokens: 3 * projectedTokens, maxProjectedTokens: 999999 },
      });
      const filePath = await newThread();
      await sendPromptTurn(sdk, filePath, "same first prompt", "same first answer");
      await sendPromptTurn(sdk, filePath, "same second prompt", "same second answer");
      await sendPromptTurn(sdk, filePath, "same closing prompt", "same closing answer");
      await drain(sdk, filePath);
      return formOf(filePath, "c1", "chunk_summary_detailed")?.content ?? "";
    }

    await expect(build()).resolves.toBe(await build());
  });
});
