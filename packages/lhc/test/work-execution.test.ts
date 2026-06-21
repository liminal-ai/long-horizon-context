// Story 1 (Epic 02): queue execution and drain — Flow 1, in-process half.
// Claim/lease mechanics, queue-order dispatch, retry/backoff with the
// head-gates-queue rule, terminal dispositions (reported then deleted, DD-1),
// unknown-kind handling, both host modes, and coalesced background
// scheduling. The cross-process legs (TC-1.3 kill, TC-1.4 claim exclusion,
// CLI parity) live in cli-process-work.test.ts.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyDerivationSuccess,
  countLiveItems,
  type DrainReport,
  type DurableWorkDispatcher,
  type InferenceCallbacks,
  type InferenceResult,
  initLhc,
  intakeStream,
  type Lhc,
  type MessageEventInput,
  queueDetail,
  registerTestingWork,
  setSchedulerPoke,
  setThreadTouch,
  threads,
} from "../src/index.js";
import { applyDerivationTerminalFailure } from "../src/shared-tech/durable-work/index.js";
import {
  createInferenceCallbacksDouble,
  openRaw,
  readDerivedForms,
  registerTestWorkHandlers,
  type TempStore,
  tempStore,
  validEvent,
} from "./fixtures/index.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(pred: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  // Background-mode SDKs install process-wide seams at construction; tests
  // must not leak them into each other.
  setSchedulerPoke(null);
  setThreadTouch(null);
  store.cleanup();
});

async function newThread(): Promise<{ threadId: string; filePath: string }> {
  const created = await threads.newThread({
    filePath: store.threadPath(),
    registryPath: store.registryPath,
  });
  if (!created.ok) throw new Error(`thread creation failed: ${created.error.reason}`);
  return created.value;
}

async function send(sdk: Lhc, filePath: string, batch: readonly MessageEventInput[]): Promise<void> {
  const result = await sdk.intakeStream.messageEvents({ filePath }, batch);
  if (!result.ok) throw new Error(`batch failed: ${result.error.reason}`);
}

function manualSdk(
  double: InferenceCallbacks,
  overrides: {
    clock?: () => Date;
    retry?: { budget: number; backoffBaseMs: number; backoffCapMs: number };
  } = {},
): Lhc {
  const sdk = initLhc({
    inferenceCallbacks: double,
    mode: "manual",
    clock: overrides.clock ?? (() => new Date()),
    retry: overrides.retry ?? { budget: 3, backoffBaseMs: 0, backoffCapMs: 0 },
    lease: { durationMs: 200 },
  });
  registerTestWorkHandlers(sdk, double);
  return sdk;
}

