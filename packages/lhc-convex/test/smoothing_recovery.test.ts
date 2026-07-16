// Flow 1: deterministic prompt smoothing, the length gate, and pending/failed
// recovery floors, ported to the component. The cleaned text that reaches
// inference is read from the fake host's captured rendered call; the stored
// floor and turn-composition recovery are read through the drain path.
//
// The frozen suite's per-drain `report.ran` disposition assertions
// (failed_terminal, workItemId) have no analog: the component's DrainReport is
// an aggregate count, not a per-item ledger. The behavioral core — failed
// smoothing recovered by turn composition — is asserted directly on the forms.
import { beforeEach, describe, expect, test } from "vitest";
import type { Lhc, MessageEventInput } from "../src/client/index.js";
import { PROMPT_REGISTRY, type PromptTemplate } from "../src/shared/prompts/index.js";
import { cleanPrompt } from "../src/shared/smoothing.js";
import { estimateTokens } from "../src/shared/token_counting/index.js";
import { capturedCalls, resetCapturedCalls } from "./convex/model.js";
import { serviceFixture, validEvent } from "./fixtures/index.js";

type Fixture = ReturnType<typeof serviceFixture>;

function renderByName(name: string, input: unknown): unknown {
  return (PROMPT_REGISTRY[name] as PromptTemplate<unknown> | undefined)?.render(input);
}

beforeEach(() => {
  resetCapturedCalls();
});

async function newThread(fixture: Fixture): Promise<string> {
  return (await fixture.createThread()).filePath;
}

async function send(sdk: Lhc, filePath: string, batch: readonly MessageEventInput[]) {
  const result = await sdk.intakeStream.messageEvents({ filePath }, batch);
  if (!result.ok) throw new Error(result.error.reason);
  return result.value;
}

async function drain(sdk: Lhc, filePath: string): Promise<void> {
  const drained = await sdk.work.drain({ filePath });
  if (!drained.ok) throw new Error(drained.error.reason);
}

async function messageForm(sdk: Lhc, filePath: string, subjectId: string, derivationType: string) {
  const report = await sdk.messages.report({ filePath }, { messageId: subjectId });
  if (!report.ok) throw new Error(report.error.reason);
  return report.value.find((form) => form.derivationType === derivationType);
}

async function turnForm(sdk: Lhc, filePath: string, turnId: string, derivationType: string) {
  const report = await sdk.turns.report({ filePath }, { turnId });
  if (!report.ok) throw new Error(report.error.reason);
  return report.value.find((form) => form.derivationType === derivationType);
}

async function deleteSmoothingItem(fixture: Fixture): Promise<void> {
  await fixture.test.run(async (ctx) => {
    const rows = await ctx.db.query("workItems").collect();
    const row = rows.find((item) => item.instance === fixture.instance && item.kind === "prompt_smoothing");
    if (row === undefined) throw new Error("no prompt_smoothing work item to delete");
    await ctx.db.delete("workItems", row._id);
  });
}

async function liveWorkCount(fixture: Fixture): Promise<number> {
  return await fixture.test.run(async (ctx) => {
    const rows = await ctx.db.query("workItems").collect();
    return rows.filter((row) => row.instance === fixture.instance).length;
  });
}

