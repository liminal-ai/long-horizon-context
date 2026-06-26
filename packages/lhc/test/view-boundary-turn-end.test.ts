// Visibility boundary: intake does not auto-advance the boundary at turn close.
import { afterEach, describe, expect, it } from "vitest";
import { initLhc, type Lhc, type SdkViewConfig } from "../src/index.js";
import {
  boundaryToolRun,
  createInferenceCallbacksDouble,
  openRaw,
  seedTurnedToolResults,
  type TempStore,
  tempStore,
  turnedToolResultEvents,
  validEvent,
} from "./fixtures/index.js";

const BUDGETS = { maxTokens: 100, targetTokens: 60 };

const stores: TempStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.cleanup();
});

function visSdk(view: SdkViewConfig = { visibility: BUDGETS }): Lhc {
  return initLhc({ inferenceCallbacks: createInferenceCallbacksDouble(), mode: "manual", view });
}

async function newThread(sdk: Lhc): Promise<string> {
  const store = tempStore();
  stores.push(store);
  const filePath = store.threadPath();
  const created = await sdk.threads.newThread({ filePath, registryPath: store.registryPath });
  if (!created.ok) throw new Error(`thread creation failed: ${created.error.reason}`);
  return filePath;
}

async function boundaryOf(filePath: string): Promise<number> {
  const db = openRaw(filePath);
  try {
    const row = db.prepare(`SELECT position FROM view_boundary`).get() as { position: number | bigint };
    return Number(row.position);
  } finally {
    db.close();
  }
}

async function zoneTokensOf(sdk: Lhc, filePath: string): Promise<number> {
  const status = await sdk.threadView.status({ filePath });
  if (!status.ok) throw new Error(`status failed: ${status.error.reason}`);
  return status.value.visibility.zoneTokens;
}

function messageText(message: { content: readonly { text: string }[] }): string {
  return message.content.map((part) => part.text).join("");
}

function abridgedCount(messages: ReadonlyArray<{ content: readonly { text: string }[] }>): number {
  return messages.filter((m) => {
    const text = messageText(m);
    return text.startsWith("[tool result · ") && text.includes(" · abridged]");
  }).length;
}

async function intakeRaw(
  sdk: Lhc,
  filePath: string,
  events: Parameters<Lhc["intakeStream"]["messageEvents"]>[1],
): Promise<void> {
  const result = await sdk.intakeStream.messageEvents({ filePath }, events);
  if (!result.ok) throw new Error(`intake failed: ${result.error.reason}`);
}

describe("intake does not auto-advance the visibility boundary", () => {
  it("keeps the boundary at zero after turn close even when the zone exceeds max", async () => {
    const sdk = visSdk();
    const filePath = await newThread(sdk);

    await seedTurnedToolResults(sdk, filePath, [{ results: [30, 30] }]);
    expect(await boundaryOf(filePath)).toBe(0);

    await intakeRaw(sdk, filePath, turnedToolResultEvents([{ results: [40, 40], close: false }]));
    await intakeRaw(sdk, filePath, boundaryToolRun(40));
    expect(await boundaryOf(filePath)).toBe(0);
    expect(await zoneTokensOf(sdk, filePath)).toBe(180);

    const contextRead = await sdk.threadView.getLlmRequestContext({ filePath });
    expect(contextRead.ok).toBe(true);
    if (!contextRead.ok) return;
    expect(abridgedCount(contextRead.value.messages)).toBe(0);

    await intakeRaw(sdk, filePath, [validEvent("turn_end")]);
    expect(await boundaryOf(filePath)).toBe(0);
    expect(await zoneTokensOf(sdk, filePath)).toBe(180);
  });

  it("does not advance when a new user prompt closes the previous populated turn", async () => {
    const sdk = visSdk();
    const filePath = await newThread(sdk);

    await seedTurnedToolResults(sdk, filePath, [{ results: [30, 30] }]);
    await intakeRaw(sdk, filePath, turnedToolResultEvents([{ results: [40, 40], close: false }]));

    const closedByPrompt = await sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: "next prompt closes the prior turn" } }),
    ]);
    expect(closedByPrompt.ok).toBe(true);
    if (!closedByPrompt.ok) return;
    expect(closedByPrompt.value.turnTransitions.map((transition) => transition.action)).toEqual(["closed", "opened"]);
    expect(await boundaryOf(filePath)).toBe(0);
    expect(await zoneTokensOf(sdk, filePath)).toBe(140);
  });
});
