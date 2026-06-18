// Story 1 (Epic 02): queue execution and drain — Flow 1, in-process half.
// Claim/lease mechanics, queue-order dispatch, retry/backoff with the
// head-gates-queue rule, terminal dispositions (reported then deleted, DD-1),
// unknown-kind handling, both host modes, and coalesced background
// scheduling. The cross-process legs (TC-1.3 kill, TC-1.4 claim exclusion,
// CLI parity) live in cli-process-work.test.ts.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  countLiveItems,
  createSdk,
  intakeStream,
  queueDetail,
  setSchedulerPoke,
  setThreadTouch,
  threads,
  type DrainReport,
  type Lhc,
  type MessageEventInput,
} from "../src/index.js";
import {
  createProviderDouble,
  openRaw,
  readDerivedForms,
  registerTestWorkHandlers,
  tempStore,
  validEvent,
  type TempStore,
  type ProviderDouble,
} from "./fixtures/index.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function send(
  sdk: Lhc,
  filePath: string,
  batch: readonly MessageEventInput[],
): Promise<void> {
  const result = await sdk.intakeStream.messageEvents({ filePath }, batch);
  if (!result.ok) throw new Error(`batch failed: ${result.error.reason}`);
}

function manualSdk(
  double: ProviderDouble,
  overrides: {
    clock?: () => Date;
    retry?: { budget: number; backoffBaseMs: number; backoffCapMs: number };
  } = {},
): Lhc {
  const sdk = createSdk({
    provider: double,
    mode: "manual",
    clock: overrides.clock ?? (() => new Date()),
    retry: overrides.retry ?? { budget: 3, backoffBaseMs: 0, backoffCapMs: 0 },
    lease: { durationMs: 200 },
  });
  registerTestWorkHandlers(sdk, double);
  return sdk;
}

async function drain(
  sdk: Lhc,
  filePath: string,
  opts?: { maxItems?: number },
): Promise<DrainReport> {
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

describe("TC-1.1: a drain runs queued items one at a time, in queue order, and reports each disposition", () => {
  it("three items across both owners run in order; rows are deleted at terminal transition; derivedAt is monotone", async () => {
    const double = createProviderDouble();
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
    expect(report.ran.map((entry) => entry.disposition)).toEqual([
      "done",
      "done",
      "done",
    ]);
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
    expect(forms.map((form) => form.state)).toEqual([
      "ready",
      "ready",
      "ready",
      "ready",
    ]);
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
    const double = createProviderDouble();
    double.delayKind("prompt_smoothing", 100);
    const sdk = createSdk({
      provider: double,
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
    const double = createProviderDouble();
    const sdk = createSdk({
      provider: double,
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

  it("reopening a thread with leftover queued rows recovers them when the process engages — message reads stay pure (Epic 04 DD-6)", async () => {
    // Build the leftover state with no background scheduler installed: rows
    // accumulate exactly as a dead process would have left them.
    const { filePath } = await newThread();
    const seeded = await intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt"),
      validEvent("turn_end"),
    ]);
    expect(seeded.ok).toBe(true);
    expect(liveCount(filePath)).toBe(2);

    const double = createProviderDouble();
    const sdk = createSdk({
      provider: double,
      mode: "background",
      retry: { budget: 3, backoffBaseMs: 0, backoffCapMs: 0 },
      lease: { durationMs: 1000 },
    });
    registerTestWorkHandlers(sdk, double);

    // First touch of the thread in this process lifetime is a read. Message
    // list/show are read-only (Epic 04 DD-6, SV-01-001): like thread-view's
    // pull/status before them, they suppress the open announcement, so the
    // read schedules no first-touch catch-up — the leftover rows stay exactly
    // as the dead process left them, and no provider call fires off a read.
    const read = await sdk.messages.listMessages({ filePath });
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
});

describe("TC-1.6 / AC-1.7: manual mode — rows accumulate durably and run only when drain is invoked", () => {
  it("queued work sits until work.drain; artifacts land after", async () => {
    const double = createProviderDouble();
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
    const double = createProviderDouble();
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
    const double = createProviderDouble();
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

  it("exhausts the budget: form failed with the final provider reason; the next item still ran; row deleted", async () => {
    const double = createProviderDouble();
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
    const double = createProviderDouble();
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

  it("a non-retryable provider failure is terminal immediately", async () => {
    const double = createProviderDouble();
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
    const double = createProviderDouble();
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
