// Item 29: manual tool-result prune via the visibility boundary.
import { afterEach, describe, expect, it } from "vitest";
import { initLhc, type Lhc, type MessageEventInput, type SdkViewConfig } from "../src/index.js";
import {
  createInferenceCallbacksDouble,
  openRaw,
  type TempStore,
  tempStore,
  validEvent,
} from "./fixtures/index.js";

function tokens(n: number): string {
  return Array<string>(n).fill("tok").join(" ");
}

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

let callCounter = 0;

function toolRun(resultTokens: number): MessageEventInput[] {
  callCounter += 1;
  const toolCallId = `call-prune-${callCounter}`;
  return [
    validEvent("tool_call", {
      payload: { toolCallId, toolName: "read_file", arguments: { path: `prune-${callCounter}.txt` } },
    }),
    validEvent("tool_result", {
      payload: { toolCallId, content: tokens(resultTokens), isError: false },
    }),
  ];
}

function toolTurn(resultTokens: readonly number[], opts: { turnEnd?: boolean } = {}): MessageEventInput[] {
  const events: MessageEventInput[] = [validEvent("user_prompt", { payload: { text: "prune turn" } })];
  for (const n of resultTokens) events.push(...toolRun(n));
  if (opts.turnEnd !== false) events.push(validEvent("turn_end"));
  return events;
}

