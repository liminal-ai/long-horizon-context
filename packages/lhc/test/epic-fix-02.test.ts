// Epic 02 Fix Batch 001 — Green-phase regression suite for the canonical
// epic review's two blockers (impl-lead ruling epic-fix-001). New file: the
// Red-committed suites stay byte-identical except mutations-delete.test.ts
// TC-6.2, whose cascade-scope assertion the BLOCK-002b ruling corrects (and
// whose manifest hash was re-recorded to bless that one change).
//
//   - EPIC-02-BLOCK-001: per-SDK-instance poke/touch scoping — a manual SDK
//     never auto-drains, regardless of construction order, even with a live
//     background SDK in the same process on a different thread.
//   - EPIC-02-BLOCK-002a/b: the call/result pair is a source dependency — a
//     deleted tool_result re-queues its paired tool_call's summary, which
//     rebuilds outcome `unknown` because the deleted-read filter excludes the
//     dead result; unrelated summaries are untouched.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  countLiveItems,
  initLhc,
  type Lhc,
  queueDetail,
  type SdkConfig,
  setSchedulerPoke,
  setThreadTouch,
  threads,
} from "../src/index.js";
import {
  createInferenceCallbacksDouble,
  type InferenceCallbacksDouble,
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
  // Background-mode SDKs install the below-SDK default seams at construction;
  // tests must not leak them into each other.
  setSchedulerPoke(null);
  setThreadTouch(null);
  store.cleanup();
});

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

function liveDetail(filePath: string): ReturnType<typeof queueDetail> {
  const db = openRaw(filePath);
  try {
    return queueDetail(db);
  } finally {
    db.close();
  }
}

async function newThread(name: string): Promise<string> {
  const created = await threads.newThread({
    filePath: store.threadPath(name),
    registryPath: store.registryPath,
  });
  if (!created.ok) throw new Error(`thread creation failed: ${created.error.reason}`);
  return created.value.filePath;
}

function sdkFor(inferenceCallbacks: InferenceCallbacksDouble, mode: SdkConfig["mode"]): Lhc {
  return initLhc({
    inferenceCallbacks,
    mode,
    retry: { budget: 3, backoffBaseMs: 0, backoffCapMs: 0 },
    lease: { durationMs: 1000 },
  });
}

function liveCount(filePath: string): number {
  const db = openRaw(filePath);
  try {
    return countLiveItems(db);
  } finally {
    db.close();
  }
}

function formKey(entry: { subjectKind: string; subjectId: string; derivationType: string }): string {
  return `${entry.subjectKind}/${entry.subjectId}/${entry.derivationType}`;
}