async function drain(sdk: Lhc, filePath: string, opts?: { maxItems?: number }): Promise<DrainReport> {
  const result = await sdk.work.drain({ filePath }, opts);
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

function liveDetail(filePath: string): ReturnType<typeof queueDetail> {
  const db = openRaw(filePath);
  try {
    return queueDetail(db);
  } finally {
    db.close();
  }
}

function claimHeadWorkItem(filePath: string, expiresAt: string): void {
  const db = openRaw(filePath);
  try {
    db.exec("BEGIN IMMEDIATE;");
    try {
      const changed = db
        .prepare(
          `UPDATE work_item
           SET status = 'claimed',
               claimed_at = ?,
               claim_expires_at = ?,
               claim_epoch = claim_epoch + 1
           WHERE work_item_id = (
             SELECT work_item_id FROM work_item
             WHERE status IN ('queued', 'claimed')
             ORDER BY rowid LIMIT 1
           )`,
        )
        .run(new Date(Date.parse(expiresAt) - 1000).toISOString(), expiresAt);
      if (Number(changed.changes) !== 1) {
        throw new Error(`expected to claim exactly one work item, changed ${String(changed.changes)}`);
      }
      db.exec("COMMIT;");
    } catch (cause) {
      db.exec("ROLLBACK;");
      throw cause;
    }
  } finally {
    db.close();
  }
}

function setHeadClaimExpiry(filePath: string, expiresAt: string | null): void {
  const db = openRaw(filePath);
  try {
    const changed = db
      .prepare(
        `UPDATE work_item
         SET claim_expires_at = ?
         WHERE work_item_id = (
           SELECT work_item_id FROM work_item
           WHERE status = 'claimed'
           ORDER BY rowid LIMIT 1
         )`,
      )
      .run(expiresAt);
    if (Number(changed.changes) !== 1) {
      throw new Error(`expected to update exactly one claimed work item, changed ${String(changed.changes)}`);
    }
  } finally {
    db.close();
  }
}

function deleteWorkItem(filePath: string, workItemId: string): void {
  const db = openRaw(filePath);
  try {
    db.prepare(`DELETE FROM work_item WHERE work_item_id = ?`).run(workItemId);
  } finally {
    db.close();
  }
}

function expireWorkItemClaim(filePath: string, workItemId: string, expiresAt: string): void {
  const db = openRaw(filePath);
  try {
    const changed = db
      .prepare(`UPDATE work_item SET claim_expires_at = ? WHERE work_item_id = ? AND status = 'claimed'`)
      .run(expiresAt, workItemId);
    if (Number(changed.changes) !== 1) {
      throw new Error(`expected to expire one claimed work item, changed ${String(changed.changes)}`);
    }
  } finally {
    db.close();
  }
}

function setWorkItemAttempts(filePath: string, workItemId: string, attempts: number): void {
  const db = openRaw(filePath);
  try {
    const changed = db.prepare(`UPDATE work_item SET attempts = ? WHERE work_item_id = ?`).run(attempts, workItemId);
    if (Number(changed.changes) !== 1) {
      throw new Error(`expected to update one work item, changed ${String(changed.changes)}`);
    }
  } finally {
    db.close();
  }
}

function setReadyDerivation(
  filePath: string,
  target: { subjectKind: "message" | "turn" | "chunk"; subjectId: string; derivationType: string },
  content: string,
  sourceVersion: number,
): void {
  const db = openRaw(filePath);
  try {
    const changed = db
      .prepare(
        `UPDATE derivation
         SET state = 'ready', content = ?, reason = NULL, metadata = NULL,
             gaps = NULL, derived_at = ?, source_version = ?
         WHERE subject_kind = ? AND subject_id = ? AND derivation_type = ?`,
      )
      .run(
        content,
        "2026-06-10T12:00:01.000Z",
        sourceVersion,
        target.subjectKind,
        target.subjectId,
        target.derivationType,
      );
    if (Number(changed.changes) !== 1) {
      throw new Error(`expected to update one derivation, changed ${String(changed.changes)}`);
    }
  } finally {
    db.close();
  }
}

function insertAbandonedChunkSummary(filePath: string, chunkId: string, derivationType: string): void {
  const db = openRaw(filePath);
  try {
    db.prepare(
      `INSERT INTO chunk (chunk_id, chunk_order, status, accumulated_projected_tokens)
       VALUES (?, 1, 'closed', 0)`,
    ).run(chunkId);
    db.prepare(
      `INSERT INTO derivation (subject_kind, subject_id, derivation_type, state, source_version)
       VALUES ('chunk', ?, ?, 'pending', 1)`,
    ).run(chunkId, derivationType);
  } finally {
    db.close();
  }
}

describe("TC-1.1: a drain runs queued items one at a time, in queue order, and reports each disposition", () => {
  it("three items across both owners run in order; rows are deleted at terminal transition; derivedAt is monotone", async () => {
    const double = createInferenceCallbacksDouble();
    let tick = 0;
    const base = Date.parse("2026-06-10T12:00:00.000Z");
    const sdk = manualSdk(double, { clock: () => new Date(base + 1000 * tick++) });
    const { filePath } = await newThread();
    await send(sdk, filePath, [
      validEvent("user_prompt"),
      validEvent("tool_call"),
      validEvent("tool_result"),
      validEvent("turn_end"),
    ]);
    expect(liveCount(filePath)).toBe(3);

    const report = await drain(sdk, filePath);
    // Queue order across owners: m1's smoothing, m3's result summary, then
    // the turn derivation queued at close — never reordered.
    expect(report.ran.map((entry) => entry.workItemId)).toEqual([
      "w-m1-prompt_smoothing-v1",
      "w-m3-tool_result_summary-v1",
      "w-t1-turn_derivation-v1",
    ]);
    expect(report.ran.map((entry) => entry.disposition)).toEqual(["done", "done", "done"]);
    expect(report.stoppedBecause).toBe("empty");
    expect(report.remaining).toBe(0);

    // DD-1 storage contract: terminal rows are gone — the report is the only
    // place the dispositions exist (raw zero-row read).
    expect(liveCount(filePath)).toBe(0);
    const db = openRaw(filePath);
    try {
      const rows = db.prepare("SELECT COUNT(*) AS n FROM work_item").get() as {
        n: number | bigint;
      };
      expect(Number(rows.n)).toBe(0);
    } finally {
      db.close();
    }

    // Artifacts landed in run order: derivedAt strictly monotone with the
    // injected clock from m1 to m3 to the turn's forms.
    const forms = readDerivedForms(filePath);
    expect(forms.map((form) => form.state)).toEqual(["ready", "ready", "ready", "ready"]);
    const at = (subjectId: string, derivationType: string): number => {
      const row = forms.find((f) => f.subjectId === subjectId && f.derivationType === derivationType);
      if (row?.derivedAt === undefined) {
        throw new Error(`no derivedAt for ${subjectId}/${derivationType}`);
      }
      return Date.parse(row.derivedAt);
    };
    expect(at("m1", "smoothed_prompt")).toBeLessThan(at("m3", "tool_result_summary"));
    expect(at("m3", "tool_result_summary")).toBeLessThan(at("t1", "turn_rendering"));
    expect(at("t1", "turn_rendering")).toBe(at("t1", "smooth_turn_compression"));
  });
});

describe("TC-1.2 / AC-1.2: mid-drain queueing coalesces into at most one further pass", () => {
  it("a burst of two more batches during a slow in-flight drain yields exactly two passes and all artifacts", async () => {
    const double = createInferenceCallbacksDouble();
    double.delayKind("prompt_smoothing", 100);
    const sdk = initLhc({
      inferenceCallbacks: double,
      mode: "background",
      retry: { budget: 3, backoffBaseMs: 0, backoffCapMs: 0 },
      lease: { durationMs: 1000 },
    });
    registerTestWorkHandlers(sdk, double);
    const { threadId, filePath } = await newThread();

    await send(sdk, filePath, [validEvent("user_prompt", { payload: { text: "batch A" } })]);
    // Let the poked drain start (it defers one macrotask), then queue two
    // more batches while item A's slow handler is in flight.
    await sleep(10);
    await send(sdk, filePath, [validEvent("user_prompt", { payload: { text: "batch B" } })]);
    await send(sdk, filePath, [validEvent("user_prompt", { payload: { text: "batch C" } })]);

    await sdk.drainSettled({ filePath });

    // Everything queued mid-drain was processed before the cycle ended…
    expect(liveCount(filePath)).toBe(0);
    const smoothed = readDerivedForms(filePath).filter((f) => f.derivationType === "smoothed_prompt");
    expect(smoothed.map((f) => f.state)).toEqual(["ready", "ready", "ready"]);
    // …and the burst coalesced: one initial pass plus exactly one follow-up,
    // not one pass per poke (the cost model is the assertion).
    expect(sdk.scheduler.testPassCount(threadId)).toBe(2);
  });
});

describe("TC-1.5 / AC-1.5, AC-1.6: background mode — queueing is sufficient; first touch catches up", () => {
  it("an intake batch is processed with no drain call; drainSettled is the completion signal", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = initLhc({
      inferenceCallbacks: double,
      mode: "background",
      retry: { budget: 3, backoffBaseMs: 0, backoffCapMs: 0 },
      lease: { durationMs: 1000 },
    });
    registerTestWorkHandlers(sdk, double);
    const { filePath } = await newThread();

    await send(sdk, filePath, [validEvent("user_prompt"), validEvent("turn_end")]);
    await sdk.drainSettled({ filePath });

    const forms = readDerivedForms(filePath);
    expect(forms.map((f) => `${f.subjectId}/${f.derivationType}/${f.state}`).sort()).toEqual([
      "m1/smoothed_prompt/ready",
      "t1/smooth_turn_compression/ready",
      "t1/turn_rendering/ready",
    ]);
    expect(liveCount(filePath)).toBe(0);
  });

  it("sync derive queued behind an older head wakes the background scheduler", async () => {
    const double = createInferenceCallbacksDouble();
    const background = initLhc({
      inferenceCallbacks: double,
      mode: "background",
      retry: { budget: 3, backoffBaseMs: 0, backoffCapMs: 0 },
      lease: { durationMs: 1000 },
    });
    registerTestWorkHandlers(background, double);
    const manual = manualSdk(double);
    const { threadId, filePath } = await newThread();

    const touched = await background.logging.write({ filePath }, { level: "info", message: "touch empty thread" });
    expect(touched.ok).toBe(true);
    await background.drainSettled({ filePath });

    await send(manual, filePath, [
      validEvent("user_prompt", { payload: { text: "first prompt" } }),
      validEvent("assistant_text", { payload: { text: "first answer" } }),
      validEvent("turn_end"),
      validEvent("user_prompt", { payload: { text: "second prompt" } }),
      validEvent("assistant_text", { payload: { text: "second answer" } }),
      validEvent("turn_end"),
    ]);
    const db = openRaw(filePath);
    try {
      db.prepare(`DELETE FROM work_item WHERE kind = 'prompt_smoothing'`).run();
      db.prepare(`DELETE FROM work_item WHERE work_item_id = 'w-t2-turn_derivation-v1'`).run();
    } finally {
      db.close();
    }

    const queued = await background.turns.deriveTurn({ filePath }, "t2");
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    expect(queued.value).toMatchObject({
      turnId: "t2",
      outcome: "failed",
      error: { errorClass: "caller_error", code: "derivation_work_in_flight" },
    });

    await background.drainSettled({ filePath });

    expect(background.scheduler.testPassCount(threadId)).toBeGreaterThan(0);
    expect(liveCount(filePath)).toBe(0);
    expect(
      readDerivedForms(filePath)
        .filter((form) => form.subjectId === "t2")
        .map((form) => [form.derivationType, form.state])
        .sort(),
    ).toEqual([
      ["smooth_turn_compression", "ready"],
      ["turn_rendering", "ready"],
    ]);
  });

  it("sync derive retry work wakes the background scheduler", async () => {
    const double = createInferenceCallbacksDouble();
    double.failKind("prompt_smoothing", 1, { retryable: true, reason: "timeout: sync retry wake" });
    const background = initLhc({
      inferenceCallbacks: double,
      mode: "background",
      retry: { budget: 3, backoffBaseMs: 0, backoffCapMs: 0 },
      lease: { durationMs: 1000 },
    });
    registerTestWorkHandlers(background, double);
    const manual = manualSdk(double);
    const { filePath } = await newThread();

    const touched = await background.logging.write({ filePath }, { level: "info", message: "touch empty thread" });
    expect(touched.ok).toBe(true);
    await background.drainSettled({ filePath });

    await send(manual, filePath, [validEvent("user_prompt", { payload: { text: "retry prompt" } })]);

    const retried = await background.messages.derive({ filePath }, ["m1"]);
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.value[0]).toMatchObject({
      messageId: "m1",
      outcome: "failed",
      error: { errorClass: "system_error", code: "derivation_retry_scheduled", reason: "timeout: sync retry wake" },
    });

    await background.drainSettled({ filePath });

    expect(liveCount(filePath)).toBe(0);
    expect(readDerivedForms(filePath)[0]).toMatchObject({
      subjectId: "m1",
      derivationType: "smoothed_prompt",
      state: "ready",
    });
  });

  it("reopening a thread with leftover queued rows recovers them when the process engages — message reads stay pure (Epic 04 DD-6)", async () => {
    // Build the leftover state with no background scheduler installed: rows
    // accumulate exactly as a dead process would have left them.
    const { filePath } = await newThread();
    const seeded = await intakeStream.messageEvents({ filePath }, [validEvent("user_prompt"), validEvent("turn_end")]);
    expect(seeded.ok).toBe(true);
    expect(liveCount(filePath)).toBe(2);

    const double = createInferenceCallbacksDouble();
    const sdk = initLhc({
      inferenceCallbacks: double,
      mode: "background",
      retry: { budget: 3, backoffBaseMs: 0, backoffCapMs: 0 },
      lease: { durationMs: 1000 },
    });
    registerTestWorkHandlers(sdk, double);

    // First touch of the thread in this process lifetime is a read. Message
    // list/show are read-only (Epic 04 DD-6, SV-01-001): like thread-view's
    // pull/status before them, they suppress the open announcement, so the
    // read schedules no first-touch catch-up — the leftover rows stay exactly
    // as the dead process left them, and no model call fires off a read.
    const read = await sdk.messages.list({ filePath });
    expect(read.ok).toBe(true);
    await sdk.drainSettled({ filePath });
    expect(liveCount(filePath)).toBe(2);

    // Recovery arrives the moment the process engages the thread through a
    // non-read path — here an explicit drain (an intake or any write touches
    // the same way). The leftover work catches up to ready.
    const recovered = await sdk.work.drain({ filePath });
    expect(recovered.ok).toBe(true);
    await sdk.drainSettled({ filePath });

    expect(liveCount(filePath)).toBe(0);
    const states = readDerivedForms(filePath).map((f) => f.state);
    expect(states).toEqual(["ready", "ready", "ready"]);
  });

  it("first-touch catch-up wakes when a leftover claimed head reaches claim_expires_at", async () => {
    const { filePath } = await newThread();
    const seeded = await intakeStream.messageEvents({ filePath }, [validEvent("user_prompt")]);
    expect(seeded.ok).toBe(true);

    const expiresAt = new Date(Date.now() + 35).toISOString();
    claimHeadWorkItem(filePath, expiresAt);
    expect(liveDetail(filePath)[0]).toMatchObject({
      workItemId: "w-m1-prompt_smoothing-v1",
      status: "claimed",
      claimExpiresAt: expiresAt,
      claimEpoch: 1,
    });

    const double = createInferenceCallbacksDouble();
    const captured = double.captureInputs();
    const sdk = initLhc({
      inferenceCallbacks: double,
      mode: "background",
      retry: { budget: 3, backoffBaseMs: 0, backoffCapMs: 0 },
      lease: { durationMs: 1000 },
    });
    registerTestWorkHandlers(sdk, double);

    const touched = await sdk.logging.write(
      { filePath },
      { level: "info", message: "touch thread for claimed-item catch-up" },
    );
    expect(touched.ok).toBe(true);

    await sdk.drainSettled({ filePath });

    expect(captured.filter((entry) => entry.op === "smoothPrompt")).toHaveLength(1);
    expect(readDerivedForms(filePath).map((f) => `${f.subjectId}/${f.derivationType}/${f.state}`)).toEqual([
      "m1/smoothed_prompt/ready",
    ]);
    expect(liveCount(filePath)).toBe(0);
  });

  it.each([
    { label: "null", claimExpiresAt: null },
    { label: "invalid", claimExpiresAt: "not-a-date" },
  ])("a claimed head with $label claim_expires_at is reclaimed immediately", async ({ claimExpiresAt }) => {
    const double = createInferenceCallbacksDouble();
    const sdk = manualSdk(double);
    const { filePath } = await newThread();
    await send(sdk, filePath, [validEvent("user_prompt")]);

    claimHeadWorkItem(filePath, "2026-06-10T12:05:00.000Z");
    setHeadClaimExpiry(filePath, claimExpiresAt);

    const report = await drain(sdk, filePath);
    expect(report.ran).toEqual([
      expect.objectContaining({
        workItemId: "w-m1-prompt_smoothing-v1",
        disposition: "done",
        attempts: 1,
      }),
    ]);
    expect(report.stoppedBecause).toBe("empty");
    expect(report.claimExpiresAt).toBeUndefined();
    expect(liveCount(filePath)).toBe(0);
    expect(readDerivedForms(filePath)[0]).toMatchObject({ state: "ready" });
  });
});

