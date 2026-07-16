// smoothed_prompt guard config and marker skip, ported to the component.
// The length gate, custom cap, suspicious-output discard, and marker-prompt
// skip are observed through the drain path and the stored derivation.
//
// "Inference was not called" is read from the stored form: the guard-skip and
// marker-skip paths write the derivation with no metadata, while any model
// call stamps provenance (success) or discardReason (suspicious discard). So a
// ready smoothed_prompt with no metadata is exactly the no-inference floor.
//
// Two frozen legs are not ported. The direct-callback "resolves guard defaults
// for direct-callback hosts" case has no analog: the component has no
// inferenceCallbacks surface. And the suspicious-discard warning-log assertion
// cannot be ported: the component stamps metadata.discardReason but writes no
// warning-level log row on that path (see report).
import { describe, expect, test } from "vitest";
import type { Lhc } from "../src/client/index.js";
import { cleanPrompt } from "../src/shared/smoothing.js";
import { estimateTokens } from "../src/shared/token_counting/index.js";
import { serviceFixture, validEvent } from "./fixtures/index.js";

type Fixture = ReturnType<typeof serviceFixture>;

function tokenText(minTokens: number): string {
  let text = "";
  while (estimateTokens(text) < minTokens) text += "guardword ";
  return text.trim();
}

