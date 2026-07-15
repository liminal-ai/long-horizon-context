import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  countLiveItems,
  estimateTokens,
  initLhc,
  type Lhc,
  type ModelCall,
  type ModelCallInput,
  type ModelCallResult,
  messages,
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

function tokenText(minTokens: number): string {
  let text = "";
  while (estimateTokens(text) < minTokens) text += "guardword ";
  return text.trim();
}

function recordingModelCall(text: string): { call: ModelCall; log: ModelCallInput[] } {
  const log: ModelCallInput[] = [];
  return {
    log,
    call: (input): Promise<ModelCallResult> => {
      log.push(structuredClone(input));
      return Promise.resolve({ ok: true, text });
    },
  };
}

function sdkWithModelCall(
  modelText: string,
  config: Partial<Pick<SdkConfig, "guards">> = {},
): {
  sdk: Lhc;
  log: ModelCallInput[];
} {
  const host = recordingModelCall(modelText);
  return {
    log: host.log,
    sdk: initLhc({
      mode: "manual",
      inference: { call: host.call },
      lease: { durationMs: 200 },
      ...config,
    }),
  };
}

async function newThread(): Promise<string> {
  const created = await threads.newThread({
    filePath: store.threadPath(),
    registryPath: store.registryPath,
  });
  if (!created.ok) throw new Error(created.error.reason);
  return created.value.filePath;
}

async function sendPrompt(sdk: Lhc, filePath: string, text: string): Promise<void> {
  const result = await sdk.intakeStream.messageEvents({ filePath }, [validEvent("user_prompt", { payload: { text } })]);
  if (!result.ok) throw new Error(result.error.reason);
}

async function sendClosedTurn(sdk: Lhc, filePath: string, text: string): Promise<void> {
  const result = await sdk.intakeStream.messageEvents({ filePath }, [
    validEvent("user_prompt", { payload: { text } }),
    validEvent("assistant_text", { payload: { text: "answer" } }),
    validEvent("turn_end"),
  ]);
  if (!result.ok) throw new Error(result.error.reason);
}

async function drain(sdk: Lhc, filePath: string): Promise<void> {
  const drained = await sdk.work.drain({ filePath });
  if (!drained.ok) throw new Error(drained.error.reason);
}

function derivation(filePath: string) {
  return readDerivedForms(filePath).find((row) => row.subjectId === "m1" && row.derivationType === "smoothed_prompt");
}