describe("TC-1.6 / AC-1.7: manual mode — rows accumulate durably and run only when drain is invoked", () => {
  it("queued work sits until work.drain; artifacts land after", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = manualSdk(double);
    const { filePath } = await newThread();
    await send(sdk, filePath, [validEvent("user_prompt")]);

    await sleep(100);
    expect(liveCount(filePath)).toBe(1);
    expect(liveDetail(filePath)[0]?.status).toBe("queued");
    expect(readDerivedForms(filePath).map((f) => f.state)).toEqual(["pending"]);

    const report = await drain(sdk, filePath);
    expect(report.ran).toHaveLength(1);
    expect(report.ran[0]?.disposition).toBe("done");
    expect(readDerivedForms(filePath).map((f) => f.state)).toEqual(["ready"]);
    expect(liveCount(filePath)).toBe(0);
  });
});

describe("TC-1.7 / AC-1.8: an unregistered kind lands failed_terminal with a stable reason and the drain continues", () => {
  it("a bogus-kind row ahead of a valid item fails with unknown_work_kind; the valid item still runs", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = manualSdk(double);
    const { filePath } = await newThread();

    // Raw row with an unregistered kind, queued ahead of any valid work.
    const db = openRaw(filePath);
    try {
      db.prepare(
        `INSERT INTO work_item (work_item_id, owner, kind, source_ref, status, queued_at)
         VALUES ('w-mX-bogus_kind-v1', 'messages', 'bogus_kind', '{"messageId":"mX"}', 'queued',
                 '2026-06-10T11:00:00.000Z')`,
      ).run();
    } finally {
      db.close();
    }
    await send(sdk, filePath, [validEvent("user_prompt")]);

    const report = await drain(sdk, filePath);
    expect(report.ran).toHaveLength(2);
    expect(report.ran[0]).toMatchObject({
      workItemId: "w-mX-bogus_kind-v1",
      disposition: "failed_terminal",
      reason: "unknown_work_kind",
    });
    expect(report.ran[1]).toMatchObject({
      workItemId: "w-m1-prompt_smoothing-v1",
      disposition: "done",
    });
    expect(report.stoppedBecause).toBe("empty");
    expect(liveCount(filePath)).toBe(0);
    const smoothed = readDerivedForms(filePath).find((f) => f.subjectId === "m1");
    expect(smoothed?.state).toBe("ready");
  });
});