async function newThread(fixture: Fixture): Promise<string> {
  return (await fixture.createThread()).filePath;
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

async function smoothed(sdk: Lhc, filePath: string) {
  const report = await sdk.messages.report({ filePath }, { messageId: "m1" });
  if (!report.ok) throw new Error(report.error.reason);
  return report.value.find((form) => form.derivationType === "smoothed_prompt");
}

async function liveWorkCount(fixture: Fixture): Promise<number> {
  return await fixture.test.run(async (ctx) => {
    const rows = await ctx.db.query("workItems").collect();
    return rows.filter((row) => row.instance === fixture.instance).length;
  });
}

async function deleteSmoothingItem(fixture: Fixture): Promise<void> {
  await fixture.test.run(async (ctx) => {
    const rows = await ctx.db.query("workItems").collect();
    const row = rows.find((item) => item.instance === fixture.instance && item.kind === "prompt_smoothing");
    if (row === undefined) throw new Error("no prompt_smoothing work item to delete");
    await ctx.db.delete("workItems", row._id);
  });
}

describe("smoothed_prompt guard config", () => {
  test("uses the default 700-token cap and stores the cleaned floor as ready without inference", async () => {
    const prompt = tokenText(900);
    // A model that would produce a valid smoothing if ever reached.
    const fixture = serviceFixture({ models: { smoothed_prompt: `success:${tokenText(200)}` } });
    const filePath = await newThread(fixture);

    await sendPrompt(fixture.sdk, filePath, prompt);
    await drain(fixture.sdk, filePath);

    const form = await smoothed(fixture.sdk, filePath);
    expect(form).toMatchObject({ state: "ready", content: cleanPrompt(prompt) });
    expect(form?.metadata).toBeUndefined();
    expect(await liveWorkCount(fixture)).toBe(0);
  });

  test("respects a custom cap from top-level SdkConfig.guards", async () => {
    const prompt = tokenText(600);
    const fixture = serviceFixture({
      models: { smoothed_prompt: `success:${tokenText(200)}` },
      guards: { smoothedPrompt: { maxInferenceTokens: 500 } },
    });
    const filePath = await newThread(fixture);

    await sendPrompt(fixture.sdk, filePath, prompt);
    await drain(fixture.sdk, filePath);

    expect(fixture.sdk.config.guards?.smoothedPrompt?.maxInferenceTokens).toBe(500);
    const form = await smoothed(fixture.sdk, filePath);
    expect(form).toMatchObject({ state: "ready", content: cleanPrompt(prompt) });
    expect(form?.metadata).toBeUndefined();
    expect(await liveWorkCount(fixture)).toBe(0);
  });

  test("runs inference when the prompt is below the configured cap", async () => {
    const prompt = tokenText(600);
    const modelText = tokenText(200);
    const fixture = serviceFixture({
      models: { smoothed_prompt: `success:${modelText}` },
      guards: { smoothedPrompt: { maxInferenceTokens: 1000 } },
    });
    const filePath = await newThread(fixture);

    await sendPrompt(fixture.sdk, filePath, prompt);
    await drain(fixture.sdk, filePath);

    const form = await smoothed(fixture.sdk, filePath);
    expect(form?.state).toBe("ready");
    expect(form?.content).toBe(modelText);
    // Provenance is stamped only when the model was actually called.
    expect(form?.metadata?.provenance).toMatchObject({ prompt: "smoothing-v1" });
  });

  test("discards suspiciously short smoothing output and stores discard metadata", async () => {
    const prompt = tokenText(500);
    const shortModelText = tokenText(50);
    expect(estimateTokens(shortModelText)).toBeLessThan(0.15 * estimateTokens(cleanPrompt(prompt)));
    const fixture = serviceFixture({ models: { smoothed_prompt: `success:${shortModelText}` } });
    const filePath = await newThread(fixture);

    await sendPrompt(fixture.sdk, filePath, prompt);
    await drain(fixture.sdk, filePath);

    const form = await smoothed(fixture.sdk, filePath);
    expect(form).toMatchObject({
      state: "ready",
      content: cleanPrompt(prompt),
      metadata: { discardReason: "suspicious_output_ratio" },
    });
    expect(await liveWorkCount(fixture)).toBe(0);
  });

  test("turn construction uses the guard cap for pending prompt smoothing", async () => {
    const fixture = serviceFixture({ models: { smoothed_prompt: "success:should never be produced" } });
    const filePath = await newThread(fixture);
    const prompt = tokenText(900);

    await sendClosedTurn(fixture.sdk, filePath, prompt);
    await deleteSmoothingItem(fixture);
    const derived = await fixture.sdk.turns.deriveTurn({ filePath }, "t1");

    expect(derived.ok).toBe(true);
    const form = await smoothed(fixture.sdk, filePath);
    expect(form).toMatchObject({ state: "ready", content: cleanPrompt(prompt) });
    expect(form?.metadata).toBeUndefined();
    expect(await liveWorkCount(fixture)).toBe(0);
  });

  test("turn construction preserves an already-ready smoothed_prompt without calling smoothing inference", async () => {
    const fixture = serviceFixture({ models: { smoothed_prompt: "success:should never be produced" } });
    const filePath = await newThread(fixture);
    const prompt = tokenText(500);

    await sendClosedTurn(fixture.sdk, filePath, prompt);
    await deleteSmoothingItem(fixture);
    await fixture.test.run(async (ctx) => {
      const rows = await ctx.db.query("derivations").collect();
      const row = rows.find(
        (item) =>
          item.instance === fixture.instance &&
          item.scope === "message" &&
          item.subject === "m1" &&
          item.deriv === "smoothed_prompt",
      );
      if (row === undefined) throw new Error("smoothed_prompt derivation missing");
      await ctx.db.patch("derivations", row._id, {
        state: "ready",
        content: "competing ready value",
        reason: undefined,
        metadata: undefined,
      });
    });
    const derived = await fixture.sdk.turns.deriveTurn({ filePath }, "t1");

    expect(derived.ok).toBe(true);
    const form = await smoothed(fixture.sdk, filePath);
    expect(form).toMatchObject({ state: "ready", content: "competing ready value" });
    expect(form?.metadata).toBeUndefined();
  });
});

describe("marker prompt smoothing skip", () => {
  test("stores a bracketed marker prompt verbatim without calling inference", async () => {
    const fixture = serviceFixture({ models: { smoothed_prompt: "success:should never be produced" } });
    const filePath = await newThread(fixture);

    await sendPrompt(fixture.sdk, filePath, "[Request interrupted by user]");
    await drain(fixture.sdk, filePath);

    const form = await smoothed(fixture.sdk, filePath);
    expect(form).toMatchObject({ state: "ready", content: "[Request interrupted by user]" });
    expect(form?.metadata).toBeUndefined();
    expect(await liveWorkCount(fixture)).toBe(0);
  });

  test("skips inference for a marker with surrounding whitespace", async () => {
    const fixture = serviceFixture({ models: { smoothed_prompt: "success:should never be produced" } });
    const filePath = await newThread(fixture);

    await sendPrompt(fixture.sdk, filePath, "  [Request interrupted by user for tool use]\n");
    await drain(fixture.sdk, filePath);

    const form = await smoothed(fixture.sdk, filePath);
    expect(form).toMatchObject({ state: "ready", content: "[Request interrupted by user for tool use]" });
    expect(form?.metadata).toBeUndefined();
  });

  test("still smooths a prompt that merely contains brackets", async () => {
    const modelText = "please fix the flaky test in ci.yml";
    const fixture = serviceFixture({ models: { smoothed_prompt: `success:${modelText}` } });
    const filePath = await newThread(fixture);

    await sendPrompt(
      fixture.sdk,
      filePath,
      "please fix the [flaky] test in ci.yml, it keeps failing intermittently on main",
    );
    await drain(fixture.sdk, filePath);

    const form = await smoothed(fixture.sdk, filePath);
    expect(form).toMatchObject({ state: "ready", content: modelText });
    expect(form?.metadata?.provenance).toMatchObject({ prompt: "smoothing-v1" });
  });

  test("still smooths when brackets wrap more than eighty characters", async () => {
    const inner = "x".repeat(100);
    const modelText = "long bracketed content smoothed";
    const fixture = serviceFixture({ models: { smoothed_prompt: `success:${modelText}` } });
    const filePath = await newThread(fixture);

    await sendPrompt(fixture.sdk, filePath, `[${inner}]`);
    await drain(fixture.sdk, filePath);

    const form = await smoothed(fixture.sdk, filePath);
    expect(form).toMatchObject({ state: "ready", content: modelText });
    expect(form?.metadata?.provenance).toMatchObject({ prompt: "smoothing-v1" });
  });
});