// ── EPIC-02-BLOCK-001: per-SDK-instance scheduler seam ────────────
describe("EPIC-02-BLOCK-001: a manual SDK never auto-drains alongside a background SDK", () => {
  it("background-then-manual on different threads: the manual thread's rows stay queued until explicit drain", async () => {
    // Construction order is the regression: the background SDK installs the
    // below-SDK default seam first; the manual SDK must still isolate its own
    // operations to a no-op so its queued work never auto-drains.
    const bgDouble = createInferenceCallbacksDouble();
    const sdkBg = sdkFor(bgDouble, "background");
    const manDouble = createInferenceCallbacksDouble();
    const sdkMan = sdkFor(manDouble, "manual");

    const threadB = await newThread("bg");
    const threadM = await newThread("man");

    // Manual SDK queues smoothing work on its own thread.
    const queued = await sdkMan.intakeStream.messageEvents({ filePath: threadM }, [validEvent("user_prompt")]);
    expect(queued.ok).toBe(true);

    // Positive control: the background SDK does drive its own thread — proving
    // its scheduler is live, not merely inert.
    const bgBatch = await sdkBg.intakeStream.messageEvents({ filePath: threadB }, [validEvent("user_prompt")]);
    expect(bgBatch.ok).toBe(true);
    await sdkBg.drainSettled({ filePath: threadB });

    // Give any erroneous background drain of the manual thread a chance to run
    // (a background drain defers one macrotask).
    await sleep(50);

    // The manual thread's rows stayed queued — never poked, never touched, so
    // never auto-drained (AC-1.7).
    expect(liveCount(threadM)).toBe(1);
    expect(readDerivedForms(threadM).map((form) => form.state)).toEqual(["pending"]);

    // The background thread WAS processed without an explicit drain (AC-1.5).
    expect(liveCount(threadB)).toBe(0);
    expect(readDerivedForms(threadB).map((form) => form.state)).toEqual(["ready"]);

    // Explicit drain finally runs the manual thread's accumulated work.
    const report = await sdkMan.work.drain({ filePath: threadM });
    expect(report.ok).toBe(true);
    expect(liveCount(threadM)).toBe(0);
    expect(readDerivedForms(threadM).map((form) => form.state)).toEqual(["ready"]);
  });

  it("manual-then-background isolates the manual SDK the same way", async () => {
    // The reverse order: the manual SDK exists first, the background SDK
    // installs the default seam afterward; the manual SDK's operations still
    // deliver to its own no-op seam, not the freshly installed default.
    const manDouble = createInferenceCallbacksDouble();
    const sdkMan = sdkFor(manDouble, "manual");
    const bgDouble = createInferenceCallbacksDouble();
    const sdkBg = sdkFor(bgDouble, "background");
    expect(sdkBg.scheduler.mode).toBe("background");

    const threadM = await newThread("man");
    const queued = await sdkMan.intakeStream.messageEvents({ filePath: threadM }, [validEvent("user_prompt")]);
    expect(queued.ok).toBe(true);

    await sleep(50);
    expect(liveCount(threadM)).toBe(1);
    expect(readDerivedForms(threadM).map((form) => form.state)).toEqual(["pending"]);
  });
});

// ── EPIC-02-BLOCK-002a/b: pair counterpart joins the cascade ──────
describe("EPIC-02-BLOCK-002: the call/result pair is a source dependency", () => {
  async function toolRunThread(sdk: Lhc): Promise<string> {
    const filePath = await newThread("toolrun");
    const batch = await sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt"),
      validEvent("tool_call"),
      validEvent("tool_result"),
      validEvent("assistant_text"),
      validEvent("turn_end"),
    ]);
    expect(batch.ok).toBe(true);
    const drained = await sdk.work.drain({ filePath });
    expect(drained.ok).toBe(true);
    return filePath;
  }

  it("deleting a tool_result drops only its tool-result summary", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = sdkFor(double, "manual");
    const filePath = await toolRunThread(sdk);

    // Before: the result summary and the control prompt smoothing are ready.
    const before = readDerivedForms(filePath);
    const resultBefore = before.find(
      (form) => form.subjectId === "m3" && form.derivationType === "tool_result_summary",
    );
    expect(resultBefore?.state).toBe("ready");
    const promptBefore = before.find((form) => form.subjectId === "m1" && form.derivationType === "smoothed_prompt");

    // Delete the tool_result (m3). Tool calls no longer have summaries, so no
    // paired call summary is cleared or re-queued.
    const result = await sdk.messages.remove({ filePath }, { messageId: "m3" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.dropped.map(formKey)).toEqual(["message/m3/tool_result_summary"]);
    expect(result.value.cleared.map(formKey)).not.toContain("message/m2/tool_call_summary");
    expect(result.value.queued.map((item) => item.kind)).not.toContain("tool_call_summary");

    const rebuild = await sdk.work.drain({ filePath });
    expect(rebuild.ok).toBe(true);
    const after = readDerivedForms(filePath);

    // Control: the unrelated prompt smoothing is byte-stable.
    const promptAfter = after.find((form) => form.subjectId === "m1" && form.derivationType === "smoothed_prompt");
    expect(promptAfter).toEqual(promptBefore);
    expect(liveCount(filePath)).toBe(0);
  });
});

