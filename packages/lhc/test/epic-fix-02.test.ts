import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  countLiveItems,
  initLhc,
  type Lhc,
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

async function newThread(name: string): Promise<string> {
  const created = await threads.newThread({
    filePath: store.threadPath(name),
    registryPath: store.registryPath,
  });
  if (!created.ok) throw new Error(`thread creation failed: ${created.error.reason}`);
  return created.value.filePath;
}

function sdkFor(inferenceCallbacks: InferenceCallbacksDouble, mode: SdkConfig["mode"]): Lhc {
  return initLhc({ tokenFamily: "o200k", inferenceCallbacks, mode, lease: { durationMs: 1000 } });
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

describe("EPIC-02-BLOCK-001: a manual SDK never auto-drains alongside a background SDK", () => {
  it("background-then-manual on different threads: the manual thread's rows stay queued until explicit drain", async () => {
    const bgDouble = createInferenceCallbacksDouble();
    const sdkBg = sdkFor(bgDouble, "background");
    const manDouble = createInferenceCallbacksDouble();
    const sdkMan = sdkFor(manDouble, "manual");

    const threadB = await newThread("bg");
    const threadM = await newThread("man");

    const queued = await sdkMan.intakeStream.messageEvents({ filePath: threadM }, [validEvent("user_prompt")]);
    expect(queued.ok).toBe(true);

    const bgBatch = await sdkBg.intakeStream.messageEvents({ filePath: threadB }, [validEvent("user_prompt")]);
    expect(bgBatch.ok).toBe(true);
    await sdkBg.drainSettled({ filePath: threadB });

    await sleep(50);

    expect(liveCount(threadM)).toBe(1);
    expect(readDerivedForms(threadM).map((form) => form.state)).toEqual(["pending"]);

    expect(liveCount(threadB)).toBe(0);
    expect(readDerivedForms(threadB).map((form) => form.state)).toEqual(["ready"]);

    const report = await sdkMan.work.drain({ filePath: threadM });
    expect(report.ok).toBe(true);
    expect(liveCount(threadM)).toBe(0);
    expect(readDerivedForms(threadM).map((form) => form.state)).toEqual(["ready"]);
  });

  it("manual-then-background isolates the manual SDK the same way", async () => {
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

    const before = readDerivedForms(filePath);
    const resultBefore = before.find(
      (form) => form.subjectId === "m3" && form.derivationType === "tool_result_summary",
    );
    expect(resultBefore?.state).toBe("ready");
    const promptBefore = before.find((form) => form.subjectId === "m1" && form.derivationType === "smoothed_prompt");

    const result = await sdk.messages.remove({ filePath }, { messageId: "m3" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.dropped.map(formKey)).toEqual(["message/m3/tool_result_summary"]);

    const rebuild = await sdk.work.drain({ filePath });
    expect(rebuild.ok).toBe(true);
    const after = readDerivedForms(filePath);

    const promptAfter = after.find((form) => form.subjectId === "m1" && form.derivationType === "smoothed_prompt");
    expect(promptAfter).toEqual(promptBefore);
    expect(liveCount(filePath)).toBe(0);
  });
});

describe("FIX-2: consecutive tool activity groups into run parts", () => {
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

    const rendering = readDerivedForms(filePath).find(
      (f) => f.subjectId === "t1" && f.derivationType === "turn_rendering",
    );
    const runText = rendering?.content ?? "";
    const runHeaders = [...runText.matchAll(/\[tool run · [^\]]+\]/g)].map((match) => match[0]);
    expect(runHeaders).toHaveLength(2);
    expect(runHeaders[0]).toContain("2 calls");
    expect(runHeaders[1]).toContain("1 call");
    expect(rendering?.metadata).toBeUndefined();
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

    const rendering = readDerivedForms(filePath).find(
      (f) => f.subjectId === "t1" && f.derivationType === "turn_rendering",
    );
    const runText = rendering?.content ?? "";
    expect(runText).toContain("[tool run · edit_file · 2 calls · 1 succeeded, 1 failed]");
    expect(rendering?.metadata).toBeUndefined();
  });
});

describe("FIX-3.3: a claimed summary for a deleted message discards on completion", () => {
  it.skip("completing the straggler after the delete discards as stale_discarded; tombstone and cascade stand", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = sdkFor(double, "manual");
    const filePath = await newThread("straggler");
    const batch = await sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: "prompt" } }),
      validEvent("tool_call", { payload: { toolCallId: "k", toolName: "run_cmd", arguments: {} } }),
      validEvent("tool_result", {
        payload: { toolCallId: "k", content: "ok ".repeat(1500), isError: false },
      }),
      validEvent("turn_end"),
    ]);
    expect(batch.ok).toBe(true);

    double.delayKind("tool_result_summary", 400);
    const captured = double.captureInputs();
    const drainPromise = sdk.work.drain({ filePath });
    await until(
      () => captured.some((c) => c.op === "summarizeToolResult"),
      "m3's tool_result_summary to be claimed and in-handler",
    );

    const deleted = await sdk.messages.remove({ filePath }, { messageId: "m3" });
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(deleted.value.dropped.map(formKey)).toContain("message/m3/tool_result_summary");

    const drained = await drainPromise;
    expect(drained.ok).toBe(true);
    if (!drained.ok) return;
    const m3Item = drained.value.ran.find((r) => r.workItemId === "w-m3-tool_result_summary-v1");
    expect(m3Item?.disposition).toBe("stale_discarded");

    const listed = await sdk.messages.list({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.map((m) => m.messageId)).not.toContain("m3");
    expect(readDerivedForms(filePath).some((f) => f.subjectId === "m3")).toBe(false);
    expect(liveCount(filePath)).toBe(0);
  });
});
