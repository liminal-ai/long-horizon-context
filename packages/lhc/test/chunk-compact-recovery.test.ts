import type { SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
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
    chunkPolicy: { targetProjectedTokens: 1, maxProjectedTokens: 999999 },
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

function execSql(filePath: string, sql: string, ...params: SQLInputValue[]): void {
  const db = openRaw(filePath);
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

function execCorruptSql(filePath: string, sql: string, ...params: SQLInputValue[]): void {
  const db = openRaw(filePath);
  try {
    db.exec("PRAGMA foreign_keys = OFF;");
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
  execSql(
    filePath,
    `UPDATE derivation SET state = ?, content = ?, reason = ? 
     WHERE subject_kind = 'chunk' AND subject_id = ? AND derivation_type = ?`,
    state,
    opts.content ?? null,
    opts.reason ?? null,
    chunkId,
    derivationType,
  );
}

function deleteWorkFor(filePath: string, kind: string, chunkId: string): void {
  execSql(
    filePath,
    `DELETE FROM work_item WHERE kind = ? AND json_extract(source_ref, '$.chunkId') = ?`,
    kind,
    chunkId,
  );
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
     VALUES (?, 'turns', ?, ?, 'queued', '2026-06-15T00:00:00.000Z', ?)`,
    workItemId,
    derivationType,
    JSON.stringify({ chunkId }),
    JSON.stringify({
      sourceVersion: 1,
      derivations: [{ subjectKind: "chunk", subjectId: chunkId, derivationType }],
    }),
  );
}

async function seedFourClosedTurns(sdk: Lhc, filePath: string): Promise<void> {
  for (let i = 1; i <= 4; i += 1) {
    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: `prompt ${i}` } }),
      validEvent("assistant_text", { payload: { text: `answer ${i}` } }),
      validEvent("turn_end"),
    ]);
  }
  await drain(sdk, filePath);
}

describe("Story 4: chunk derivation and compact recovery", () => {
  it("queues detailed and brief chunk summaries as independent work items and states", async () => {
    const double = createInferenceCallbacksDouble();
    double.failKind("chunk_summary_brief", 3, {
      retryable: true,
      reason: "timeout: scripted brief failure",
    });
    const sdk = sdkFor(double);
    const filePath = await newThread();

    await seedFourClosedTurns(sdk, filePath);

    expect(formOf(filePath, "c1", "chunk_summary_detailed")?.state).toBe("ready");
    expect(formOf(filePath, "c1", "chunk_summary_brief")).toMatchObject({
      state: "failed",
      reason: "timeout: scripted brief failure",
    });
  });

  it("compacts not-ready chunk summaries through stored-member concat with zero model calls", async () => {
    const sdk = sdkFor(createInferenceCallbacksDouble());
    const filePath = await newThread();
    await seedFourClosedTurns(sdk, filePath);
    setChunkSummaryState(filePath, "c1", "chunk_summary_detailed", "failed", {
      reason: "timeout: old summary failed",
    });
    deleteWorkFor(filePath, "chunk_summary_detailed", "c1");

    const spy = createInferenceCallbacksDouble();
    const captured = spy.captureInputs();
    const compactSdk = sdkFor(spy);
    const compacted = await compactSdk.threadView.compact(
      { filePath },
      {
        sweep: false,
        params: {
          lowerBound: 120,
          percentages: { full: 10, smooth: 10, detailed: 70, brief: 10 },
        },
      },
    );

    expect(compacted.ok).toBe(true);
    if (!compacted.ok) return;
    expect(captured).toEqual([]);
    expect(compacted.value.warnings).toContainEqual({
      band: "detailed",
      subjectId: "c1",
      derivationType: "chunk_summary_detailed",
      reason: "failed_floor",
    });
    const pulled = await compactSdk.threadView.pull({ filePath });
    expect(pulled.ok).toBe(true);
    if (!pulled.ok) return;
    const detailed = pulled.value.messages.find((message) => message.band === "detailed");
    expect(detailed?.content).toContain("§c1 [degraded: detailed-from-stored-members]");
    expect(detailed?.content).toContain("§t1\nprompt 1\nanswer 1");
    expect(detailed?.content).not.toContain("unavailable");

    const logs = await compactSdk.logging.query(
      { filePath },
      { derivationType: "chunk_summary_detailed", subjectId: "c1" },
    );
    expect(logs.ok).toBe(true);
    if (!logs.ok) return;
    expect(logs.value[0]).toMatchObject({
      level: "warning",
      reason: "failed_floor",
      floorUsed: "stored_member_concat",
    });
  });

  it("halts compact before fallback assembly when stop is requested", async () => {
    const sdk = sdkFor(createInferenceCallbacksDouble());
    const filePath = await newThread();
    await seedFourClosedTurns(sdk, filePath);
    setChunkSummaryState(filePath, "c1", "chunk_summary_detailed", "pending");
    deleteWorkFor(filePath, "chunk_summary_detailed", "c1");

    const stopped = await sdk.threadView.compact(
      { filePath },
      {
        sweep: false,
        signal: { aborted: true },
        params: {
          lowerBound: 120,
          percentages: { full: 10, smooth: 10, detailed: 70, brief: 10 },
        },
      },
    );

    expect(stopped.ok).toBe(false);
    if (stopped.ok) return;
    expect(stopped.error).toMatchObject({
      errorClass: "caller_error",
      code: "compact_stopped",
    });
    expect(formOf(filePath, "c1", "chunk_summary_detailed")?.state).toBe("pending");
  });

  it("refuses compact when canonical member source is corrupt", async () => {
    const sdk = sdkFor(createInferenceCallbacksDouble());
    const filePath = await newThread();
    await seedFourClosedTurns(sdk, filePath);
    setChunkSummaryState(filePath, "c1", "chunk_summary_detailed", "pending");
    deleteWorkFor(filePath, "chunk_summary_detailed", "c1");
    execCorruptSql(filePath, `DELETE FROM turns WHERE turn_id = 't1'`);

    const compacted = await sdk.threadView.compact(
      { filePath },
      {
        sweep: false,
        params: {
          lowerBound: 120,
          percentages: { full: 10, smooth: 10, detailed: 70, brief: 10 },
        },
      },
    );

    expect(compacted.ok).toBe(false);
    if (compacted.ok) return;
    expect(compacted.error).toMatchObject({ errorClass: "state_corruption" });
  });

  it("background chunk summary work requeues on not-ready member projection", async () => {
    const sdk = sdkFor(createInferenceCallbacksDouble(), {
      retry: { budget: 3, backoffBaseMs: 1000, backoffCapMs: 1000 },
    });
    const filePath = await newThread();
    await seedFourClosedTurns(sdk, filePath);
    setChunkSummaryState(filePath, "c1", "chunk_summary_detailed", "pending");
    execSql(
      filePath,
      `UPDATE derivation SET state = 'pending', content = NULL
       WHERE subject_kind = 'turn' AND subject_id = 't1' AND derivation_type = 'smooth_turn_compression'`,
    );
    enqueueChunkSummaryWork(filePath, "w-c1-chunk_summary_detailed-v99", "c1", "chunk_summary_detailed");

    await drain(sdk, filePath, { maxItems: 1 });

    expect(formOf(filePath, "c1", "chunk_summary_detailed")?.state).toBe("pending");
    const item = liveQueue(filePath).find((row) => row.workItemId === "w-c1-chunk_summary_detailed-v99");
    expect(item).toMatchObject({
      status: "queued",
      attempts: 1,
      lastError: expect.stringContaining("member_projection_not_ready"),
    });
  });

  it("background chunk summaries block when a chunk member references a missing turn", async () => {
    const sdk = sdkFor(createInferenceCallbacksDouble());
    const filePath = await newThread();
    await seedFourClosedTurns(sdk, filePath);
    setChunkSummaryState(filePath, "c1", "chunk_summary_detailed", "pending");
    setChunkSummaryState(filePath, "c1", "chunk_summary_brief", "pending");
    execCorruptSql(filePath, `DELETE FROM turns WHERE turn_id = 't1'`);
    enqueueChunkSummaryWork(filePath, "w-c1-chunk_summary_detailed-v98", "c1", "chunk_summary_detailed");
    enqueueChunkSummaryWork(filePath, "w-c1-chunk_summary_brief-v98", "c1", "chunk_summary_brief");

    await drain(sdk, filePath, { maxItems: 2 });

    expect(formOf(filePath, "c1", "chunk_summary_detailed")).toMatchObject({
      state: "blocked",
      reason: expect.stringContaining("source_damaged"),
    });
    expect(formOf(filePath, "c1", "chunk_summary_brief")).toMatchObject({
      state: "blocked",
      reason: expect.stringContaining("source_damaged"),
    });
  });
});
