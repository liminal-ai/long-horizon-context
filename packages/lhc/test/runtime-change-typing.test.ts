import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSdk,
  messages,
  threads,
  type DerivationProvider,
  type Lhc,
  type MessageEventInput,
} from "../src/index.js";
import {
  createProviderDouble,
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

function sdkFor(provider: DerivationProvider): Lhc {
  return createSdk({
    provider,
    mode: "manual",
    retry: { budget: 3, backoffBaseMs: 0, backoffCapMs: 0 },
    lease: { durationMs: 200 },
  });
}

async function send(filePath: string, batch: readonly MessageEventInput[]): Promise<void> {
  const sdk = sdkFor(createProviderDouble());
  const result = await sdk.intakeStream.messageEvents({ filePath }, batch);
  if (!result.ok) throw new Error(result.error.reason);
}

describe("Story 5: runtime-change typing", () => {
  it("projects model changes as typed model_change blocks", async () => {
    const filePath = await newThread();

    await send(filePath, [
      validEvent("model_change", {
        payload: { previousModel: "gpt-5", newModel: "gpt-5.1" },
      }),
    ]);

    const listed = await messages.listMessages({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value).toHaveLength(1);
    expect(listed.value[0]?.kind).toBe("model_change");
    expect(listed.value[0]?.blocks).toEqual([
      {
        blockType: "model_change",
        content: { previousModel: "gpt-5", newModel: "gpt-5.1" },
      },
    ]);
  });

  it("projects thinking-level changes as typed thinking_level_change blocks", async () => {
    const filePath = await newThread();

    await send(filePath, [
      validEvent("thinking_level_change", {
        payload: { previousLevel: "medium", newLevel: "high" },
      }),
    ]);

    const listed = await messages.listMessages({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value).toHaveLength(1);
    expect(listed.value[0]?.kind).toBe("thinking_level_change");
    expect(listed.value[0]?.blocks).toEqual([
      {
        blockType: "thinking_level_change",
        content: { previousLevel: "medium", newLevel: "high" },
      },
    ]);
  });

  it("places typed runtime-change blocks verbatim in constructed turns in stream order", async () => {
    const double = createProviderDouble();
    const captured = double.captureInputs();
    const sdk = sdkFor(double);
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

    const rendering = captured.find((entry) => entry.op === "composeTurnRendering");
    const parts =
      (rendering?.input as
        | {
            parts?: Array<{
              kind: string;
              fallback: boolean;
              blocks?: Array<{ blockType: string; content: Record<string, unknown> }>;
            }>;
          }
        | undefined)?.parts ?? [];

    expect(parts.map((part) => part.kind)).toEqual([
      "user_prompt",
      "model_change",
      "thinking_level_change",
      "assistant_text",
    ]);
    expect(parts[1]).toMatchObject({
      kind: "model_change",
      fallback: false,
      blocks: [{ blockType: "model_change", content: modelBlock }],
    });
    expect(parts[2]).toMatchObject({
      kind: "thinking_level_change",
      fallback: false,
      blocks: [{ blockType: "thinking_level_change", content: thinkingBlock }],
    });
  });
});
