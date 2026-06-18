import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  countLiveItems,
  initLhc,
  deterministicText,
  estimateTokens,
  messages,
  queueDetail,
  threads,
  type InferenceCallbacks,
  type Lhc,
  type MessageEventInput,
  type SdkConfig,
} from "../src/index.js";
import {
  createInferenceCallbacksDouble,
  openRaw,
  readDerivedForms,
  tempStore,
  validEvent,
  type TempStore,
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

function sdkFor(
  inferenceCallbacks: InferenceCallbacks,
  overrides: Partial<Pick<SdkConfig, "retry" | "smoothing">> = {},
): Lhc {
  const config: SdkConfig = {
    inferenceCallbacks,
    mode: "manual",
    retry: overrides.retry ?? { budget: 3, backoffBaseMs: 0, backoffCapMs: 0 },
    lease: { durationMs: 200 },
  };
  if (overrides.smoothing !== undefined) config.smoothing = overrides.smoothing;
  return initLhc(config);
}

async function send(
  sdk: Lhc,
  filePath: string,
  batch: readonly MessageEventInput[],
): Promise<void> {
  const result = await sdk.intakeStream.messageEvents({ filePath }, batch);
  if (!result.ok) throw new Error(result.error.reason);
}

async function drain(sdk: Lhc, filePath: string, opts?: { maxItems?: number }) {
  const result = await sdk.work.drain({ filePath }, opts);
  if (!result.ok) throw new Error(result.error.reason);
  return result.value;
}

function formOf(filePath: string, subjectId: string, derivationType: string) {
  return readDerivedForms(filePath).find(
    (form) => form.subjectId === subjectId && form.derivationType === derivationType,
  );
}

function deleteWorkItem(filePath: string, workItemId: string): void {
  const db = openRaw(filePath);
  try {
    db.prepare(`DELETE FROM work_item WHERE work_item_id = ?`).run(workItemId);
  } finally {
    db.close();
  }
}

describe("Flow 1: deterministic prompt smoothing and length gate", () => {
  it("cleans every prompt before inference and invokes smoothPrompt only under the cap", async () => {
    const double = createInferenceCallbacksDouble();
    const captured = double.captureInputs();
    const sdk = sdkFor(double);
    const filePath = await newThread();
    const text = "  please\t\t smooth\n\n\n this   prompt because i need it  ";
    const cleaned = "please smooth\n\nthis prompt because I need it";

    await send(sdk, filePath, [validEvent("user_prompt", { payload: { text } })]);
    await drain(sdk, filePath);

    expect(captured).toEqual([{ op: "smoothPrompt", input: { text: cleaned } }]);
    expect(formOf(filePath, "m1", "smoothed_prompt")).toMatchObject({
      state: "ready",
      content: deterministicText("smoothPrompt", { text: cleaned }, cleaned),
    });
  });

  it("skips inference over the cap but still stores the deterministic floor as ready", async () => {
    const double = createInferenceCallbacksDouble();
    const captured = double.captureInputs();
    const sdk = sdkFor(double, { smoothing: { maxInferenceTokens: 1 } });
    const filePath = await newThread();
    const fenced = "```ts\n\tconst  i = 1;\n\n\t\treturn  i;\n```";
    const text = `  hello    world  \n${fenced}\n  because i asked  `.repeat(8);
    const cleaned = messages.cleanPrompt(text);

    await send(sdk, filePath, [validEvent("user_prompt", { payload: { text } })]);
    await drain(sdk, filePath);

    expect(captured).toEqual([]);
    expect(formOf(filePath, "m1", "smoothed_prompt")).toMatchObject({
      state: "ready",
      content: cleaned,
    });
    expect(formOf(filePath, "m1", "smoothed_prompt")?.content).toContain(fenced);
  });

  it("keeps the cap boundary strict: equal runs inference, above skips", async () => {
    const equalDouble = createInferenceCallbacksDouble();
    const equalCaptured = equalDouble.captureInputs();
    const overDouble = createInferenceCallbacksDouble();
    const overCaptured = overDouble.captureInputs();
    const text = "one two three four five six seven eight nine ten";
    const tokenCount = estimateTokens(text);

    const equalSdk = sdkFor(equalDouble, { smoothing: { maxInferenceTokens: tokenCount } });
    const equalFile = await newThread();
    await send(equalSdk, equalFile, [validEvent("user_prompt", { payload: { text } })]);
    await drain(equalSdk, equalFile);

    const overSdk = sdkFor(overDouble, { smoothing: { maxInferenceTokens: tokenCount - 1 } });
    const overFile = await newThread();
    await send(overSdk, overFile, [validEvent("user_prompt", { payload: { text } })]);
    await drain(overSdk, overFile);

    expect(equalCaptured.map((entry) => entry.op)).toEqual(["smoothPrompt"]);
    expect(overCaptured).toEqual([]);
  });

  it("does not call inference callbacks during intake; intake only queues smoothing work", async () => {
    const double = createInferenceCallbacksDouble();
    const captured = double.captureInputs();
    const sdk = sdkFor(double);
    const filePath = await newThread();

    const result = await sdk.intakeStream.messageEvents(
      { filePath },
      [validEvent("user_prompt", { payload: { text: "please smooth later" } })],
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(captured).toEqual([]);
    expect(result.value.queuedWork).toEqual([
      {
        workItemId: "w-m1-prompt_smoothing-v1",
        owner: "messages",
        kind: "prompt_smoothing",
        sourceRef: { messageId: "m1" },
      },
    ]);
  });

  it("preserves fenced code through the inference path while cleaning prose", async () => {
    const double = createInferenceCallbacksDouble();
    const fenced = "```ts\n\tconst  i = 1;\n\n\t\treturn  i;\n```";
    const promptText = `plz\t\t fix this\n${fenced}\nthx`;
    let inferenceCallbackInput: string | undefined;
    const callbacks: InferenceCallbacks = {
      smoothPrompt: (i) => {
        inferenceCallbackInput = i.text;
        return Promise.resolve({ ok: true, text: `Please fix this.\n${fenced}\nThanks.` });
      },
      summarizeToolResult: (i) => double.summarizeToolResult(i),
      composeTurnRendering: (i) => double.composeTurnRendering(i),
      compressSmoothTurn: (i) => double.compressSmoothTurn(i),
      summarizeChunkDetailed: (i) => double.summarizeChunkDetailed(i),
      summarizeChunkBrief: (i) => double.summarizeChunkBrief(i),
    };
    const sdk = sdkFor(callbacks);
    const filePath = await newThread();

    await send(sdk, filePath, [
      validEvent("user_prompt", {
        payload: { text: promptText },
      }),
    ]);
    await drain(sdk, filePath);

    expect(inferenceCallbackInput).toBe(`plz fix this\n${fenced}\nthx`);
    expect(formOf(filePath, "m1", "smoothed_prompt")?.content).toBe(
      `Please fix this.\n${fenced}\nThanks.`,
    );
  });
});

describe("Flow 1: pending and failed smoothing recovery inputs", () => {
  it("retryable smoothing failure leaves the derivation pending and requeued", async () => {
    const double = createInferenceCallbacksDouble();
    double.failKind("prompt_smoothing", 1, {
      retryable: true,
      reason: "temporary inference callback failure",
    });
    const sdk = sdkFor(double, {
      retry: { budget: 3, backoffBaseMs: 60_000, backoffCapMs: 60_000 },
    });
    const filePath = await newThread();

    await send(sdk, filePath, [validEvent("user_prompt", { payload: { text: "retry me" } })]);
    const report = await drain(sdk, filePath);

    expect(report.stoppedBecause).toBe("waiting");
    expect(formOf(filePath, "m1", "smoothed_prompt")).toMatchObject({ state: "pending" });
    const db = openRaw(filePath);
    try {
      expect(queueDetail(db)).toEqual([
        expect.objectContaining({
          workItemId: "w-m1-prompt_smoothing-v1",
          kind: "prompt_smoothing",
          status: "queued",
          attempts: 1,
          lastError: "temporary inference callback failure",
        }),
      ]);
    } finally {
      db.close();
    }
  });

  it("pending smoothing is consumed through turn recovery and persisted ready when no live work remains", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = sdkFor(double);
    const filePath = await newThread();
    const text = "  raw     prompt because i asked  ";
    const floor = "raw prompt because I asked";

    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text } }),
      validEvent("assistant_text", { payload: { text: "answer" } }),
      validEvent("turn_end"),
    ]);
    deleteWorkItem(filePath, "w-m1-prompt_smoothing-v1");
    await drain(sdk, filePath);

    const rendering = formOf(filePath, "t1", "turn_rendering");
    expect(rendering?.content).toContain(deterministicText("smoothPrompt", { text: floor }, floor));
    expect(formOf(filePath, "m1", "smoothed_prompt")).toMatchObject({
      state: "ready",
      content: deterministicText("smoothPrompt", { text: floor }, floor),
    });
    expect(rendering?.state).toBe("ready");
  });

  it("terminal smoothing failure lands failed with reason, then turn composition consumes the floor", async () => {
    const double = createInferenceCallbacksDouble();
    double.failKind("prompt_smoothing", 99, {
      retryable: true,
      reason: "scripted exhaustion",
    });
    const sdk = sdkFor(double);
    const filePath = await newThread();
    const text = "  failed     prompt because i asked  ";
    const floor = "failed prompt because I asked";

    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text } }),
      validEvent("assistant_text", { payload: { text: "answer" } }),
      validEvent("turn_end"),
    ]);
    const report = await drain(sdk, filePath);

    expect(report.ran).toContainEqual(
      expect.objectContaining({
        workItemId: "w-m1-prompt_smoothing-v1",
        disposition: "failed_terminal",
        attempts: 3,
        reason: "scripted exhaustion",
      }),
    );
    expect(formOf(filePath, "m1", "smoothed_prompt")).toMatchObject({ state: "ready" });
    const rendering = formOf(filePath, "t1", "turn_rendering");
    expect(rendering?.content).toContain(floor);
    expect(rendering?.state).toBe("ready");
  });

  it("cleanPrompt is pure for deterministic recovery floors", () => {
    const input = "  please\tfix this because i need it\n\n\nnow  ";
    expect(messages.cleanPrompt(input)).toBe("please fix this because I need it\n\nnow");
    expect(messages.cleanPrompt(input)).toBe(messages.cleanPrompt(input));
    const fenced = "```ts\n\tconst  i = 1;\n\n\t\treturn  i;\n```";
    expect(messages.cleanPrompt(`  please\tfix\n${fenced}\n because i asked  `)).toBe(
      `please fix\n${fenced}\nbecause I asked`,
    );
  });

  it("over-cap deterministic smoothing leaves no live queue items", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = sdkFor(double, { smoothing: { maxInferenceTokens: 1 } });
    const filePath = await newThread();

    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "hello world ".repeat(50) } }),
    ]);
    await drain(sdk, filePath);

    const db = openRaw(filePath);
    try {
      expect(countLiveItems(db)).toBe(0);
    } finally {
      db.close();
    }
  });
});