async function intake(sdk: Lhc, filePath: string, batch: readonly MessageEventInput[]): Promise<void> {
  const result = await sdk.intakeStream.messageEvents({ filePath }, batch);
  if (!result.ok) throw new Error(`intake failed: ${result.error.reason}`);
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

async function toolResults(
  sdk: Lhc,
  filePath: string,
): Promise<Array<{ messageId: string; sourceEventOrder: number; tokenEstimate: number }>> {
  const listed = await sdk.messages.list({ filePath });
  if (!listed.ok) throw new Error(`list failed: ${listed.error.reason}`);
  return listed.value
    .filter((m) => m.kind === "tool_result")
    .map((m) => ({
      messageId: m.messageId,
      sourceEventOrder: m.sourceEventOrder,
      tokenEstimate: m.tokenEstimate,
    }));
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

describe("threadView.prune before compact", () => {
  it("advances boundary from zero so older tool results render short", async () => {
    const sdk = visSdk();
    const filePath = await newThread(sdk);
    await intake(sdk, filePath, toolTurn([20, 20, 20, 20]));

    const receipt = await sdk.threadView.prune({ filePath });
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    expect(receipt.value.noOp).toBe(false);
    expect(receipt.value.previousBoundary).toBe(0);
    expect(receipt.value.zoneTokensBefore).toBe(80);
    expect(receipt.value.zoneTokensAfter).toBeLessThanOrEqual(BUDGETS.targetTokens);
    expect(receipt.value.toolResultsPruned).toBeGreaterThan(0);
    expect(receipt.value.zoneTokensBefore - receipt.value.zoneTokensAfter).toBeGreaterThan(0);

    const results = await toolResults(sdk, filePath);
    expect(await boundaryOf(filePath)).toBe(receipt.value.newBoundary);
    expect(receipt.value.newBoundary).toBe(results[0]?.sourceEventOrder);

    const context = await sdk.threadView.getLlmRequestContext({ filePath });
    expect(context.ok).toBe(true);
    if (!context.ok) return;
    expect(abridgedCount(context.value.messages)).toBe(receipt.value.toolResultsPruned);
  });
});

describe("threadView.prune after compact", () => {
  it("starts from the compact point boundary and prunes only the tail zone", async () => {
    const sdk = visSdk();
    const filePath = await newThread(sdk);
    for (let i = 0; i < 3; i += 1) await intake(sdk, filePath, toolTurn([20, 20]));

    const compacted = await sdk.threadView.compact({ filePath }, { params: { lowerBound: 40 } });
    expect(compacted.ok).toBe(true);
    if (!compacted.ok) return;
    const compactPoint = compacted.value.compactPoint;
    expect(await boundaryOf(filePath)).toBe(compactPoint);

    await intake(sdk, filePath, toolTurn([20, 20, 20, 20]));
    const before = await sdk.threadView.status({ filePath });
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect(before.value.visibility.zoneTokens).toBeGreaterThan(BUDGETS.targetTokens);

    const receipt = await sdk.threadView.prune({ filePath });
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    expect(receipt.value.noOp).toBe(false);
    expect(receipt.value.compactPoint).toBe(compactPoint);
    expect(receipt.value.previousBoundary).toBe(compactPoint);
    expect(receipt.value.newBoundary).toBeGreaterThan(compactPoint);
    expect(receipt.value.zoneTokensAfter).toBeLessThanOrEqual(BUDGETS.targetTokens);
  });
});

describe("threadView.prune targetTokens override", () => {
  it("honors an explicit target", async () => {
    const sdk = visSdk();
    const filePath = await newThread(sdk);
    await intake(sdk, filePath, toolTurn([30, 30, 30]));

    const receipt = await sdk.threadView.prune({ filePath }, { targetTokens: 30 });
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    expect(receipt.value.targetTokens).toBe(30);
    expect(receipt.value.noOp).toBe(false);
    expect(receipt.value.zoneTokensAfter).toBeLessThanOrEqual(30);
  });

  it("rejects non-integer or negative targetTokens", async () => {
    const sdk = visSdk();
    const filePath = await newThread(sdk);
    await intake(sdk, filePath, toolTurn([20]));

    const bad = await sdk.threadView.prune({ filePath }, { targetTokens: -1 });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error.code).toBe("invalid_target_tokens");

    const fractional = await sdk.threadView.prune({ filePath }, { targetTokens: 10.5 });
    expect(fractional.ok).toBe(false);
    if (fractional.ok) return;
    expect(fractional.error.code).toBe("invalid_target_tokens");
  });
});

describe("threadView.prune no-op cases", () => {
  it("reports no-op when the zone is already under target", async () => {
    const sdk = visSdk();
    const filePath = await newThread(sdk);
    await intake(sdk, filePath, toolTurn([20, 20]));

    const receipt = await sdk.threadView.prune({ filePath });
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    expect(receipt.value.noOp).toBe(true);
    expect(receipt.value.zoneTokensBefore).toBe(40);
    expect(receipt.value.zoneTokensAfter).toBe(40);
    expect(receipt.value.toolResultsPruned).toBe(0);
    expect(receipt.value.newBoundary).toBe(receipt.value.previousBoundary);
    expect(await boundaryOf(filePath)).toBe(0);
  });

  it("does not move the boundary backward when a second prune uses a larger target", async () => {
    const sdk = visSdk();
    const filePath = await newThread(sdk);
    await intake(sdk, filePath, toolTurn([20, 20, 20, 20]));

    const first = await sdk.threadView.prune({ filePath }, { targetTokens: 20 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.noOp).toBe(false);
    const afterFirst = first.value.newBoundary;

    const second = await sdk.threadView.prune({ filePath }, { targetTokens: 60 });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.noOp).toBe(true);
    expect(second.value.newBoundary).toBe(afterFirst);
    expect(await boundaryOf(filePath)).toBe(afterFirst);
  });
});

describe("threadView.prune single oversized tool result", () => {
  it("places the boundary at the newest tool result when it alone exceeds target", async () => {
    const sdk = visSdk({ visibility: { maxTokens: 100, targetTokens: 30 } });
    const filePath = await newThread(sdk);
    await intake(sdk, filePath, toolTurn([50]));

    const receipt = await sdk.threadView.prune({ filePath });
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    expect(receipt.value.noOp).toBe(false);
    expect(receipt.value.zoneTokensAfter).toBe(0);

    const results = await toolResults(sdk, filePath);
    expect(receipt.value.newBoundary).toBe(results[0]?.sourceEventOrder);

    const context = await sdk.threadView.getLlmRequestContext({ filePath });
    expect(context.ok).toBe(true);
    if (!context.ok) return;
    expect(abridgedCount(context.value.messages)).toBe(1);
  });
});

describe("threadView.prune boundary rendering", () => {
  it("renders the tool result at exactly the boundary position as short", async () => {
    const sdk = visSdk();
    const filePath = await newThread(sdk);
    await intake(sdk, filePath, toolTurn([20, 20, 20, 20]));

    const receipt = await sdk.threadView.prune({ filePath });
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;

    const results = await toolResults(sdk, filePath);
    const boundaryResult = results.find((r) => r.sourceEventOrder === receipt.value.newBoundary);
    expect(boundaryResult).toBeDefined();
    if (boundaryResult === undefined) return;

    const context = await sdk.threadView.getLlmRequestContext({ filePath });
    expect(context.ok).toBe(true);
    if (!context.ok) return;

    const boundaryText = context.value.messages
      .map((m) => messageText(m))
      .find((text) => text.includes(`§${boundaryResult.messageId}`));
    expect(boundaryText).toBeDefined();
    expect(boundaryText).toContain(" · abridged]");
  });
});
