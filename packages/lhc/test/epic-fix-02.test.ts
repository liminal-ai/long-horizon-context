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
  store.cleanup();
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