describe("Flow 1: deterministic prompt smoothing and length gate", () => {
  test("cleans every prompt before inference and invokes smoothing only under the cap", async () => {
    const fixture = serviceFixture({ models: { smoothed_prompt: "success:smoothed enough output text here" } });
    const filePath = await newThread(fixture);
    const text = "  please\t\t smooth\n\n\n this   prompt because i need it  ";
    const cleaned = "please smooth\n\nthis prompt because I need it";
    expect(cleanPrompt(text)).toBe(cleaned);

    await send(fixture.sdk, filePath, [validEvent("user_prompt", { payload: { text } })]);
    await drain(fixture.sdk, filePath);

    // Exactly one smoothing call, and it received the cleaned prompt: the
    // rendered messages are the smoothing template applied to the cleaned text.
    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0]?.messages).toEqual(renderByName("smoothing-v1", { text: cleaned }));
    expect(await messageForm(fixture.sdk, filePath, "m1", "smoothed_prompt")).toMatchObject({ state: "ready" });
  });

  test("skips inference over the cap but still stores the deterministic floor as ready", async () => {
    const fixture = serviceFixture({
      models: { smoothed_prompt: "success:never produced" },
      guards: { smoothedPrompt: { maxInferenceTokens: 1 } },
    });
    const filePath = await newThread(fixture);
    const fenced = "```ts\n\tconst  i = 1;\n\n\t\treturn  i;\n```";
    const text = `  hello    world  \n${fenced}\n  because i asked  `.repeat(8);
    const cleaned = cleanPrompt(text);

    await send(fixture.sdk, filePath, [validEvent("user_prompt", { payload: { text } })]);
    await drain(fixture.sdk, filePath);

    expect(capturedCalls).toHaveLength(0);
    const form = await messageForm(fixture.sdk, filePath, "m1", "smoothed_prompt");
    expect(form).toMatchObject({ state: "ready", content: cleaned });
    expect(form?.content).toContain(fenced);
  });

  test("keeps the cap boundary strict: equal runs inference, above skips", async () => {
    const text = "one two three four five six seven eight nine ten";
    const tokenCount = estimateTokens(text);

    const equal = serviceFixture({
      models: { smoothed_prompt: "success:equal boundary smoothed output text" },
      guards: { smoothedPrompt: { maxInferenceTokens: tokenCount } },
    });
    const equalFile = await newThread(equal);
    await send(equal.sdk, equalFile, [validEvent("user_prompt", { payload: { text } })]);
    await drain(equal.sdk, equalFile);

    const over = serviceFixture({
      models: { smoothed_prompt: "success:over boundary smoothed output text" },
      guards: { smoothedPrompt: { maxInferenceTokens: tokenCount - 1 } },
    });
    const overFile = await newThread(over);
    await send(over.sdk, overFile, [validEvent("user_prompt", { payload: { text } })]);
    await drain(over.sdk, overFile);

    // At the exact cap the model is called (provenance stamped); one token over
    // the cap the deterministic floor lands with no metadata.
    expect((await messageForm(equal.sdk, equalFile, "m1", "smoothed_prompt"))?.metadata?.provenance).toBeDefined();
    const overForm = await messageForm(over.sdk, overFile, "m1", "smoothed_prompt");
    expect(overForm?.state).toBe("ready");
    expect(overForm?.metadata).toBeUndefined();
  });

  test("does not call inference during intake; intake only queues smoothing work", async () => {
    const fixture = serviceFixture();
    const filePath = await newThread(fixture);

    const batch = await send(fixture.sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "please smooth later" } }),
    ]);

    expect(capturedCalls).toEqual([]);
    expect(batch.queuedWork).toEqual([
      {
        workItemId: "w1",
        owner: "messages",
        kind: "prompt_smoothing",
        sourceRef: { messageId: "m1" },
      },
    ]);
  });

  test("preserves fenced code through the inference path while cleaning prose", async () => {
    const fenced = "```ts\n\tconst  i = 1;\n\n\t\treturn  i;\n```";
    const promptText = `plz\t\t fix this\n${fenced}\nthx`;
    const modelOutput = `Please fix this.\n${fenced}\nThanks.`;
    const fixture = serviceFixture({ models: { smoothed_prompt: `success:${modelOutput}` } });
    const filePath = await newThread(fixture);

    await send(fixture.sdk, filePath, [validEvent("user_prompt", { payload: { text: promptText } })]);
    await drain(fixture.sdk, filePath);

    // The cleaned prose reaches inference with the fenced block intact.
    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0]?.messages).toEqual(renderByName("smoothing-v1", { text: `plz fix this\n${fenced}\nthx` }));
    expect((await messageForm(fixture.sdk, filePath, "m1", "smoothed_prompt"))?.content).toBe(modelOutput);
  });
});

describe("Flow 1: pending and failed smoothing recovery inputs", () => {
  test("pending smoothing uses a composition floor without re-running message inference", async () => {
    const fixture = serviceFixture({ models: { smoothed_prompt: "success:never produced" } });
    const filePath = await newThread(fixture);
    const text = "  raw     prompt because i asked  ";
    const floor = "raw prompt because I asked";

    await send(fixture.sdk, filePath, [
      validEvent("user_prompt", { payload: { text } }),
      validEvent("assistant_text", { payload: { text: "answer" } }),
      validEvent("turn_end"),
    ]);
    await deleteSmoothingItem(fixture);
    await drain(fixture.sdk, filePath);

    const rendering = await turnForm(fixture.sdk, filePath, "t1", "turn_rendering");
    expect(rendering?.content).toContain(floor);
    expect(rendering?.state).toBe("ready");
    expect(await messageForm(fixture.sdk, filePath, "m1", "smoothed_prompt")).toMatchObject({
      state: "ready",
      content: floor,
    });
    // Turn composition consumed the floor without a message-inference call.
    expect(capturedCalls).toHaveLength(0);
  });

  test("smoothing failure lands, then turn composition consumes the floor", async () => {
    const fixture = serviceFixture({ models: { smoothed_prompt: "fail" } });
    const filePath = await newThread(fixture);
    const text = "  failed     prompt because i asked  ";
    const floor = "failed prompt because I asked";

    await send(fixture.sdk, filePath, [
      validEvent("user_prompt", { payload: { text } }),
      validEvent("assistant_text", { payload: { text: "answer" } }),
      validEvent("turn_end"),
    ]);
    await drain(fixture.sdk, filePath);

    // The smoothing model failed, but turn composition recovers the prompt to a
    // ready floor and the rendering carries it.
    expect(await messageForm(fixture.sdk, filePath, "m1", "smoothed_prompt")).toMatchObject({ state: "ready" });
    const rendering = await turnForm(fixture.sdk, filePath, "t1", "turn_rendering");
    expect(rendering?.content).toContain(floor);
    expect(rendering?.state).toBe("ready");
  });

  test("cleanPrompt is pure for deterministic recovery floors", () => {
    const input = "  please\tfix this because i need it\n\n\nnow  ";
    expect(cleanPrompt(input)).toBe("please fix this because I need it\n\nnow");
    expect(cleanPrompt(input)).toBe(cleanPrompt(input));
    const fenced = "```ts\n\tconst  i = 1;\n\n\t\treturn  i;\n```";
    expect(cleanPrompt(`  please\tfix\n${fenced}\n because i asked  `)).toBe(`please fix\n${fenced}\nbecause I asked`);
  });

  test("over-cap deterministic smoothing leaves no live queue items", async () => {
    const fixture = serviceFixture({ guards: { smoothedPrompt: { maxInferenceTokens: 1 } } });
    const filePath = await newThread(fixture);

    await send(fixture.sdk, filePath, [validEvent("user_prompt", { payload: { text: "hello world ".repeat(50) } })]);
    await drain(fixture.sdk, filePath);

    expect(await liveWorkCount(fixture)).toBe(0);
  });
});
