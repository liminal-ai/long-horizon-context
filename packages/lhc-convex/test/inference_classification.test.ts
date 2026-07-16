import { describe, expect, test } from "vitest";
import type { ModelCallResult } from "../src/client/types.js";
import { safeModelCall } from "../src/shared/model_call.js";
import { serviceFixture, validEvent } from "./fixtures/index.js";

async function seedSmoothingOnly(model: string) {
  const fixture = serviceFixture({ models: { smoothed_prompt: model } });
  const { filePath } = await fixture.createThread();
  const seeded = await fixture.sdk.intakeStream.messageEvents({ filePath }, [
    validEvent("user_prompt", { payload: { text: "only a prompt to smooth" } }),
  ]);
  expect(seeded.ok).toBe(true);
  const drained = await fixture.sdk.work.drain({ filePath });
  expect(drained.ok).toBe(true);
  if (!drained.ok) throw new Error(drained.error.reason);
  const reported = await fixture.sdk.messages.report({ filePath });
  expect(reported.ok).toBe(true);
  if (!reported.ok) throw new Error(reported.error.reason);
  return { fixture, filePath, report: drained.value, derivations: reported.value };
}

describe("inference failures preserve stable reason classes", () => {
  test("auth fails on the first attempt with a stable kind-led reason", async () => {
    const { fixture, filePath, report, derivations } = await seedSmoothingOnly("script:auth:auth-first-attempt-only");
    const smoothed = derivations.find((row) => row.derivationType === "smoothed_prompt");
    expect(smoothed?.state).toBe("failed");
    expect(smoothed?.reason).toBe("auth: scripted auth failure");
    expect(report.claimed).toBe(1);
    expect(report.failed).toBe(1);

    const logs = await fixture.sdk.logging.queryDerivationLog(
      { filePath },
      { derivationType: "smoothed_prompt", eventKind: "inference_failed" },
    );
    expect(logs.ok).toBe(true);
    if (logs.ok) expect(logs.value).toHaveLength(1);
  });

  test("network fails on the first attempt with a provider_failure-led reason", async () => {
    const { report, derivations } = await seedSmoothingOnly("script:network:network-first-attempt-only");
    const smoothed = derivations.find((row) => row.derivationType === "smoothed_prompt");
    expect(smoothed?.state).toBe("failed");
    expect(smoothed?.reason).toBe("provider_failure: network: scripted network failure");
    expect(report.claimed).toBe(1);
    expect(report.failed).toBe(1);
  });

  test("a hanging host times out and the serial drain continues through turn derivation", async () => {
    const fixture = serviceFixture({
      inference: { timeoutMs: 25 },
      models: { smoothed_prompt: "hang" },
    });
    const { filePath } = await fixture.createThread();
    const seeded = await fixture.sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: "a prompt whose smoothing hangs" } }),
      validEvent("turn_end"),
    ]);
    expect(seeded.ok).toBe(true);
    const drained = await fixture.sdk.work.drain({ filePath });
    expect(drained.ok).toBe(true);
    if (!drained.ok) return;
    expect(drained.value.remaining).toBe(0);

    const messageDerivations = await fixture.sdk.messages.report({ filePath });
    const turnDerivations = await fixture.sdk.turns.report({ filePath });
    expect(messageDerivations.ok).toBe(true);
    expect(turnDerivations.ok).toBe(true);
    if (!messageDerivations.ok || !turnDerivations.ok) return;
    expect(messageDerivations.value.find((row) => row.derivationType === "smoothed_prompt")?.state).toBe("ready");
    expect(turnDerivations.value.find((row) => row.derivationType === "turn_rendering")?.state).toBe("ready");
    expect(turnDerivations.value.find((row) => row.derivationType === "detailed_turn_compression")?.state).toBe(
      "ready",
    );
  });
});

describe("safeModelCall contains host behavior", () => {
  test("passes a structured success through untouched", async () => {
    const result = await safeModelCall(() => Promise.resolve({ ok: true, text: "plain success" }), 1_000);
    expect(result).toEqual({ ok: true, text: "plain success" });
  });

  test("passes a structured failure through untouched", async () => {
    const failure: ModelCallResult = { ok: false, kind: "rate_limit", message: "throttled" };
    const result = await safeModelCall(() => Promise.resolve(failure), 1_000);
    expect(result).toEqual(failure);
  });

  test("classifies a thrown exception as other, carrying the message", async () => {
    const result = await safeModelCall(() => Promise.reject(new Error("kaboom")), 1_000);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("other");
      expect(result.message).toContain("kaboom");
    }
  });

  test("classifies a synchronously throwing host as other", async () => {
    const result = await safeModelCall(() => {
      throw new Error("sync kaboom");
    }, 1_000);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("other");
      expect(result.message).toContain("sync kaboom");
    }
  });

  test("classifies a never-settling host as timeout after the race", async () => {
    const result = await safeModelCall(() => new Promise<ModelCallResult>(() => {}), 25);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("timeout");
      expect(result.message).toContain("25");
    }
  });
});
