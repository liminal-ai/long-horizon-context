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
  createSdk,
  queueDetail,
  setSchedulerPoke,
  setThreadTouch,
  threads,
  type Lhc,
  type SdkConfig,
} from "../src/index.js";
import {
  createProviderDouble,
  openRaw,
  readDerivedForms,
  tempStore,
  validEvent,
  type ProviderDouble,
  type TempStore,
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

function sdkFor(provider: ProviderDouble, mode: SdkConfig["mode"]): Lhc {
  return createSdk({
    provider,
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

function formKey(form: { subjectKind: string; subjectId: string; form: string }): string {
  return `${form.subjectKind}/${form.subjectId}/${form.form}`;
}

// ── EPIC-02-BLOCK-001: per-SDK-instance scheduler seam ────────────
describe("EPIC-02-BLOCK-001: a manual SDK never auto-drains alongside a background SDK", () => {
  it("background-then-manual on different threads: the manual thread's rows stay queued until explicit drain", async () => {
    // Construction order is the regression: the background SDK installs the
    // below-SDK default seam first; the manual SDK must still isolate its own
    // operations to a no-op so its queued work never auto-drains.
    const bgDouble = createProviderDouble();
    const sdkBg = sdkFor(bgDouble, "background");
    const manDouble = createProviderDouble();
    const sdkMan = sdkFor(manDouble, "manual");

    const threadB = await newThread("bg");
    const threadM = await newThread("man");

    // Manual SDK queues smoothing work on its own thread.
    const queued = await sdkMan.intakeStream.messageEvents({ filePath: threadM }, [
      validEvent("user_prompt"),
    ]);
    expect(queued.ok).toBe(true);

    // Positive control: the background SDK does drive its own thread — proving
    // its scheduler is live, not merely inert.
    const bgBatch = await sdkBg.intakeStream.messageEvents({ filePath: threadB }, [
      validEvent("user_prompt"),
    ]);
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
    const manDouble = createProviderDouble();
    const sdkMan = sdkFor(manDouble, "manual");
    const bgDouble = createProviderDouble();
    const sdkBg = sdkFor(bgDouble, "background");
    expect(sdkBg.scheduler.mode).toBe("background");

    const threadM = await newThread("man");
    const queued = await sdkMan.intakeStream.messageEvents({ filePath: threadM }, [
      validEvent("user_prompt"),
    ]);
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

  it("deleting a tool_result re-queues the paired tool_call summary; it rebuilds outcome unknown", async () => {
    const double = createProviderDouble();
    const sdk = sdkFor(double, "manual");
    const filePath = await toolRunThread(sdk);

    // Before: m2's call summary derived with a real outcome (the result is
    // present and clean), and the control prompt smoothing is ready at v1.
    const before = readDerivedForms(filePath);
    const callBefore = before.find(
      (form) => form.subjectId === "m2" && form.form === "tool_call_summary",
    );
    expect(callBefore?.state).toBe("ready");
    expect(callBefore?.sourceVersion).toBe(1);
    expect(callBefore?.metadata?.outcome).toBe("succeeded");
    const promptBefore = before.find(
      (form) => form.subjectId === "m1" && form.form === "smoothed_prompt",
    );

    // Delete the tool_result (m3). The pair counterpart (m2) joins the cascade.
    const result = await sdk.messages.deleteMessage({ filePath }, { messageId: "m3" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.dropped.map(formKey)).toEqual(["message/m3/tool_result_summary"]);
    expect(result.value.cleared.map(formKey)).toContain("message/m2/tool_call_summary");
    expect(result.value.queued.map((item) => item.workItemId)).toContain(
      "w-m2-tool_call_summary-v2",
    );

    // After rebuild: the call summary is ready at the bumped version, and its
    // outcome reverts to `unknown` — the deleted-read filter (BLOCK-002a)
    // excludes the dead result, so the call derives no pair.
    const rebuild = await sdk.work.drain({ filePath });
    expect(rebuild.ok).toBe(true);
    const after = readDerivedForms(filePath);
    const callAfter = after.find(
      (form) => form.subjectId === "m2" && form.form === "tool_call_summary",
    );
    expect(callAfter?.state).toBe("ready");
    expect(callAfter?.sourceVersion).toBe(2);
    expect(callAfter?.metadata?.outcome).toBe("unknown");

    // Control: the unrelated prompt smoothing is byte-stable, source version
    // included — the cascade reaches the pair, nothing else.
    const promptAfter = after.find(
      (form) => form.subjectId === "m1" && form.form === "smoothed_prompt",
    );
    expect(promptAfter).toEqual(promptBefore);
    expect(liveCount(filePath)).toBe(0);
  });
});

// ── Fix 1 (P2): background backoff stall — the scheduler wakes for eligible_at ─
describe("FIX-1: background mode honors the backoff eligibility gate", () => {
  it("a retryable failure backs off, the scheduler wakes on its own, and the retry completes", async () => {
    const double = createProviderDouble();
    const captured = double.captureInputs();
    double.failNext(1, { retryable: true });
    const sdk = createSdk({
      provider: double,
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
    expect(readDerivedForms(filePath).map((f) => `${f.subjectId}/${f.form}/${f.state}`)).toEqual([
      "m1/smoothed_prompt/ready",
    ]);
    // Two provider calls = attempts 2 (fail, then succeed).
    expect(captured.filter((c) => c.op === "smoothPrompt")).toHaveLength(2);
    // The wake honored eligibility: it fired no earlier than the backoff delay.
    expect(elapsed).toBeGreaterThanOrEqual(25);
    expect(liveCount(filePath)).toBe(0);
  });

  it("does not retry before eligible_at: the durable gate holds, no retry in the window", async () => {
    const double = createProviderDouble();
    const captured = double.captureInputs();
    double.failNext(1, { retryable: true });
    const sdk = createSdk({
      provider: double,
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
    const double = createProviderDouble();
    const captured = double.captureInputs();
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

    const composed = captured.filter((c) => c.op === "composeTurnRendering");
    expect(composed).toHaveLength(1);
    const parts = (
      composed[0]?.input as { parts: Array<{ messageId: string; text: string; outcome?: string }> }
    ).parts;
    // prompt | runA | assistant text | runB — two outcome-bearing run parts,
    // anchored at the run's first tool message, not one part per tool message.
    expect(parts.map((p) => p.messageId)).toEqual(["m1", "m2", "m6", "m7"]);
    const runParts = parts.filter((p) => p.outcome !== undefined);
    expect(runParts).toHaveLength(2);
    // Sizes 2 and 1: run A groups two calls, run B one.
    expect(runParts[0]?.text).toContain("2 calls");
    expect(runParts[1]?.text).toContain("1 call");
    // The summaries live inside the run accounts, not as standalone parts: the
    // rendering carries no one-entry-per-tool-message segment.
    const rendering = readDerivedForms(filePath).find(
      (f) => f.subjectId === "t1" && f.form === "turn_rendering",
    );
    const receipts = rendering?.metadata?.receipts;
    expect(receipts).toHaveLength(2);
    expect(receipts?.map((r) => r.outcome)).toEqual(["succeeded", "succeeded"]);
  });

  it("a mixed-outcome run stays explicit and names the failure", async () => {
    const double = createProviderDouble();
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
      (f) => f.subjectId === "t1" && f.form === "turn_rendering",
    )?.metadata?.receipts;
    expect(receipts).toHaveLength(1);
    const receipt = receipts?.[0];
    // The run reads failed at run level because one call failed; the account
    // keeps the success explicit (never collapsed) and names the failed result.
    expect(receipt?.outcome).toBe("failed");
    expect(receipt?.account).toContain("1 succeeded, 1 failed");
    const failedResult = readDerivedForms(filePath).find(
      (f) => f.subjectId === "m5" && f.form === "tool_result_summary",
    )?.content;
    expect(receipt?.account).toContain(`${failedResult} ⇒ failed`);
  });
});

// ── REVERIFY-02-001: cascadeTurnDelete cascades to a cross-turn pair ──────────
describe("REVERIFY-02-001: cascadeTurnDelete clears a cross-turn pair counterpart", () => {
  it("deleting the turn holding a late result reverts the earlier turn's call summary to unknown", async () => {
    const double = createProviderDouble();
    const sdk = sdkFor(double, "manual");
    const filePath = await newThread("crossturn");

    // t1: a tool_call whose result has not arrived — its summary derives unknown.
    const b1 = await sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: "call now" } }),
      validEvent("tool_call", { payload: { toolCallId: "x", toolName: "run_cmd", arguments: {} } }),
      validEvent("turn_end"),
    ]);
    expect(b1.ok).toBe(true);
    expect((await sdk.work.drain({ filePath })).ok).toBe(true);
    const callV1 = readDerivedForms(filePath).find(
      (f) => f.subjectId === "m2" && f.form === "tool_call_summary",
    );
    expect(callV1?.state).toBe("ready");
    expect(callV1?.metadata?.outcome).toBe("unknown");

    // t2: the paired result lands in a LATER (prompt-initiated) turn. Its
    // intake re-queues m2's call summary (AC-2.8 cross-turn), rebuilt 'succeeded'.
    const b2 = await sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: "and the result" } }),
      validEvent("tool_result", { payload: { toolCallId: "x", content: "done", isError: false } }),
      validEvent("turn_end"),
    ]);
    expect(b2.ok).toBe(true);
    expect((await sdk.work.drain({ filePath })).ok).toBe(true);
    const callV2 = readDerivedForms(filePath).find(
      (f) => f.subjectId === "m2" && f.form === "tool_call_summary",
    );
    expect(callV2?.state).toBe("ready");
    expect(callV2?.metadata?.outcome).toBe("succeeded");
    expect(callV2?.sourceVersion).toBe(2);

    // Delete t2 (the result's turn). REVERIFY-02-001: the cross-turn counterpart
    // m2 joins the cascade — its call summary clears and re-queues.
    const deleted = await sdk.turns.deleteTurn({ filePath }, { turnId: "t2" });
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(deleted.value.cleared.map(formKey)).toContain("message/m2/tool_call_summary");
    expect(deleted.value.queued.map((q) => q.workItemId)).toContain("w-m2-tool_call_summary-v3");

    // Rebuild: with the result gone (deleted-read filter), the call derives no
    // pair — its outcome reverts to unknown.
    expect((await sdk.work.drain({ filePath })).ok).toBe(true);
    const callV3 = readDerivedForms(filePath).find(
      (f) => f.subjectId === "m2" && f.form === "tool_call_summary",
    );
    expect(callV3?.state).toBe("ready");
    expect(callV3?.metadata?.outcome).toBe("unknown");
    expect(callV3?.sourceVersion).toBe(3);
    expect(liveCount(filePath)).toBe(0);
  });
});