describe("TC-1.8 / AC-1.9: retry per policy, terminal exhaustion, and the backoff eligibility gate", () => {
  it("fails twice then succeeds: artifact ready, report shows attempts=2", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = manualSdk(double);
    const { filePath } = await newThread();
    await send(sdk, filePath, [validEvent("user_prompt")]);

    double.failNext(2, { retryable: true });
    const report = await drain(sdk, filePath);
    expect(report.ran).toHaveLength(1);
    expect(report.ran[0]).toMatchObject({
      workItemId: "w-m1-prompt_smoothing-v1",
      disposition: "done",
      attempts: 2,
    });
    expect(readDerivedForms(filePath)[0]?.state).toBe("ready");
    expect(liveCount(filePath)).toBe(0);
  });

  it("exhausts the budget: form failed with the final inference callback reason; the next item still ran; row deleted", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = manualSdk(double);
    const { filePath } = await newThread();
    await send(sdk, filePath, [validEvent("user_prompt"), validEvent("turn_end")]);

    double.failKind("prompt_smoothing", 99, {
      retryable: true,
      reason: "scripted exhaustion (smoothPrompt)",
    });
    const report = await drain(sdk, filePath);
    expect(report.ran).toHaveLength(2);
    expect(report.ran[0]).toMatchObject({
      workItemId: "w-m1-prompt_smoothing-v1",
      disposition: "failed_terminal",
      attempts: 3,
      reason: "scripted exhaustion (smoothPrompt)",
    });
    expect(report.ran[1]).toMatchObject({
      workItemId: "w-t1-turn_derivation-v1",
      disposition: "done",
    });

    const forms = readDerivedForms(filePath);
    const failed = forms.find((f) => f.derivationType === "smoothed_prompt");
    expect(failed?.state).toBe("failed");
    expect(failed?.reason).toBe("scripted exhaustion (smoothPrompt)");
    // Final attempts/last-error copied onto the form at exhaustion (DD-1).
    expect(failed?.metadata?.attempts).toBe(3);
    expect(forms.find((f) => f.derivationType === "turn_rendering")?.state).toBe("ready");
    expect(liveCount(filePath)).toBe(0);
  });

  it("backoff gates the head and the head gates the queue: waiting stop, waitingUntil, and no skip-ahead", async () => {
    const double = createInferenceCallbacksDouble();
    let nowMs = Date.parse("2026-06-10T12:00:00.000Z");
    const sdk = manualSdk(double, {
      clock: () => new Date(nowMs),
      retry: { budget: 3, backoffBaseMs: 50, backoffCapMs: 60000 },
    });
    const { filePath } = await newThread();
    await send(sdk, filePath, [validEvent("user_prompt"), validEvent("turn_end")]);

    double.failNext(1, { retryable: true });
    const first = await drain(sdk, filePath);
    // The head failed once and is backing off: nothing terminal ran, the
    // drain stopped on the eligibility gate, and the queue behind the head
    // was not touched.
    expect(first.ran).toEqual([]);
    expect(first.stoppedBecause).toBe("waiting");
    expect(first.remaining).toBe(2);
    expect(first.waitingUntil).toBeDefined();
    expect(Date.parse(first.waitingUntil ?? "")).toBeGreaterThan(nowMs);

    const detail = liveDetail(filePath);
    expect(detail).toHaveLength(2);
    expect(detail[0]).toMatchObject({
      workItemId: "w-m1-prompt_smoothing-v1",
      status: "queued",
      attempts: 1,
    });
    expect(detail[0]?.eligibleAt).toBe(first.waitingUntil);
    // Skip-ahead proof: the eligible item behind the backing-off head was
    // never claimed.
    expect(detail[1]).toMatchObject({
      workItemId: "w-t1-turn_derivation-v1",
      status: "queued",
      attempts: 0,
    });
    expect(detail[1]?.claimedAt).toBeUndefined();

    // Pass the gate: the head becomes eligible and the queue drains in order.
    nowMs += 60000;
    const second = await drain(sdk, filePath);
    expect(second.ran.map((entry) => [entry.workItemId, entry.disposition])).toEqual([
      ["w-m1-prompt_smoothing-v1", "done"],
      ["w-t1-turn_derivation-v1", "done"],
    ]);
    expect(second.ran[0]?.attempts).toBe(1);
    expect(liveCount(filePath)).toBe(0);
  });

  it("a non-retryable inference callback failure is terminal immediately", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = manualSdk(double);
    const { filePath } = await newThread();
    await send(sdk, filePath, [validEvent("user_prompt")]);

    double.failNext(1, { retryable: false, reason: "content refusal (scripted)" });
    const report = await drain(sdk, filePath);
    expect(report.ran[0]).toMatchObject({
      disposition: "failed_terminal",
      attempts: 1,
      reason: "content refusal (scripted)",
    });
    expect(readDerivedForms(filePath)[0]?.state).toBe("failed");
    expect(liveCount(filePath)).toBe(0);
  });

  it("maxItems stops the drain with max_items and reports the remainder", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = manualSdk(double);
    const { filePath } = await newThread();
    await send(sdk, filePath, [
      validEvent("user_prompt"),
      validEvent("tool_call"),
      validEvent("tool_result"),
      validEvent("turn_end"),
    ]);

    const report = await drain(sdk, filePath, { maxItems: 1 });
    expect(report.ran).toHaveLength(1);
    expect(report.stoppedBecause).toBe("max_items");
    expect(report.remaining).toBe(2);
    expect(liveCount(filePath)).toBe(2);
  });
});

describe("claim ownership fencing", () => {
  function deferredMessageSdk(now: { ms: number }) {
    type Scripted =
      | { disposition: "done"; content: string; mismatchedWrite?: boolean }
      | { disposition: "failed"; retryable: boolean; reason: string };
    const sdk = initLhc({
      inferenceCallbacks: createInferenceCallbacksDouble(),
      mode: "manual",
      clock: () => new Date(now.ms),
      retry: { budget: 3, backoffBaseMs: 0, backoffCapMs: 0 },
      lease: { durationMs: 50 },
    });
    const runs: Array<{ item: { workItemId: string; claimEpoch: number }; resolve: (scripted: Scripted) => void }> = [];
    const dispatcher: DurableWorkDispatcher = (run, item) =>
      new Promise((resolve) => {
        runs.push({
          item,
          resolve: (scripted) => {
            if (scripted.disposition === "done") {
              const writes = scripted.mismatchedWrite
                ? [
                    {
                      subjectKind: "message" as const,
                      subjectId: "m1",
                      derivationType: "tool_result_summary",
                      content: scripted.content,
                    },
                  ]
                : [
                    {
                      subjectKind: "message" as const,
                      subjectId: "m1",
                      derivationType: "smoothed_prompt",
                      content: scripted.content,
                    },
                  ];
              const disposition = applyDerivationSuccess(
                run.openDb(),
                {
                  sourceVersion: item.sourceVersion,
                  derivations: item.derivations,
                  workItemId: item.workItemId,
                  claimEpoch: item.claimEpoch,
                },
                writes,
                run.clock().toISOString(),
              );
              resolve({ disposition });
              return;
            }
            resolve({ disposition: "failed", retryable: scripted.retryable, reason: scripted.reason });
          },
        });
      });
    registerTestingWork(sdk, { dispatchers: { "messages.derive": dispatcher } });
    return { sdk, runs };
  }

  it("stale late success after reclaim reports lost_lease before validating mismatched writes", async () => {
    const now = { ms: Date.parse("2026-06-10T12:00:00.000Z") };
    const { sdk, runs } = deferredMessageSdk(now);
    const { filePath } = await newThread();
    await send(sdk, filePath, [validEvent("user_prompt")]);

    const olderDrain = drain(sdk, filePath);
    await until(() => runs.length === 1, "older claim");
    expect(runs[0]?.item.claimEpoch).toBe(1);

    now.ms += 100;
    const newerDrain = drain(sdk, filePath);
    await until(() => runs.length === 2, "newer reclaim");
    expect(runs[1]?.item.claimEpoch).toBe(2);

    runs[1]?.resolve({ disposition: "done", content: "newer completion" });
    const newerReport = await newerDrain;
    expect(newerReport.ran[0]).toMatchObject({ disposition: "done", attempts: 1 });

    runs[0]?.resolve({ disposition: "done", content: "stale completion", mismatchedWrite: true });
    const olderReport = await olderDrain;
    expect(olderReport.ran[0]).toMatchObject({ disposition: "lost_lease", attempts: 0 });

    const form = readDerivedForms(filePath).find((entry) => entry.derivationType === "smoothed_prompt");
    expect(form?.state).toBe("ready");
    expect(form?.content).toBe("newer completion");
    expect(liveCount(filePath)).toBe(0);
  });

  it("stale late retry after reclaim reports lost_lease and cannot reset the newer claim to queued", async () => {
    const now = { ms: Date.parse("2026-06-10T12:00:00.000Z") };
    const { sdk, runs } = deferredMessageSdk(now);
    const { filePath } = await newThread();
    await send(sdk, filePath, [validEvent("user_prompt")]);

    const olderDrain = drain(sdk, filePath);
    await until(() => runs.length === 1, "older claim");
    now.ms += 100;
    const newerDrain = drain(sdk, filePath);
    await until(() => runs.length === 2, "newer reclaim");

    runs[0]?.resolve({ disposition: "failed", retryable: true, reason: "older retry" });
    const olderReport = await olderDrain;
    expect(olderReport.ran[0]).toMatchObject({ disposition: "lost_lease", attempts: 1, reason: "older retry" });

    const detail = liveDetail(filePath);
    expect(detail).toHaveLength(1);
    expect(detail[0]).toMatchObject({
      workItemId: "w-m1-prompt_smoothing-v1",
      status: "claimed",
      claimEpoch: 2,
      attempts: 1,
    });

    runs[1]?.resolve({ disposition: "done", content: "newer completion" });
    await newerDrain;
    expect(readDerivedForms(filePath)[0]?.content).toBe("newer completion");
    expect(liveCount(filePath)).toBe(0);
  });

  it("stale late terminal failure after reclaim reports lost_lease and cannot stamp failed", async () => {
    const now = { ms: Date.parse("2026-06-10T12:00:00.000Z") };
    const { sdk, runs } = deferredMessageSdk(now);
    const { filePath } = await newThread();
    await send(sdk, filePath, [validEvent("user_prompt")]);

    const olderDrain = drain(sdk, filePath);
    await until(() => runs.length === 1, "older claim");
    now.ms += 100;
    const newerDrain = drain(sdk, filePath);
    await until(() => runs.length === 2, "newer reclaim");

    runs[0]?.resolve({ disposition: "failed", retryable: false, reason: "older terminal" });
    const olderReport = await olderDrain;
    expect(olderReport.ran[0]).toMatchObject({ disposition: "lost_lease", attempts: 1, reason: "older terminal" });

    const pending = readDerivedForms(filePath)[0];
    expect(pending?.state).toBe("pending");
    expect(pending?.reason).toBeUndefined();
    expect(liveDetail(filePath)[0]).toMatchObject({ status: "claimed", claimEpoch: 2 });

    runs[1]?.resolve({ disposition: "done", content: "newer completion" });
    await newerDrain;
    expect(readDerivedForms(filePath)[0]?.content).toBe("newer completion");
    expect(liveCount(filePath)).toBe(0);
  });
});

