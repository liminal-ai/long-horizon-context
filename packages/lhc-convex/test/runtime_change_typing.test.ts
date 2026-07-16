import { beforeEach, describe, expect, test } from "vitest";
import type { Lhc, MessageEventInput } from "../src/client/index.js";
import { type ServiceFixture, serviceFixture, validEvent } from "./fixtures/index.js";

let fixture: ServiceFixture;
let sdk: Lhc;

beforeEach(() => {
  fixture = serviceFixture({ guards: { detailedTurnCompression: { tinyTurnTokens: 1 } } });
  sdk = fixture.sdk;
});

async function newThread(): Promise<string> {
  return (await fixture.createThread()).filePath;
}

async function send(filePath: string, batch: readonly MessageEventInput[]): Promise<void> {
  const result = await sdk.intakeStream.messageEvents({ filePath }, batch);
  if (!result.ok) throw new Error(result.error.reason);
}

describe("Story 5: runtime-change typing", () => {
  test("projects model changes as typed model_change blocks", async () => {
    const filePath = await newThread();
    await send(filePath, [validEvent("model_change", { payload: { previousModel: "gpt-5", newModel: "gpt-5.1" } })]);

    const listed = await sdk.messages.list({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value).toHaveLength(1);
    expect(listed.value[0]?.kind).toBe("model_change");
    expect(listed.value[0]?.blocks).toEqual([
      { blockType: "model_change", content: { previousModel: "gpt-5", newModel: "gpt-5.1" } },
    ]);
  });

  test("projects thinking-level changes as typed thinking_level_change blocks", async () => {
    const filePath = await newThread();
    await send(filePath, [
      validEvent("thinking_level_change", { payload: { previousLevel: "medium", newLevel: "high" } }),
    ]);

    const listed = await sdk.messages.list({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value).toHaveLength(1);
    expect(listed.value[0]?.kind).toBe("thinking_level_change");
    expect(listed.value[0]?.blocks).toEqual([
      { blockType: "thinking_level_change", content: { previousLevel: "medium", newLevel: "high" } },
    ]);
  });

  test("places typed runtime-change blocks verbatim in constructed turns in stream order", async () => {
    const filePath = await newThread();
    const modelBlock = { previousModel: "gpt-5", newModel: "gpt-5.1" };
    const thinkingBlock = { previousLevel: "medium", newLevel: "high" };
    const intake = await sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: "runtime order" } }),
      validEvent("model_change", { payload: modelBlock }),
      validEvent("thinking_level_change", { payload: thinkingBlock }),
      validEvent("assistant_text", { payload: { text: "answer" } }),
      validEvent("turn_end"),
    ]);
    expect(intake.ok).toBe(true);
    if (!intake.ok) return;

    const drained = await sdk.work.drain({ filePath });
    expect(drained.ok).toBe(true);
    if (!drained.ok) return;

    const report = await sdk.turns.report({ filePath }, { turnId: "t1" });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const rendering = report.value.find((row) => row.derivationType === "turn_rendering")?.content ?? "";
    const segments = rendering.split("\n\n");
    expect(segments).toHaveLength(4);
    expect(segments[1]).toContain(`model_change ${modelBlock.previousModel} -> ${modelBlock.newModel}`);
    expect(segments[2]).toContain(`thinking_level_change ${thinkingBlock.previousLevel} -> ${thinkingBlock.newLevel}`);
    expect(segments[3]).toContain("answer");

    const assemblyText = report.value.find((row) => row.derivationType === "pre_detailed_assembly")?.content ?? "";
    expect(assemblyText).toContain("User:");
    expect(assemblyText).toContain("⏺ ");
    expect(assemblyText).not.toContain("model_change");
  });
});
