import { describe, expect, test } from "vitest";
import type { Lhc, MessageEventInput, SdkConfig } from "../src/client/index.js";
import { type ServiceFixture, serviceFixture, validEvent } from "./fixtures/index.js";

function tokens(n: number): string {
  return Array<string>(n).fill("tok").join(" ");
}

const BUDGETS = { maxTokens: 100, targetTokens: 60 };

function visFixture(view: SdkConfig["view"] = { visibility: BUDGETS }): ServiceFixture {
  return serviceFixture({ view });
}

let callCounter = 0;

function toolRun(resultTokens: number): MessageEventInput[] {
  callCounter += 1;
  const toolCallId = `call-prune-${callCounter}`;
  return [
    validEvent("tool_call", {
      payload: { toolCallId, toolName: "read_file", arguments: { path: `prune-${callCounter}.txt` } },
    }),
    validEvent("tool_result", { payload: { toolCallId, content: tokens(resultTokens), isError: false } }),
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

async function boundaryOf(fixture: ServiceFixture): Promise<number> {
  return await fixture.test.run(async (ctx) => {
    const rows = await ctx.db.query("viewBoundaries").collect();
    const row = rows.find((candidate) => candidate.instance === fixture.instance);
    if (row === undefined) throw new Error("view boundary missing");
    return row.position;
  });
}

async function toolResults(
  sdk: Lhc,
  filePath: string,
): Promise<Array<{ messageId: string; sourceEventOrder: number; tokenEstimate: number }>> {
  const listed = await sdk.messages.list({ filePath });
  if (!listed.ok) throw new Error(`list failed: ${listed.error.reason}`);
  return listed.value
    .filter((message) => message.kind === "tool_result")
    .map((message) => ({
      messageId: message.messageId,
      sourceEventOrder: message.sourceEventOrder,
      tokenEstimate: message.tokenEstimate,
    }));
}

function messageText(message: { content: readonly { text: string }[] }): string {
  return message.content.map((part) => part.text).join("");
}

function abridgedCount(messages: ReadonlyArray<{ content: readonly { text: string }[] }>): number {
  return messages.filter((message) => {
    const text = messageText(message);
    return text.startsWith("[tool result · ") && text.includes(" · abridged]");
  }).length;
}

describe("threadView.prune before compact", () => {
  test("advances boundary from zero so older tool results render short", async () => {
    const fixture = visFixture();
    const filePath = (await fixture.createThread()).filePath;
    await intake(fixture.sdk, filePath, toolTurn([20, 20, 20, 20]));
    const receipt = await fixture.sdk.threadView.prune({ filePath });
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    expect(receipt.value.noOp).toBe(false);
    expect(receipt.value.previousBoundary).toBe(0);
    expect(receipt.value.zoneTokensBefore).toBe(80);
    expect(receipt.value.zoneTokensAfter).toBeLessThanOrEqual(BUDGETS.targetTokens);
    expect(receipt.value.toolResultsPruned).toBeGreaterThan(0);
    expect(receipt.value.zoneTokensBefore - receipt.value.zoneTokensAfter).toBeGreaterThan(0);
    const results = await toolResults(fixture.sdk, filePath);
    expect(await boundaryOf(fixture)).toBe(receipt.value.newBoundary);
    expect(receipt.value.newBoundary).toBe(results[0]?.sourceEventOrder);
    const context = await fixture.sdk.threadView.getLlmRequestContext({ filePath });
    expect(context.ok).toBe(true);
    if (context.ok) expect(abridgedCount(context.value.messages)).toBe(receipt.value.toolResultsPruned);
  });
});

describe("threadView.prune after compact", () => {
  test("starts from the compact point boundary and prunes only the tail zone", async () => {
    const fixture = visFixture();
    const filePath = (await fixture.createThread()).filePath;
    for (let index = 0; index < 3; index += 1) await intake(fixture.sdk, filePath, toolTurn([20, 20]));
    const compacted = await fixture.sdk.threadView.compact({ filePath }, { params: { lowerBound: 40 } });
    expect(compacted.ok).toBe(true);
    if (!compacted.ok) return;
    const compactPoint = compacted.value.compactPoint;
    expect(await boundaryOf(fixture)).toBe(compactPoint);
    await intake(fixture.sdk, filePath, toolTurn([20, 20, 20, 20]));
    const before = await fixture.sdk.threadView.status({ filePath });
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect(before.value.visibility.zoneTokens).toBeGreaterThan(BUDGETS.targetTokens);
    const receipt = await fixture.sdk.threadView.prune({ filePath });
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
  test("honors an explicit target", async () => {
    const fixture = visFixture();
    const filePath = (await fixture.createThread()).filePath;
    await intake(fixture.sdk, filePath, toolTurn([30, 30, 30]));
    const receipt = await fixture.sdk.threadView.prune({ filePath }, { targetTokens: 30 });
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    expect(receipt.value.targetTokens).toBe(30);
    expect(receipt.value.noOp).toBe(false);
    expect(receipt.value.zoneTokensAfter).toBeLessThanOrEqual(30);
  });

  test("rejects non-integer or negative targetTokens", async () => {
    const fixture = visFixture();
    const filePath = (await fixture.createThread()).filePath;
    await intake(fixture.sdk, filePath, toolTurn([20]));
    const bad = await fixture.sdk.threadView.prune({ filePath }, { targetTokens: -1 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("invalid_target_tokens");
    const fractional = await fixture.sdk.threadView.prune({ filePath }, { targetTokens: 10.5 });
    expect(fractional.ok).toBe(false);
    if (!fractional.ok) expect(fractional.error.code).toBe("invalid_target_tokens");
  });
});

describe("threadView.prune no-op cases", () => {
  test("reports no-op when the zone is already under target", async () => {
    const fixture = visFixture();
    const filePath = (await fixture.createThread()).filePath;
    await intake(fixture.sdk, filePath, toolTurn([20, 20]));
    const receipt = await fixture.sdk.threadView.prune({ filePath });
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    expect(receipt.value.noOp).toBe(true);
    expect(receipt.value.zoneTokensBefore).toBe(40);
    expect(receipt.value.zoneTokensAfter).toBe(40);
    expect(receipt.value.toolResultsPruned).toBe(0);
    expect(receipt.value.newBoundary).toBe(receipt.value.previousBoundary);
    expect(await boundaryOf(fixture)).toBe(0);
  });

  test("does not move the boundary backward when a second prune uses a larger target", async () => {
    const fixture = visFixture();
    const filePath = (await fixture.createThread()).filePath;
    await intake(fixture.sdk, filePath, toolTurn([20, 21, 22, 23]));
    const first = await fixture.sdk.threadView.prune({ filePath }, { targetTokens: 20 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.noOp).toBe(false);
    const second = await fixture.sdk.threadView.prune({ filePath }, { targetTokens: 60 });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.noOp).toBe(true);
    expect(second.value.newBoundary).toBe(first.value.newBoundary);
    expect(await boundaryOf(fixture)).toBe(first.value.newBoundary);
  });
});

describe("threadView.prune single oversized tool result", () => {
  test("places the boundary at the newest tool result when it alone exceeds target", async () => {
    const fixture = visFixture({ visibility: { maxTokens: 100, targetTokens: 30 } });
    const filePath = (await fixture.createThread()).filePath;
    await intake(fixture.sdk, filePath, toolTurn([50]));
    const receipt = await fixture.sdk.threadView.prune({ filePath });
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    expect(receipt.value.noOp).toBe(false);
    expect(receipt.value.zoneTokensAfter).toBe(0);
    const results = await toolResults(fixture.sdk, filePath);
    expect(receipt.value.newBoundary).toBe(results[0]?.sourceEventOrder);
    const context = await fixture.sdk.threadView.getLlmRequestContext({ filePath });
    expect(context.ok).toBe(true);
    if (context.ok) expect(abridgedCount(context.value.messages)).toBe(1);
  });
});

describe("threadView.prune boundary rendering", () => {
  test("renders the tool result at exactly the boundary position as short", async () => {
    const fixture = visFixture();
    const filePath = (await fixture.createThread()).filePath;
    const sizes = [20, 21, 22, 23];
    await intake(fixture.sdk, filePath, toolTurn(sizes));
    const receipt = await fixture.sdk.threadView.prune({ filePath });
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    const results = await toolResults(fixture.sdk, filePath);
    const boundaryResult = results.find((result) => result.sourceEventOrder === receipt.value.newBoundary);
    expect(boundaryResult).toBeDefined();
    if (boundaryResult === undefined) return;
    const context = await fixture.sdk.threadView.getLlmRequestContext({ filePath });
    expect(context.ok).toBe(true);
    if (!context.ok) return;
    const boundaryIndex = results.findIndex((result) => result.messageId === boundaryResult.messageId);
    const boundaryText = context.value.messages
      .map((message) => messageText(message))
      .find((text) => text.includes(tokens(sizes[boundaryIndex] ?? 0)));
    expect(boundaryText).toBeDefined();
    expect(boundaryText).toContain(" · abridged]");
  });
});
