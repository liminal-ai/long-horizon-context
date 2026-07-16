// Epic 05 Story 3 — TC-2.3 (AC-2.4): the real adapter behind the model-call
// seam. Empty or whitespace-only success text is a classified failure, never a
// ready form; and success text is shaped so surrounding whitespace never
// reaches the stored form.
//
// The three frozen TC-2.1 equivalence tests (adapter vs deterministic
// inference callbacks) are not ported: they compare the model-call adapter
// against createDeterministicInferenceCallbacks, a direct-callback surface the
// component does not have (all lanes route through the model-call handle).
// Those cases are it.skip in the frozen suite and assert nothing. Per-kind
// canned routing and provenance are covered by test/inference_routing.test.ts.
import { describe, expect, test } from "vitest";
import { PROMPT_REGISTRY, type PromptTemplate } from "../src/shared/prompts/index.js";
import { cleanPrompt } from "../src/shared/smoothing.js";
import { serviceFixture, validEvent } from "./fixtures/index.js";

const PROMPT = "only a prompt to smooth";

function renderByName(name: string, input: unknown): unknown {
  return (PROMPT_REGISTRY[name] as PromptTemplate<unknown> | undefined)?.render(input);
}

// One prompt, no turn_end: exactly one work item (prompt_smoothing) queues, so
// a single smoothing attempt maps one-to-one onto the smoothed_prompt form.
async function seedSmoothingOnly(fixture: ReturnType<typeof serviceFixture>): Promise<string> {
  const { filePath } = await fixture.createThread();
  const result = await fixture.sdk.intakeStream.messageEvents({ filePath }, [
    validEvent("user_prompt", { payload: { text: PROMPT } }),
  ]);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.reason);
  return filePath;
}

async function smoothedForm(fixture: ReturnType<typeof serviceFixture>, filePath: string) {
  const report = await fixture.sdk.messages.report({ filePath }, { messageId: "m1" });
  expect(report.ok).toBe(true);
  if (!report.ok) throw new Error(report.error.reason);
  return report.value.find((form) => form.derivationType === "smoothed_prompt");
}

describe("TC-2.3: empty or whitespace-only output is a classified failure (AC-2.4)", () => {
  test("a whitespace-only success fails on the first attempt as empty_output", async () => {
    const fixture = serviceFixture({ models: { smoothed_prompt: "whitespace" } });
    const filePath = await seedSmoothingOnly(fixture);
    const drained = await fixture.sdk.work.drain({ filePath });
    expect(drained.ok).toBe(true);
    if (!drained.ok) return;

    const smoothed = await smoothedForm(fixture, filePath);
    expect(smoothed?.state).toBe("failed");
    expect(smoothed?.reason).toContain("empty_output");

    const derivationLog = await fixture.sdk.logging.queryDerivationLog(
      { filePath },
      { subjectId: "m1", derivationType: "smoothed_prompt" },
    );
    expect(derivationLog.ok).toBe(true);
    if (!derivationLog.ok) return;
    const failed = derivationLog.value.filter((entry) => entry.eventKind === "inference_failed");
    // Exactly one failure row: the empty output failed on its first attempt,
    // with no retry.
    expect(failed).toHaveLength(1);
    const payload = failed[0]?.["payload"] as { reason: string; requestMessages: unknown };
    expect(payload.reason).toContain("empty_output");
    // The logged request is the real rendered smoothing call for the cleaned
    // prompt — the template the assignment selected, never a placeholder.
    expect(payload.requestMessages).toEqual(renderByName("smoothing-v1", { text: cleanPrompt(PROMPT) }));
  });

  test("success text is shaped: surrounding whitespace never reaches the form content", async () => {
    const fixture = serviceFixture({ models: { smoothed_prompt: "success:\n  shaped result text  \n" } });
    const filePath = await seedSmoothingOnly(fixture);
    const drained = await fixture.sdk.work.drain({ filePath });
    expect(drained.ok).toBe(true);

    const smoothed = await smoothedForm(fixture, filePath);
    expect(smoothed?.state).toBe("ready");
    expect(smoothed?.content).toBe("shaped result text");
  });
});