// ── Fix 1 (P2): background backoff stall — the scheduler wakes for eligible_at ─
describe("FIX-1: background mode honors the backoff eligibility gate", () => {
  it("a retryable failure backs off, the scheduler wakes on its own, and the retry completes", async () => {
    const double = createInferenceCallbacksDouble();
    const captured = double.captureInputs();
    double.failNext(1, { retryable: true });
    const sdk = initLhc({
      inferenceCallbacks: double,
      mode: "background",
      retry: { budget: 3, backoffBaseMs: 25, backoffCapMs: 60000 },
      lease: { durationMs: 1000 },
    });
    const filePath = await newThread("wake");

    const batch = await sdk.intakeStream.messageEvents({ filePath }, [validEvent("user_prompt")]);
    expect(batch.ok).toBe(true);
    const startedAt = Date.now();

    // No explicit drain and no poke after the failure: only the scheduler's own
    // backoff wake can run the retry. drainSettled spans it (the wake counts as
    // unsettled), so awaiting it awaits the retry.
    await sdk.drainSettled({ filePath });
    const elapsed = Date.now() - startedAt;

    // The form derived on the second attempt — the retry actually ran.
    expect(readDerivedForms(filePath).map((f) => `${f.subjectId}/${f.derivationType}/${f.state}`)).toEqual([
      "m1/smoothed_prompt/ready",
    ]);
    // Two model calls = attempts 2 (fail, then succeed).
    expect(captured.filter((c) => c.op === "smoothPrompt")).toHaveLength(2);
    // The wake honored eligibility: it fired no earlier than the backoff delay.
    expect(elapsed).toBeGreaterThanOrEqual(25);
    expect(liveCount(filePath)).toBe(0);
  });

  it("does not retry before eligible_at: the durable gate holds, no retry in the window", async () => {
    const double = createInferenceCallbacksDouble();
    const captured = double.captureInputs();
    double.failNext(1, { retryable: true });
    const sdk = initLhc({
      inferenceCallbacks: double,
      mode: "background",
      // A long backoff parks the head far past the window we observe.
      retry: { budget: 3, backoffBaseMs: 60000, backoffCapMs: 60000 },
      lease: { durationMs: 1000 },
    });
    const filePath = await newThread("noearly");

    const batch = await sdk.intakeStream.messageEvents({ filePath }, [validEvent("user_prompt")]);
    expect(batch.ok).toBe(true);

    // Let the first (failing) pass run and arm the wake, then wait through a
    // window far shorter than the backoff.
    await sleep(120);

    // Exactly one attempt — the retry has NOT run before eligible_at, the form
    // is still pending behind the backing-off head.
    expect(captured.filter((c) => c.op === "smoothPrompt")).toHaveLength(1);
    expect(readDerivedForms(filePath).map((f) => f.state)).toEqual(["pending"]);
    const detail = liveDetail(filePath);
    expect(detail[0]?.status).toBe("queued");
    expect(detail[0]?.attempts).toBe(1);
    expect(Date.parse(detail[0]?.eligibleAt ?? "")).toBeGreaterThan(Date.now());
  });
});

