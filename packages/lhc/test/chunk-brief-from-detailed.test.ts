import type { SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type DrainReport,
  estimateTokens,
  type InferenceCallbacks,
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

async function newThread(): Promise<string> {
  const created = await threads.newThread({ filePath: store.threadPath(), registryPath: store.registryPath });
  if (!created.ok) throw new Error(created.error.reason);
  return created.value.filePath;
}

function sdkFor(inferenceCallbacks: InferenceCallbacks, overrides: Partial<SdkConfig> = {}): Lhc {
  return initLhc({
    inferenceCallbacks,
    mode: "manual",
    retry: { budget: 3, backoffBaseMs: 1000, backoffCapMs: 1000 },
    lease: { durationMs: 200 },
    guards: { detailedTurnCompression: { tinyTurnTokens: 1 } },
    chunkPolicy: SELF_CHUNK,
    ...overrides,
  });
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

function setChunkSummaryState(
  filePath: string,
  chunkId: string,
  derivationType: "chunk_summary_detailed" | "chunk_summary_brief",
  state: "pending" | "ready" | "failed" | "blocked",
  opts: { content?: string; reason?: string } = {},
): void {
  const update: { state: "pending" | "ready" | "failed" | "blocked"; content?: string; reason?: string } = { state };
  if (opts.content !== undefined) update.content = opts.content;
  if (opts.reason !== undefined) update.reason = opts.reason;
  setFormState(filePath, { subjectKind: "chunk", subjectId: chunkId, derivationType }, update);
}

function enqueueChunkSummaryWork(
  filePath: string,
  workItemId: string,
  chunkId: string,
  derivationType: "chunk_summary_detailed" | "chunk_summary_brief",
  sourceVersion = 1,
): void {
  execSql(
    filePath,
    `INSERT INTO work_item (work_item_id, owner, kind, source_ref, status, queued_at, payload)
     VALUES (?, 'turns', ?, ?, 'queued', '2026-06-22T00:00:00.000Z', ?)`,
    workItemId,
    derivationType,
    JSON.stringify({ chunkId }),
    JSON.stringify({
      sourceVersion,
      derivations: [{ subjectKind: "chunk", subjectId: chunkId, derivationType }],
    }),
  );
}

async function seedClosedChunk(sdk: Lhc, filePath: string): Promise<void> {
  await sendPromptTurn(sdk, filePath, "brief source prompt", "brief source answer");
  await drain(sdk, filePath);
}

function targetInputFor(text: string) {
  const inputTokens = estimateTokens(text);
  return {
    text,
    inputTokens,
    targetMinTokens: Math.max(1, Math.round(inputTokens * 0.08)),
    targetAimTokens: Math.max(1, Math.round(inputTokens * 0.12)),
    targetMaxTokens: Math.max(1, Math.round(inputTokens * 0.2)),
  };
}

describe("Story 5: chunk_summary_brief from detailed material", () => {
  it("sends detailed text and concrete targets to the model, then records sizeDisposition", async () => {
    const double = createInferenceCallbacksDouble();
    const captured = double.captureInputs();
    const sdk = sdkFor(double);
    const filePath = await newThread();
    await seedClosedChunk(sdk, filePath);
    const detailedText = "seeded detailed text; not the member compression";
    const memberCompression = formOf(filePath, "t1", "detailed_turn_compression")?.content ?? "";
    expect(memberCompression).not.toBe(detailedText);

    setChunkSummaryState(filePath, "c1", "chunk_summary_detailed", "ready", { content: detailedText });
    setChunkSummaryState(filePath, "c1", "chunk_summary_brief", "pending");

    const derived = await sdk.turns.deriveBriefChunk({ filePath }, "c1");

    expect(derived.ok).toBe(true);
    if (!derived.ok) return;
    expect(derived.value).toMatchObject({ chunkId: "c1", derivationType: "chunk_summary_brief", outcome: "derived" });
    const expectedInput = targetInputFor(detailedText);
    const briefInput = captured.filter((entry) => entry.op === "summarizeChunkBrief").at(-1)?.input;
    expect(briefInput).toEqual(expectedInput);
    expect(JSON.stringify(briefInput)).not.toContain(memberCompression);
    expect(formOf(filePath, "c1", "chunk_summary_brief")).toMatchObject({
      state: "ready",
      metadata: { sizeDisposition: expect.any(String) },
    });
  });

  it("defers behind live detailed work without writing detailed directly", async () => {
    const sdk = sdkFor(createInferenceCallbacksDouble());
    const filePath = await newThread();
    await seedClosedChunk(sdk, filePath);
    setChunkSummaryState(filePath, "c1", "chunk_summary_detailed", "pending");
    setChunkSummaryState(filePath, "c1", "chunk_summary_brief", "pending");
    enqueueChunkSummaryWork(filePath, "w-c1-chunk_summary_brief-v1", "c1", "chunk_summary_brief");
    enqueueChunkSummaryWork(filePath, "w-c1-chunk_summary_detailed-v1", "c1", "chunk_summary_detailed");

    await drain(sdk, filePath, { maxItems: 1 });

    expect(formOf(filePath, "c1", "chunk_summary_detailed")?.state).toBe("pending");
    expect(formOf(filePath, "c1", "chunk_summary_brief")?.state).toBe("pending");
    expect(liveQueue(filePath).find((row) => row.workItemId === "w-c1-chunk_summary_brief-v1")).toMatchObject({
      attempts: 0,
      status: "queued",
    });
    expect(liveQueue(filePath).find((row) => row.workItemId === "w-c1-chunk_summary_detailed-v1")).toBeDefined();
    expect(liveQueue(filePath).filter((row) => row.kind === "chunk_summary_brief")).toHaveLength(1);

    await drain(sdk, filePath);

    expect(formOf(filePath, "c1", "chunk_summary_detailed")?.state).toBe("ready");
    expect(formOf(filePath, "c1", "chunk_summary_brief")?.state).toBe("ready");
  });

  it("schedules detailed work before requeued brief when no detailed work is live", async () => {
    const sdk = sdkFor(createInferenceCallbacksDouble());
    const filePath = await newThread();
    await seedClosedChunk(sdk, filePath);
    setChunkSummaryState(filePath, "c1", "chunk_summary_detailed", "pending");
    setChunkSummaryState(filePath, "c1", "chunk_summary_brief", "pending");
    enqueueChunkSummaryWork(filePath, "w-c1-chunk_summary_brief-v1", "c1", "chunk_summary_brief");

    await drain(sdk, filePath, { maxItems: 1 });

    expect(formOf(filePath, "c1", "chunk_summary_detailed")?.state).toBe("pending");
    expect(formOf(filePath, "c1", "chunk_summary_brief")?.state).toBe("pending");
    expect(liveQueue(filePath).find((row) => row.workItemId === "w-c1-chunk_summary_brief-v1")).toMatchObject({
      attempts: 0,
      status: "queued",
    });
    expect(liveQueue(filePath).find((row) => row.workItemId === "w-c1-chunk_summary_detailed-v1")).toBeDefined();
    expect(liveQueue(filePath).filter((row) => row.kind === "chunk_summary_brief")).toHaveLength(1);

    await drain(sdk, filePath);

    expect(formOf(filePath, "c1", "chunk_summary_detailed")?.state).toBe("ready");
    expect(formOf(filePath, "c1", "chunk_summary_brief")?.state).toBe("ready");
  });

  it("uses the current brief source version when the detailed row is missing", async () => {
    const sdk = sdkFor(createInferenceCallbacksDouble());
    const filePath = await newThread();
    await seedClosedChunk(sdk, filePath);
    execSql(
      filePath,
      `DELETE FROM derivation
       WHERE subject_kind = 'chunk' AND subject_id = 'c1' AND derivation_type = 'chunk_summary_detailed'`,
    );
    execSql(
      filePath,
      `UPDATE derivation SET state = 'pending', content = NULL, reason = NULL, metadata = NULL, source_version = 3
       WHERE subject_kind = 'chunk' AND subject_id = 'c1' AND derivation_type = 'chunk_summary_brief'`,
    );
    enqueueChunkSummaryWork(filePath, "w-c1-chunk_summary_brief-v3", "c1", "chunk_summary_brief", 3);

    await drain(sdk, filePath, { maxItems: 1 });

    expect(formOf(filePath, "c1", "chunk_summary_detailed")?.sourceVersion).toBe(3);
    expect(formOf(filePath, "c1", "chunk_summary_brief")?.sourceVersion).toBe(3);
    expect(liveQueue(filePath).find((row) => row.workItemId === "w-c1-chunk_summary_detailed-v3")).toMatchObject({
      sourceVersion: 3,
      status: "queued",
    });
    expect(liveQueue(filePath).find((row) => row.workItemId === "w-c1-chunk_summary_brief-v3")).toMatchObject({
      sourceVersion: 3,
      status: "queued",
    });
  });

  it("keeps detailed pending when its member projection is pending", async () => {
    const sdk = sdkFor(createInferenceCallbacksDouble());
    const filePath = await newThread();
    await seedClosedChunk(sdk, filePath);
    setChunkSummaryState(filePath, "c1", "chunk_summary_detailed", "pending");
    setChunkSummaryState(filePath, "c1", "chunk_summary_brief", "pending");
    setFormState(
      filePath,
      { subjectKind: "turn", subjectId: "t1", derivationType: "detailed_turn_compression" },
      { state: "pending" },
    );
    enqueueChunkSummaryWork(filePath, "w-c1-chunk_summary_brief-v1", "c1", "chunk_summary_brief");

    await drain(sdk, filePath, { maxItems: 1 });

    expect(formOf(filePath, "c1", "chunk_summary_detailed")?.state).toBe("pending");
    expect(formOf(filePath, "c1", "chunk_summary_brief")?.state).toBe("pending");
    expect(liveQueue(filePath).find((row) => row.workItemId === "w-c1-chunk_summary_brief-v1")).toMatchObject({
      attempts: 0,
      status: "queued",
    });

    await drain(sdk, filePath, { maxItems: 1 });

    expect(formOf(filePath, "c1", "chunk_summary_detailed")?.state).toBe("pending");
    expect(formOf(filePath, "c1", "chunk_summary_brief")?.state).toBe("pending");
    expect(liveQueue(filePath).find((row) => row.workItemId === "w-c1-chunk_summary_detailed-v1")).toMatchObject({
      attempts: 1,
      lastError: expect.stringContaining("member_projection_not_ready"),
    });
  });

  it("blocks when detailed is blocked or failed", async () => {
    const sdk = sdkFor(createInferenceCallbacksDouble());
    const filePath = await newThread();
    await seedClosedChunk(sdk, filePath);

    setChunkSummaryState(filePath, "c1", "chunk_summary_detailed", "blocked", { reason: "source damaged" });
    setChunkSummaryState(filePath, "c1", "chunk_summary_brief", "pending");
    enqueueChunkSummaryWork(filePath, "w-c1-chunk_summary_brief-v1", "c1", "chunk_summary_brief");
    await drain(sdk, filePath, { maxItems: 1 });
    expect(formOf(filePath, "c1", "chunk_summary_brief")).toMatchObject({
      state: "blocked",
      reason: expect.stringContaining("source_damaged"),
    });

    setChunkSummaryState(filePath, "c1", "chunk_summary_detailed", "failed", { reason: "detailed failed" });
    setChunkSummaryState(filePath, "c1", "chunk_summary_brief", "pending");
    enqueueChunkSummaryWork(filePath, "w-c1-chunk_summary_brief-v2", "c1", "chunk_summary_brief");
    await drain(sdk, filePath, { maxItems: 1 });
    expect(formOf(filePath, "c1", "chunk_summary_brief")).toMatchObject({
      state: "blocked",
      reason: expect.stringContaining("source_damaged"),
    });
  });
});