describe("completion exactness", () => {
  it("rejects completion attempts that pass only one claim fence field", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = manualSdk(double);
    const { filePath } = await newThread();
    await send(sdk, filePath, [validEvent("user_prompt")]);
    const db = openRaw(filePath);
    try {
      expect(() =>
        applyDerivationSuccess(
          db,
          {
            sourceVersion: 1,
            derivations: [],
            workItemId: "w-m1-prompt_smoothing-v1",
          } as unknown as Parameters<typeof applyDerivationSuccess>[1],
          [],
          "2026-06-10T12:00:00.000Z",
        ),
      ).toThrow("DerivationAttempt requires workItemId and claimEpoch together");
      expect(() =>
        applyDerivationTerminalFailure(
          db,
          {
            sourceVersion: 1,
            derivations: [],
            claimEpoch: 1,
          } as unknown as Parameters<typeof applyDerivationTerminalFailure>[1],
          {
            reason: "scripted terminal",
            state: "failed",
            attempts: 1,
            now: "2026-06-10T12:00:00.000Z",
          },
        ),
      ).toThrow("DerivationAttempt requires workItemId and claimEpoch together");
    } finally {
      db.close();
    }
  });

  it("a queued turn_derivation success missing one expected write rolls back and leaves the item live", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = manualSdk(double);
    registerTestingWork(sdk, {
      dispatchers: {
        "turns.deriveTurn": async (run, item) => {
          const disposition = applyDerivationSuccess(
            run.openDb(),
            {
              sourceVersion: item.sourceVersion,
              derivations: item.derivations,
              workItemId: item.workItemId,
              claimEpoch: item.claimEpoch,
            },
            [
              {
                subjectKind: "turn",
                subjectId: "t1",
                derivationType: "turn_rendering",
                content: "partial rendering",
              },
            ],
            run.clock().toISOString(),
          );
          return { disposition };
        },
      },
    });
    const { filePath } = await newThread();
    await send(sdk, filePath, [validEvent("user_prompt"), validEvent("turn_end")]);
    await drain(sdk, filePath, { maxItems: 1 });

    const failed = await sdk.work.drain({ filePath });
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.error).toMatchObject({
      errorClass: "state_corruption",
      code: "derivation_completion_mismatch",
    });
    expect(failed.error.reason).toContain("derivation_completion_mismatch");

    const forms = readDerivedForms(filePath).filter((form) => form.subjectId === "t1");
    expect(forms.map((form) => [form.derivationType, form.state, form.content]).sort()).toEqual([
      ["smooth_turn_compression", "pending", undefined],
      ["turn_rendering", "pending", undefined],
    ]);
    expect(liveDetail(filePath)).toEqual([
      expect.objectContaining({
        workItemId: "w-t1-turn_derivation-v1",
        status: "claimed",
      }),
    ]);

    const db = openRaw(filePath);
    try {
      const members = db.prepare(`SELECT COUNT(*) AS n FROM chunk_member WHERE turn_id = 't1'`).get() as {
        n: number | bigint;
      };
      const summaries = db.prepare(`SELECT COUNT(*) AS n FROM work_item WHERE kind LIKE 'chunk_summary_%'`).get() as {
        n: number | bigint;
      };
      expect(Number(members.n)).toBe(0);
      expect(Number(summaries.n)).toBe(0);
    } finally {
      db.close();
    }
  });

  it("a stale queued terminal failure deletes owned work without stamping the newer derivation", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = manualSdk(double);
    const { filePath } = await newThread();
    await send(sdk, filePath, [validEvent("user_prompt")]);
    const db = openRaw(filePath);
    try {
      db.prepare(
        `UPDATE derivation
         SET source_version = 2
         WHERE subject_kind = 'message' AND subject_id = 'm1' AND derivation_type = 'smoothed_prompt'`,
      ).run();
    } finally {
      db.close();
    }

    double.failKind("prompt_smoothing", 1, { retryable: false, reason: "stale terminal failure" });
    const report = await drain(sdk, filePath);
    expect(report.ran[0]).toMatchObject({
      workItemId: "w-m1-prompt_smoothing-v1",
      disposition: "failed_terminal",
      reason: "stale terminal failure",
    });
    expect(liveCount(filePath)).toBe(0);
    expect(readDerivedForms(filePath)).toEqual([
      expect.objectContaining({
        subjectId: "m1",
        derivationType: "smoothed_prompt",
        state: "pending",
        sourceVersion: 2,
      }),
    ]);
    expect(readDerivedForms(filePath)[0]?.reason).toBeUndefined();
  });

  it("a queued terminal failure that hits only part of its targets rolls back and leaves the item live", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = manualSdk(double);
    const { filePath } = await newThread();
    await send(sdk, filePath, [validEvent("user_prompt"), validEvent("turn_end")]);
    await drain(sdk, filePath, { maxItems: 1 });

    const db = openRaw(filePath);
    try {
      db.prepare(
        `UPDATE derivation
         SET source_version = 2
         WHERE subject_kind = 'turn' AND subject_id = 't1' AND derivation_type = 'turn_rendering'`,
      ).run();
    } finally {
      db.close();
    }

    double.failKind("turn_rendering", 1, { retryable: false, reason: "partial terminal failure" });
    const failed = await sdk.work.drain({ filePath });
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.error).toMatchObject({
      errorClass: "state_corruption",
      code: "derivation_completion_mismatch",
    });
    expect(failed.error.reason).toContain("terminal partially hit 1 of 2 rows");

    const forms = readDerivedForms(filePath).filter((form) => form.subjectId === "t1");
    expect(forms.map((form) => [form.derivationType, form.state, form.reason, form.sourceVersion]).sort()).toEqual([
      ["smooth_turn_compression", "pending", undefined, 1],
      ["turn_rendering", "pending", undefined, 2],
    ]);
    expect(liveDetail(filePath)).toEqual([
      expect.objectContaining({
        workItemId: "w-t1-turn_derivation-v1",
        status: "claimed",
      }),
    ]);
  });

  it("an extra handler write target fails closed before any completion write lands", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = manualSdk(double);
    registerTestingWork(sdk, {
      dispatchers: {
        "messages.derive": async (run, item) => {
          const disposition = applyDerivationSuccess(
            run.openDb(),
            {
              sourceVersion: item.sourceVersion,
              derivations: item.derivations,
              workItemId: item.workItemId,
              claimEpoch: item.claimEpoch,
            },
            [
              {
                subjectKind: "message",
                subjectId: "m1",
                derivationType: "smoothed_prompt",
                content: "expected write",
              },
              {
                subjectKind: "message",
                subjectId: "m1",
                derivationType: "tool_result_summary",
                content: "extra write",
              },
            ],
            run.clock().toISOString(),
          );
          return { disposition };
        },
      },
    });
    const { filePath } = await newThread();
    await send(sdk, filePath, [validEvent("user_prompt")]);

    const failed = await sdk.work.drain({ filePath });
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.error).toMatchObject({
      errorClass: "state_corruption",
      code: "derivation_completion_mismatch",
    });
    expect(failed.error.reason).toContain("derivation_completion_mismatch");
    expect(readDerivedForms(filePath)).toEqual([
      expect.objectContaining({
        subjectId: "m1",
        derivationType: "smoothed_prompt",
        state: "pending",
      }),
    ]);
    expect(liveDetail(filePath)).toEqual([
      expect.objectContaining({
        workItemId: "w-m1-prompt_smoothing-v1",
        status: "claimed",
      }),
    ]);
  });
});