// ── Fix 2 (P2): tool activity composes into grouped run parts (AC-3.4) ────────
describe("FIX-2: consecutive tool activity groups into run parts and run receipts", () => {
  it("prompt, call, result, call, result, text, call, result → exactly two run parts (sizes 2 and 1)", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = sdkFor(double, "manual");
    const filePath = await newThread("grouping");
    const call = (id: string) =>
      validEvent("tool_call", {
        payload: { toolCallId: id, toolName: "run_cmd", arguments: { id } },
      });
    const result = (id: string) =>
      validEvent("tool_result", { payload: { toolCallId: id, content: `out ${id}`, isError: false } });

    const batch = await sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: "do work" } }),
      call("a"),
      result("a"),
      call("b"),
      result("b"),
      validEvent("assistant_text", { payload: { text: "mid-turn note" } }),
      call("c"),
      result("c"),
      validEvent("turn_end"),
    ]);
    expect(batch.ok).toBe(true);
    expect((await sdk.work.drain({ filePath })).ok).toBe(true);

    // prompt | runA | assistant text | runB — two outcome-bearing run receipts,
    // anchored at the run's first tool message, not one receipt per tool message.
    const rendering = readDerivedForms(filePath).find(
      (f) => f.subjectId === "t1" && f.derivationType === "turn_rendering",
    );
    const receipts = rendering?.metadata?.receipts;
    expect(receipts).toHaveLength(2);
    expect(receipts?.map((r) => r.messageId)).toEqual(["m2", "m7"]);
    expect(receipts?.map((r) => r.outcome)).toEqual(["succeeded", "succeeded"]);
    expect(receipts?.[0]?.account).toContain("2 calls");
    expect(receipts?.[1]?.account).toContain("1 call");
  });

  it("a mixed-outcome run stays explicit and names the failure", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = sdkFor(double, "manual");
    const filePath = await newThread("mixed");
    const batch = await sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: "edit two" } }),
      validEvent("tool_call", {
        payload: { toolCallId: "ok", toolName: "edit_file", arguments: { path: "ok.txt" } },
      }),
      validEvent("tool_result", {
        payload: { toolCallId: "ok", content: "edited ok.txt", isError: false },
      }),
      validEvent("tool_call", {
        payload: { toolCallId: "bad", toolName: "edit_file", arguments: { path: "ro.txt" } },
      }),
      validEvent("tool_result", {
        payload: { toolCallId: "bad", content: "permission denied", isError: true },
      }),
      validEvent("turn_end"),
    ]);
    expect(batch.ok).toBe(true);
    expect((await sdk.work.drain({ filePath })).ok).toBe(true);

    const receipts = readDerivedForms(filePath).find(
      (f) => f.subjectId === "t1" && f.derivationType === "turn_rendering",
    )?.metadata?.receipts;
    expect(receipts).toHaveLength(1);
    const receipt = receipts?.[0];
    // The run reads failed at run level because one call failed; the account
    // keeps the success explicit (never collapsed) and names the failed result.
    expect(receipt?.outcome).toBe("failed");
    expect(receipt?.account).toContain("1 succeeded, 1 failed");
    const failedResult = readDerivedForms(filePath).find(
      (f) => f.subjectId === "m5" && f.derivationType === "tool_result_summary",
    )?.content;
    expect(receipt?.account).toContain(`${failedResult} ⇒ failed`);
  });
});

// ── Fix 3.3 (P3): a stale claimed item for a deleted target discards ──────────
describe("FIX-3.3: a claimed summary for a deleted message discards on completion", () => {
  it("completing the straggler after the delete discards as stale_discarded; tombstone and cascade stand", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = sdkFor(double, "manual");
    const filePath = await newThread("straggler");
    const batch = await sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: "prompt" } }),
      validEvent("tool_call", { payload: { toolCallId: "k", toolName: "run_cmd", arguments: {} } }),
      validEvent("tool_result", {
        payload: { toolCallId: "k", content: "ok ".repeat(100), isError: false },
      }),
      validEvent("turn_end"),
    ]);
    expect(batch.ok).toBe(true);

    // Hold m3's tool_result_summary in flight: the drain claims it, the handler
    // awaits the delayed double, and the delete lands inside that window.
    double.delayKind("tool_result_summary", 400);
    const captured = double.captureInputs();
    const drainPromise = sdk.work.drain({ filePath });
    await until(
      () => captured.some((c) => c.op === "summarizeToolResult"),
      "m3's tool_result_summary to be claimed and in-handler",
    );

    // Delete m3 (the tool_result) while its summary item is claimed. Its own form
    // drops; the claimed item is left to the version check (DD-3).
    const deleted = await sdk.messages.remove({ filePath }, { messageId: "m3" });
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(deleted.value.dropped.map(formKey)).toContain("message/m3/tool_result_summary");

    const drained = await drainPromise;
    expect(drained.ok).toBe(true);
    if (!drained.ok) return;
    // The straggler completion is reported stale_discarded — not an error, not a
    // retry.
    const m3Item = drained.value.ran.find((r) => r.workItemId === "w-m3-tool_result_summary-v1");
    expect(m3Item?.disposition).toBe("stale_discarded");

    // Tombstone intact: m3 is gone from the live read and its summary form was
    // not resurrected by the stale completion.
    const listed = await sdk.messages.list({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.map((m) => m.messageId)).not.toContain("m3");
    expect(readDerivedForms(filePath).some((f) => f.subjectId === "m3")).toBe(false);
    // Cascade stands: the counterpart re-queue and the turn rebuild drained
    // clean behind the discarded straggler.
    expect(liveCount(filePath)).toBe(0);
  });
});