// ── Fix 3.3 (P3): a stale claimed item for a deleted target discards ──────────
describe("FIX-3.3: a claimed summary for a deleted message discards on completion", () => {
  it("completing the straggler after the delete discards as stale_discarded; tombstone and cascade stand", async () => {
    const double = createProviderDouble();
    const sdk = sdkFor(double, "manual");
    const filePath = await newThread("straggler");
    const batch = await sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: "prompt" } }),
      validEvent("tool_call", { payload: { toolCallId: "k", toolName: "run_cmd", arguments: {} } }),
      validEvent("tool_result", { payload: { toolCallId: "k", content: "ok", isError: false } }),
      validEvent("turn_end"),
    ]);
    expect(batch.ok).toBe(true);

    // Hold m2's tool_call_summary in flight: the drain claims it, the handler
    // awaits the delayed double, and the delete lands inside that window.
    double.delayKind("tool_call_summary", 400);
    const captured = double.captureInputs();
    const drainPromise = sdk.work.drain({ filePath });
    await until(
      () => captured.some((c) => c.op === "summarizeToolCall"),
      "m2's tool_call_summary to be claimed and in-handler",
    );

    // Delete m2 (the tool_call) while its summary item is claimed. Its own form
    // drops; the claimed item is left to the version check (DD-3).
    const deleted = await sdk.messages.deleteMessage({ filePath }, { messageId: "m2" });
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(deleted.value.dropped.map(formKey)).toContain("message/m2/tool_call_summary");

    const drained = await drainPromise;
    expect(drained.ok).toBe(true);
    if (!drained.ok) return;
    // The straggler completion is reported stale_discarded — not an error, not a
    // retry.
    const m2Item = drained.value.ran.find((r) => r.workItemId === "w-m2-tool_call_summary-v1");
    expect(m2Item?.disposition).toBe("stale_discarded");

    // Tombstone intact: m2 is gone from the live read and its summary form was
    // not resurrected by the stale completion.
    const listed = await sdk.messages.listMessages({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.map((m) => m.messageId)).not.toContain("m2");
    expect(readDerivedForms(filePath).some((f) => f.subjectId === "m2")).toBe(false);
    // Cascade stands: the counterpart re-queue and the turn rebuild drained
    // clean behind the discarded straggler.
    expect(liveCount(filePath)).toBe(0);
  });
});