describe("sync derive collision policy", () => {
  it("messages.derive claims an exact queued head and refuses an unexpired exact claim", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = manualSdk(double, { clock: () => new Date("2026-06-10T12:00:00.000Z") });
    const { filePath } = await newThread();
    await send(sdk, filePath, [validEvent("user_prompt")]);

    const claimedQueued = await sdk.messages.derive({ filePath }, ["m1"]);
    expect(claimedQueued.ok).toBe(true);
    if (!claimedQueued.ok) return;
    expect(claimedQueued.value).toEqual([
      { messageId: "m1", outcome: "derived", derivationType: "smoothed_prompt", sourceVersion: 1 },
    ]);
    expect(readDerivedForms(filePath)[0]).toMatchObject({ state: "ready" });
    expect(liveCount(filePath)).toBe(0);

    const claimedThread = await newThread();
    await send(sdk, claimedThread.filePath, [validEvent("user_prompt")]);
    claimHeadWorkItem(claimedThread.filePath, "2026-06-10T12:05:00.000Z");

    const refusedClaimed = await sdk.messages.derive({ filePath: claimedThread.filePath }, ["m1"]);
    expect(refusedClaimed.ok).toBe(true);
    if (!refusedClaimed.ok) return;
    expect(refusedClaimed.value[0]).toMatchObject({
      messageId: "m1",
      outcome: "failed",
      error: {
        errorClass: "caller_error",
        code: "derivation_work_in_flight",
        reason: expect.stringContaining("prompt_smoothing work for message m1 at sourceVersion 1 is already live"),
      },
    });

    expireWorkItemClaim(claimedThread.filePath, "w-m1-prompt_smoothing-v1", "2026-06-10T11:59:59.000Z");
    const reclaimed = await sdk.messages.derive({ filePath: claimedThread.filePath }, ["m1"]);
    expect(reclaimed.ok).toBe(true);
    if (!reclaimed.ok) return;
    expect(reclaimed.value).toEqual([
      { messageId: "m1", outcome: "derived", derivationType: "smoothed_prompt", sourceVersion: 1 },
    ]);
    expect(readDerivedForms(claimedThread.filePath)[0]).toMatchObject({ state: "ready" });
    expect(liveCount(claimedThread.filePath)).toBe(0);
  });

  it("messages.derive preserves retry policy when it claims an existing queued item", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = manualSdk(double, {
      clock: () => new Date("2026-06-10T12:00:00.000Z"),
      retry: { budget: 3, backoffBaseMs: 1000, backoffCapMs: 60_000 },
    });
    const { filePath } = await newThread();
    await send(sdk, filePath, [validEvent("user_prompt")]);
    setWorkItemAttempts(filePath, "w-m1-prompt_smoothing-v1", 1);
    double.failKind("prompt_smoothing", 1, { retryable: true, reason: "timeout: sync takeover retry" });

    const result = await sdk.messages.derive({ filePath }, ["m1"]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]).toMatchObject({
      messageId: "m1",
      outcome: "failed",
      error: { errorClass: "system_error", code: "derivation_retry_scheduled", reason: "timeout: sync takeover retry" },
    });
    expect(liveDetail(filePath)).toEqual([
      expect.objectContaining({
        workItemId: "w-m1-prompt_smoothing-v1",
        status: "queued",
        attempts: 2,
        lastError: "timeout: sync takeover retry",
        eligibleAt: "2026-06-10T12:00:04.000Z",
      }),
    ]);
    expect(readDerivedForms(filePath)[0]).toMatchObject({
      subjectId: "m1",
      derivationType: "smoothed_prompt",
      state: "pending",
      sourceVersion: 1,
    });
  });

  it("messages.derive retry after expired-claim recovery preserves claim_epoch and attempt accounting", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = manualSdk(double, {
      clock: () => new Date("2026-06-10T12:00:00.000Z"),
      retry: { budget: 5, backoffBaseMs: 0, backoffCapMs: 0 },
    });
    const { filePath } = await newThread();
    await send(sdk, filePath, [validEvent("user_prompt")]);
    claimHeadWorkItem(filePath, "2026-06-10T11:59:59.000Z");
    double.failKind("prompt_smoothing", 1, { retryable: true, reason: "timeout: expired claim retry" });

    const result = await sdk.messages.derive({ filePath }, ["m1"]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]).toMatchObject({
      messageId: "m1",
      outcome: "failed",
      error: { errorClass: "system_error", code: "derivation_retry_scheduled", reason: "timeout: expired claim retry" },
    });
    expect(liveDetail(filePath)).toEqual([
      expect.objectContaining({
        workItemId: "w-m1-prompt_smoothing-v1",
        status: "queued",
        attempts: 2,
        claimEpoch: 2,
        lastError: "timeout: expired claim retry",
        eligibleAt: "2026-06-10T12:00:00.000Z",
      }),
    ]);
  });

  it("messages.derive refuses when the derivation advances after its initial read", async () => {
    let advanceOnClock = false;
    let filePath = "";
    const double = createInferenceCallbacksDouble();
    const sdk = manualSdk(double, {
      clock: () => {
        if (advanceOnClock) {
          advanceOnClock = false;
          const db = openRaw(filePath);
          try {
            db.prepare(
              `UPDATE derivation
               SET state = 'ready', content = 'newer completion', source_version = 2
               WHERE subject_kind = 'message' AND subject_id = 'm1' AND derivation_type = 'smoothed_prompt'`,
            ).run();
          } finally {
            db.close();
          }
        }
        return new Date("2026-06-10T12:00:00.000Z");
      },
    });
    ({ filePath } = await newThread());
    await send(sdk, filePath, [validEvent("user_prompt")]);
    deleteWorkItem(filePath, "w-m1-prompt_smoothing-v1");

    advanceOnClock = true;
    const raced = await sdk.messages.derive({ filePath }, ["m1"]);

    expect(raced.ok).toBe(true);
    if (!raced.ok) return;
    expect(raced.value).toEqual([
      {
        messageId: "m1",
        outcome: "failed",
        error: expect.objectContaining({
          errorClass: "caller_error",
          code: "derivation_work_in_flight",
        }),
      },
    ]);
    expect(readDerivedForms(filePath)).toEqual([
      expect.objectContaining({
        subjectId: "m1",
        derivationType: "smoothed_prompt",
        state: "ready",
        content: "newer completion",
        sourceVersion: 2,
      }),
    ]);
    expect(liveDetail(filePath).map((item) => item.workItemId)).toEqual([]);
  });

  it("messages.derive refuses an exact expired head if the derivation boundary advanced before claim", async () => {
    let advanceOnClock = false;
    let filePath = "";
    const double = createInferenceCallbacksDouble();
    const captured = double.captureInputs();
    const sdk = manualSdk(double, {
      clock: () => {
        if (advanceOnClock) {
          advanceOnClock = false;
          setReadyDerivation(
            filePath,
            { subjectKind: "message", subjectId: "m1", derivationType: "smoothed_prompt" },
            "newer prompt",
            2,
          );
        }
        return new Date("2026-06-10T12:00:00.000Z");
      },
    });
    ({ filePath } = await newThread());
    await send(sdk, filePath, [validEvent("user_prompt")]);
    claimHeadWorkItem(filePath, "2026-06-10T11:59:59.000Z");

    advanceOnClock = true;
    const raced = await sdk.messages.derive({ filePath }, ["m1"]);

    expect(raced.ok).toBe(true);
    if (!raced.ok) return;
    expect(raced.value[0]).toMatchObject({
      messageId: "m1",
      outcome: "failed",
      error: { errorClass: "caller_error", code: "derivation_work_in_flight" },
    });
    expect(captured).toHaveLength(0);
    expect(readDerivedForms(filePath)[0]).toMatchObject({
      subjectId: "m1",
      derivationType: "smoothed_prompt",
      state: "ready",
      content: "newer prompt",
      sourceVersion: 2,
    });
    expect(liveDetail(filePath)).toEqual([
      expect.objectContaining({
        workItemId: "w-m1-prompt_smoothing-v1",
        status: "claimed",
        attempts: 0,
        claimEpoch: 1,
      }),
    ]);
  });

  it("messages.derive reports stale_discarded completion as in-flight instead of derived", async () => {
    let filePath = "";
    const base = createInferenceCallbacksDouble();
    const callbacks: InferenceCallbacks = {
      smoothPrompt: async () => {
        setReadyDerivation(
          filePath,
          { subjectKind: "message", subjectId: "m1", derivationType: "smoothed_prompt" },
          "newer prompt while handler ran",
          2,
        );
        return { ok: true, text: "stale prompt completion" };
      },
      summarizeToolResult: (input) => base.summarizeToolResult(input),
      composeTurnRendering: (input) => base.composeTurnRendering(input),
      compressSmoothTurn: (input) => base.compressSmoothTurn(input),
      summarizeChunkDetailed: (input) => base.summarizeChunkDetailed(input),
      summarizeChunkBrief: (input) => base.summarizeChunkBrief(input),
    };
    const sdk = manualSdk(callbacks, { clock: () => new Date("2026-06-10T12:00:00.000Z") });
    ({ filePath } = await newThread());
    await send(sdk, filePath, [validEvent("user_prompt")]);

    const raced = await sdk.messages.derive({ filePath }, ["m1"]);

    expect(raced.ok).toBe(true);
    if (!raced.ok) return;
    expect(raced.value[0]).toMatchObject({
      messageId: "m1",
      outcome: "failed",
      error: { errorClass: "caller_error", code: "derivation_work_in_flight" },
    });
    expect(readDerivedForms(filePath)[0]).toMatchObject({
      subjectId: "m1",
      derivationType: "smoothed_prompt",
      state: "ready",
      content: "newer prompt while handler ran",
      sourceVersion: 2,
    });
    expect(liveCount(filePath)).toBe(0);
  });

  it("turns.deriveTurn refuses an abandoned later turn while older turn_derivation work is queued", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = manualSdk(double);
    const { filePath } = await newThread();
    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "first prompt" } }),
      validEvent("assistant_text", { payload: { text: "first answer" } }),
      validEvent("turn_end"),
      validEvent("user_prompt", { payload: { text: "second prompt" } }),
      validEvent("assistant_text", { payload: { text: "second answer" } }),
      validEvent("turn_end"),
    ]);
    deleteWorkItem(filePath, "w-m1-prompt_smoothing-v1");
    const db = openRaw(filePath);
    try {
      db.prepare(`DELETE FROM work_item WHERE kind = 'prompt_smoothing'`).run();
    } finally {
      db.close();
    }
    deleteWorkItem(filePath, "w-t2-turn_derivation-v1");

    const refused = await sdk.turns.deriveTurn({ filePath }, "t2");

    expect(refused.ok).toBe(true);
    if (!refused.ok) return;
    expect(refused.value).toMatchObject({
      turnId: "t2",
      outcome: "failed",
      error: { errorClass: "caller_error", code: "derivation_work_in_flight" },
    });
    expect(liveDetail(filePath)).toEqual([
      expect.objectContaining({
        workItemId: "w-t1-turn_derivation-v1",
        status: "queued",
      }),
      expect.objectContaining({
        workItemId: "w-t2-turn_derivation-v1",
        status: "queued",
      }),
    ]);
    expect(
      readDerivedForms(filePath)
        .filter((form) => form.subjectId === "t2")
        .map((form) => [form.derivationType, form.state, form.sourceVersion])
        .sort(),
    ).toEqual([
      ["smooth_turn_compression", "pending", 1],
      ["turn_rendering", "pending", 1],
    ]);
  });

  it("turns.deriveTurn refuses an exact head when one of its two derivations advances before claim", async () => {
    let advanceOnClock = false;
    let filePath = "";
    const double = createInferenceCallbacksDouble();
    const captured = double.captureInputs();
    const sdk = manualSdk(double, {
      clock: () => {
        if (advanceOnClock) {
          advanceOnClock = false;
          setReadyDerivation(
            filePath,
            { subjectKind: "turn", subjectId: "t1", derivationType: "smooth_turn_compression" },
            "newer compression",
            2,
          );
        }
        return new Date("2026-06-10T12:00:00.000Z");
      },
    });
    ({ filePath } = await newThread());
    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "turn boundary" } }),
      validEvent("assistant_text", { payload: { text: "answer" } }),
      validEvent("turn_end"),
    ]);
    deleteWorkItem(filePath, "w-m1-prompt_smoothing-v1");

    advanceOnClock = true;
    const raced = await sdk.turns.deriveTurn({ filePath }, "t1");

    expect(raced.ok).toBe(true);
    if (!raced.ok) return;
    expect(raced.value).toMatchObject({
      turnId: "t1",
      outcome: "failed",
      error: { errorClass: "caller_error", code: "derivation_work_in_flight" },
    });
    expect(captured).toHaveLength(0);
    expect(liveDetail(filePath)).toEqual([
      expect.objectContaining({
        workItemId: "w-t1-turn_derivation-v1",
        status: "queued",
        attempts: 0,
        claimEpoch: 0,
      }),
    ]);
    expect(
      readDerivedForms(filePath)
        .filter((form) => form.subjectId === "t1")
        .map((form) => [form.derivationType, form.state, form.content, form.sourceVersion])
        .sort(),
    ).toEqual([
      ["smooth_turn_compression", "ready", "newer compression", 2],
      ["turn_rendering", "pending", undefined, 1],
    ]);
  });

  it("two concurrent messages.derive calls share the durable claim", async () => {
    const base = createInferenceCallbacksDouble();
    const smoothCalls: Array<{ resolve: (result: InferenceResult) => void }> = [];
    const callbacks: InferenceCallbacks = {
      smoothPrompt: () => new Promise((resolve) => smoothCalls.push({ resolve })),
      summarizeToolResult: (input) => base.summarizeToolResult(input),
      composeTurnRendering: (input) => base.composeTurnRendering(input),
      compressSmoothTurn: (input) => base.compressSmoothTurn(input),
      summarizeChunkDetailed: (input) => base.summarizeChunkDetailed(input),
      summarizeChunkBrief: (input) => base.summarizeChunkBrief(input),
    };
    const sdk = manualSdk(callbacks);
    const { filePath } = await newThread();
    await send(sdk, filePath, [validEvent("user_prompt", { payload: { text: "claim me" } })]);
    deleteWorkItem(filePath, "w-m1-prompt_smoothing-v1");

    const first = sdk.messages.derive({ filePath }, ["m1"]);
    await until(() => smoothCalls.length === 1, "first sync message derive claim");
    const second = await sdk.messages.derive({ filePath }, ["m1"]);
    smoothCalls[0]?.resolve({ ok: true, text: "owned message completion" });
    const owned = await first;

    expect(second.ok).toBe(true);
    expect(owned.ok).toBe(true);
    if (!second.ok || !owned.ok) return;
    expect(second.value).toEqual([
      {
        messageId: "m1",
        outcome: "failed",
        error: expect.objectContaining({
          errorClass: "caller_error",
          code: "derivation_work_in_flight",
        }),
      },
    ]);
    expect(owned.value).toEqual([
      { messageId: "m1", outcome: "derived", derivationType: "smoothed_prompt", sourceVersion: 1 },
    ]);
    expect(readDerivedForms(filePath)).toEqual([
      expect.objectContaining({
        subjectId: "m1",
        derivationType: "smoothed_prompt",
        state: "ready",
        content: "owned message completion",
      }),
    ]);
    expect(liveCount(filePath)).toBe(0);
  });

  it("two concurrent turns.deriveTurn calls share the durable claim", async () => {
    const base = createInferenceCallbacksDouble();
    const compressionCalls: Array<{ resolve: (result: InferenceResult) => void }> = [];
    const callbacks: InferenceCallbacks = {
      smoothPrompt: (input) => base.smoothPrompt(input),
      summarizeToolResult: (input) => base.summarizeToolResult(input),
      composeTurnRendering: (input) => base.composeTurnRendering(input),
      compressSmoothTurn: () => new Promise((resolve) => compressionCalls.push({ resolve })),
      summarizeChunkDetailed: (input) => base.summarizeChunkDetailed(input),
      summarizeChunkBrief: (input) => base.summarizeChunkBrief(input),
    };
    const sdk = manualSdk(callbacks);
    const { filePath } = await newThread();
    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "turn claim" } }),
      validEvent("assistant_text", { payload: { text: "answer" } }),
      validEvent("turn_end"),
    ]);
    deleteWorkItem(filePath, "w-m1-prompt_smoothing-v1");
    deleteWorkItem(filePath, "w-t1-turn_derivation-v1");

    const first = sdk.turns.deriveTurn({ filePath }, "t1");
    await until(() => compressionCalls.length === 1, "first sync turn derive claim");
    const second = await sdk.turns.deriveTurn({ filePath }, "t1");
    compressionCalls[0]?.resolve({ ok: true, text: "owned turn compression" });
    const owned = await first;

    expect(second.ok).toBe(true);
    expect(owned.ok).toBe(true);
    if (!second.ok || !owned.ok) return;
    expect(second.value).toMatchObject({
      turnId: "t1",
      outcome: "failed",
      error: { errorClass: "caller_error", code: "derivation_work_in_flight" },
    });
    expect(owned.value).toEqual({ turnId: "t1", outcome: "derived", sourceVersion: 1 });
    const turnForms = readDerivedForms(filePath).filter((form) => form.subjectId === "t1");
    expect(turnForms.map((form) => [form.derivationType, form.state, form.content]).sort()).toEqual([
      ["smooth_turn_compression", "ready", "owned turn compression"],
      ["turn_rendering", "ready", expect.stringContaining("turn claim")],
    ]);
    expect(liveDetail(filePath).filter((item) => item.workItemId === "w-t1-turn_derivation-v1")).toEqual([]);
  });

  it("two concurrent turns.deriveBriefChunk calls share the durable claim", async () => {
    const base = createInferenceCallbacksDouble();
    const briefCalls: Array<{ resolve: (result: InferenceResult) => void }> = [];
    const callbacks: InferenceCallbacks = {
      smoothPrompt: (input) => base.smoothPrompt(input),
      summarizeToolResult: (input) => base.summarizeToolResult(input),
      composeTurnRendering: (input) => base.composeTurnRendering(input),
      compressSmoothTurn: (input) => base.compressSmoothTurn(input),
      summarizeChunkDetailed: (input) => base.summarizeChunkDetailed(input),
      summarizeChunkBrief: () => new Promise((resolve) => briefCalls.push({ resolve })),
    };
    const sdk = manualSdk(callbacks);
    const { filePath } = await newThread();
    insertAbandonedChunkSummary(filePath, "c1", "chunk_summary_brief");

    const first = sdk.turns.deriveBriefChunk({ filePath }, "c1");
    await until(() => briefCalls.length === 1, "first sync chunk derive claim");
    const second = await sdk.turns.deriveBriefChunk({ filePath }, "c1");
    briefCalls[0]?.resolve({ ok: true, text: "owned chunk brief" });
    const owned = await first;

    expect(second.ok).toBe(true);
    expect(owned.ok).toBe(true);
    if (!second.ok || !owned.ok) return;
    expect(second.value).toMatchObject({
      chunkId: "c1",
      outcome: "failed",
      error: { errorClass: "caller_error", code: "derivation_work_in_flight" },
    });
    expect(owned.value).toEqual({
      chunkId: "c1",
      outcome: "derived",
      derivationType: "chunk_summary_brief",
      sourceVersion: 1,
    });
    expect(readDerivedForms(filePath)).toEqual([
      expect.objectContaining({
        subjectKind: "chunk",
        subjectId: "c1",
        derivationType: "chunk_summary_brief",
        state: "ready",
        content: "owned chunk brief",
      }),
    ]);
    expect(liveCount(filePath)).toBe(0);
  });

  it("sync derive success is fenced by claim_epoch after a competing claim completes", async () => {
    const base = createInferenceCallbacksDouble();
    const smoothCalls: Array<{ resolve: (result: InferenceResult) => void }> = [];
    const callbacks: InferenceCallbacks = {
      smoothPrompt: () => new Promise((resolve) => smoothCalls.push({ resolve })),
      summarizeToolResult: (input) => base.summarizeToolResult(input),
      composeTurnRendering: (input) => base.composeTurnRendering(input),
      compressSmoothTurn: (input) => base.compressSmoothTurn(input),
      summarizeChunkDetailed: (input) => base.summarizeChunkDetailed(input),
      summarizeChunkBrief: (input) => base.summarizeChunkBrief(input),
    };
    const sdk = manualSdk(callbacks, { clock: () => new Date("2026-06-10T12:00:00.000Z") });
    const { filePath } = await newThread();
    await send(sdk, filePath, [validEvent("user_prompt", { payload: { text: "stale owner" } })]);
    deleteWorkItem(filePath, "w-m1-prompt_smoothing-v1");

    const staleOwner = sdk.messages.derive({ filePath }, ["m1"]);
    await until(() => smoothCalls.length === 1, "first sync message derive claim");
    expect(liveDetail(filePath)).toEqual([
      expect.objectContaining({
        workItemId: "w-m1-prompt_smoothing-v1",
        status: "claimed",
        claimEpoch: 1,
      }),
    ]);

    expireWorkItemClaim(filePath, "w-m1-prompt_smoothing-v1", "2026-06-10T11:59:59.000Z");
    claimHeadWorkItem(filePath, "2026-06-10T12:05:00.000Z");
    const competingClaim = liveDetail(filePath)[0];
    expect(competingClaim).toMatchObject({ workItemId: "w-m1-prompt_smoothing-v1", claimEpoch: 2 });
    const db = openRaw(filePath);
    try {
      applyDerivationSuccess(
        db,
        {
          sourceVersion: 1,
          derivations: [{ subjectKind: "message", subjectId: "m1", derivationType: "smoothed_prompt" }],
          workItemId: "w-m1-prompt_smoothing-v1",
          claimEpoch: 2,
        },
        [
          {
            subjectKind: "message",
            subjectId: "m1",
            derivationType: "smoothed_prompt",
            content: "competing completion",
          },
        ],
        "2026-06-10T12:00:01.000Z",
      );
    } finally {
      db.close();
    }

    smoothCalls[0]?.resolve({ ok: true, text: "stale completion" });
    const result = await staleOwner;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([
      {
        messageId: "m1",
        outcome: "failed",
        error: expect.objectContaining({
          errorClass: "caller_error",
          code: "derivation_work_in_flight",
        }),
      },
    ]);
    expect(readDerivedForms(filePath)[0]).toMatchObject({
      state: "ready",
      content: "competing completion",
    });
    expect(liveCount(filePath)).toBe(0);
  });
});