function liveWorkCount(filePath: string): number {
  const db = openRaw(filePath);
  try {
    return countLiveItems(db);
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

describe("smoothed_prompt guard config", () => {
  it("uses the default 700-token cap and stores the cleaned floor as ready without inference", async () => {
    const prompt = tokenText(900);
    const modelText = tokenText(200);
    const { sdk, log } = sdkWithModelCall(modelText);
    const filePath = await newThread();

    await sendPrompt(sdk, filePath, prompt);
    await drain(sdk, filePath);

    expect(sdk.config.guards.smoothedPrompt?.maxInferenceTokens).toBe(700);
    expect(log).toHaveLength(0);
    expect(derivation(filePath)).toMatchObject({
      state: "ready",
      content: sdk.messages.cleanPrompt(prompt),
    });
    expect(derivation(filePath)?.metadata).toBeUndefined();
    expect(liveWorkCount(filePath)).toBe(0);
  });

  it("respects a custom cap from top-level SdkConfig.guards", async () => {
    const prompt = tokenText(600);
    const { sdk, log } = sdkWithModelCall(tokenText(200), {
      guards: { smoothedPrompt: { maxInferenceTokens: 500 } },
    });
    const filePath = await newThread();

    await sendPrompt(sdk, filePath, prompt);
    await drain(sdk, filePath);

    expect(sdk.config.guards.smoothedPrompt?.maxInferenceTokens).toBe(500);
    expect(log).toHaveLength(0);
    expect(derivation(filePath)).toMatchObject({
      state: "ready",
      content: sdk.messages.cleanPrompt(prompt),
    });
    expect(liveWorkCount(filePath)).toBe(0);
  });

  it("runs inference when the prompt is below the configured cap", async () => {
    const prompt = tokenText(600);
    const modelText = tokenText(200);
    const { sdk, log } = sdkWithModelCall(modelText, {
      guards: { smoothedPrompt: { maxInferenceTokens: 1000 } },
    });
    const filePath = await newThread();

    await sendPrompt(sdk, filePath, prompt);
    await drain(sdk, filePath);

    expect(log).toHaveLength(1);
    expect(derivation(filePath)).toMatchObject({
      state: "ready",
      content: modelText,
    });
  });

  it("discards suspiciously short smoothing output, stores discard metadata, and logs a warning", async () => {
    const prompt = tokenText(500);
    const shortModelText = tokenText(50);
    expect(estimateTokens(shortModelText)).toBeLessThan(0.15 * estimateTokens(messages.cleanPrompt(prompt)));
    const { sdk, log } = sdkWithModelCall(shortModelText);
    const filePath = await newThread();

    await sendPrompt(sdk, filePath, prompt);
    await drain(sdk, filePath);

    expect(log).toHaveLength(1);
    expect(derivation(filePath)).toMatchObject({
      state: "ready",
      content: sdk.messages.cleanPrompt(prompt),
      metadata: { discardReason: "suspicious_output_ratio" },
    });
    expect(liveWorkCount(filePath)).toBe(0);

    const logs = await sdk.logging.query(
      { filePath },
      { level: "warning", derivationType: "smoothed_prompt", subjectId: "m1" },
    );
    expect(logs.ok).toBe(true);
    if (!logs.ok) return;
    expect(logs.value).toEqual([
      expect.objectContaining({
        level: "warning",
        reason: "suspicious_output_ratio",
        floorUsed: sdk.messages.cleanPrompt(prompt),
      }),
    ]);
  });

  it("resolves guard defaults for direct-callback hosts", async () => {
    const double = createInferenceCallbacksDouble();
    const captured = double.captureInputs();
    const sdk = initLhc({
      mode: "manual",
      inferenceCallbacks: double,
      lease: { durationMs: 200 },
    });
    const filePath = await newThread();
    const prompt = tokenText(900);

    await sendPrompt(sdk, filePath, prompt);
    await drain(sdk, filePath);

    expect(sdk.config.guards.smoothedPrompt?.maxInferenceTokens).toBe(700);
    expect(captured.filter((entry) => entry.op === "smoothPrompt")).toEqual([]);
    expect(derivation(filePath)).toMatchObject({ state: "ready", content: sdk.messages.cleanPrompt(prompt) });
  });

  it("turn construction uses the guard cap for pending prompt smoothing", async () => {
    const double = createInferenceCallbacksDouble();
    const captured = double.captureInputs();
    const sdk = initLhc({
      mode: "manual",
      inferenceCallbacks: double,
      lease: { durationMs: 200 },
    });
    const filePath = await newThread();
    const prompt = tokenText(900);

    await sendClosedTurn(sdk, filePath, prompt);
    deleteWorkItem(filePath, "w-m1-prompt_smoothing-v1");
    const derived = await sdk.turns.deriveTurn({ filePath }, "t1");

    expect(derived.ok).toBe(true);
    expect(captured.filter((entry) => entry.op === "smoothPrompt")).toEqual([]);
    expect(derivation(filePath)).toMatchObject({ state: "ready", content: sdk.messages.cleanPrompt(prompt) });
    expect(liveWorkCount(filePath)).toBe(0);
  });

  it("turn construction preserves an already-ready smoothed_prompt without calling smoothing inference", async () => {
    const double = createInferenceCallbacksDouble();
    const captured = double.captureInputs();
    const sdk = initLhc({
      mode: "manual",
      inferenceCallbacks: double,
      lease: { durationMs: 200 },
    });
    const filePath = await newThread();
    const prompt = tokenText(500);

    await sendClosedTurn(sdk, filePath, prompt);
    deleteWorkItem(filePath, "w-m1-prompt_smoothing-v1");
    const db = openRaw(filePath);
    try {
      db.prepare(
        `UPDATE derivation
         SET state = 'ready', content = ?, reason = NULL, metadata = NULL, derived_at = ?
         WHERE subject_kind = 'message'
           AND subject_id = 'm1'
           AND derivation_type = 'smoothed_prompt'`,
      ).run("competing ready value", "2026-06-22T12:00:00.000Z");
    } finally {
      db.close();
    }
    const callsBeforeTurn = captured.length;
    const derived = await sdk.turns.deriveTurn({ filePath }, "t1");

    expect(derived.ok).toBe(true);
    expect(captured.slice(callsBeforeTurn).filter((entry) => entry.op === "smoothPrompt")).toEqual([]);
    expect(derivation(filePath)).toMatchObject({
      state: "ready",
      content: "competing ready value",
    });
    expect(derivation(filePath)?.metadata).toBeUndefined();
    const logs = await sdk.logging.query(
      { filePath },
      { level: "warning", derivationType: "smoothed_prompt", subjectId: "m1" },
    );
    expect(logs.ok).toBe(true);
    if (!logs.ok) return;
    expect(logs.value).toEqual([]);
  });
});

describe("marker prompt smoothing skip", () => {
  it("stores a bracketed marker prompt verbatim without calling inference", async () => {
    const { sdk, log } = sdkWithModelCall("should never be produced");
    const filePath = await newThread();

    await sendPrompt(sdk, filePath, "[Request interrupted by user]");
    await drain(sdk, filePath);

    expect(log).toHaveLength(0);
    expect(derivation(filePath)).toMatchObject({
      state: "ready",
      content: "[Request interrupted by user]",
    });
    expect(derivation(filePath)?.metadata).toBeUndefined();
    expect(liveWorkCount(filePath)).toBe(0);
  });

  it("skips inference for a marker with surrounding whitespace", async () => {
    const { sdk, log } = sdkWithModelCall("should never be produced");
    const filePath = await newThread();

    await sendPrompt(sdk, filePath, "  [Request interrupted by user for tool use]\n");
    await drain(sdk, filePath);

    expect(log).toHaveLength(0);
    expect(derivation(filePath)).toMatchObject({
      state: "ready",
      content: "[Request interrupted by user for tool use]",
    });
  });

  it("still smooths a prompt that merely contains brackets", async () => {
    const modelText = "please fix the flaky test in ci.yml";
    const { sdk, log } = sdkWithModelCall(modelText);
    const filePath = await newThread();

    await sendPrompt(sdk, filePath, "please fix the [flaky] test in ci.yml, it keeps failing intermittently on main");
    await drain(sdk, filePath);

    expect(log).toHaveLength(1);
    expect(derivation(filePath)).toMatchObject({
      state: "ready",
      content: modelText,
    });
  });

  it("still smooths when brackets wrap more than eighty characters", async () => {
    const inner = "x".repeat(100);
    const modelText = "long bracketed content smoothed";
    const { sdk, log } = sdkWithModelCall(modelText);
    const filePath = await newThread();

    await sendPrompt(sdk, filePath, `[${inner}]`);
    await drain(sdk, filePath);

    expect(log).toHaveLength(1);
    expect(derivation(filePath)).toMatchObject({ state: "ready", content: modelText });
  });
});
