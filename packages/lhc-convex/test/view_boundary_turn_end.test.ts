import { describe, expect, test } from "vitest";
import type { Lhc, MessageEventInput } from "../src/client/index.js";
import { type ServiceFixture, serviceFixture, validEvent } from "./fixtures/index.js";

const BUDGETS = { maxTokens: 100, targetTokens: 60 };
let callCounter = 0;

function boundaryToolRun(resultTokens: number): MessageEventInput[] {
  callCounter += 1;
  const toolCallId = `call-boundary-${callCounter}`;
  return [
    validEvent("tool_call", {
      payload: { toolCallId, toolName: "read_file", arguments: { path: `boundary-${callCounter}.txt` } },
    }),
    validEvent("tool_result", {
      payload: { toolCallId, content: Array<string>(resultTokens).fill("tok").join(" "), isError: false },
    }),
  ];
}

function turnedToolResultEvents(turns: Array<{ results: number[]; close?: boolean }>): MessageEventInput[] {
  return turns.flatMap((turn, index) => [
    validEvent("user_prompt", { payload: { text: `turn ${index + 1}` } }),
    ...turn.results.flatMap((tokens) => boundaryToolRun(tokens)),
    ...(turn.close === false ? [] : [validEvent("turn_end")]),
  ]);
}

async function boundaryOf(fixture: ServiceFixture): Promise<number> {
  return await fixture.test.run(async (ctx) => {
    const rows = await ctx.db.query("viewBoundaries").collect();
    const row = rows.find((candidate) => candidate.instance === fixture.instance);
    if (row === undefined) throw new Error("view boundary missing");
    return row.position;
  });
}

async function zoneTokensOf(sdk: Lhc, filePath: string): Promise<number> {
  const status = await sdk.threadView.status({ filePath });
  if (!status.ok) throw new Error(status.error.reason);
  return status.value.visibility.zoneTokens;
}

function abridgedCount(messages: ReadonlyArray<{ content: readonly { text: string }[] }>): number {
  return messages.filter((message) => {
    const text = message.content.map((part) => part.text).join("");
    return text.startsWith("[tool result · ") && text.includes(" · abridged]");
  }).length;
}

async function intake(sdk: Lhc, filePath: string, events: readonly MessageEventInput[]): Promise<void> {
  const result = await sdk.intakeStream.messageEvents({ filePath }, events);
  if (!result.ok) throw new Error(result.error.reason);
}

describe("intake does not auto-advance the visibility boundary", () => {
  test("keeps the boundary at zero after turn close even when the zone exceeds max", async () => {
    const fixture = serviceFixture({ view: { visibility: BUDGETS } });
    const filePath = (await fixture.createThread()).filePath;
    await intake(fixture.sdk, filePath, turnedToolResultEvents([{ results: [30, 30] }]));
    expect(await boundaryOf(fixture)).toBe(0);
    await intake(fixture.sdk, filePath, turnedToolResultEvents([{ results: [40, 40], close: false }]));
    await intake(fixture.sdk, filePath, boundaryToolRun(40));
    expect(await boundaryOf(fixture)).toBe(0);
    expect(await zoneTokensOf(fixture.sdk, filePath)).toBe(180);
    const context = await fixture.sdk.threadView.getLlmRequestContext({ filePath });
    expect(context.ok).toBe(true);
    if (context.ok) expect(abridgedCount(context.value.messages)).toBe(0);
    await intake(fixture.sdk, filePath, [validEvent("turn_end")]);
    expect(await boundaryOf(fixture)).toBe(0);
    expect(await zoneTokensOf(fixture.sdk, filePath)).toBe(180);
  });

  test("does not advance when a new user prompt closes the previous populated turn", async () => {
    const fixture = serviceFixture({ view: { visibility: BUDGETS } });
    const filePath = (await fixture.createThread()).filePath;
    await intake(fixture.sdk, filePath, turnedToolResultEvents([{ results: [30, 30] }]));
    await intake(fixture.sdk, filePath, turnedToolResultEvents([{ results: [40, 40], close: false }]));
    const closedByPrompt = await fixture.sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: "next prompt closes the prior turn" } }),
    ]);
    expect(closedByPrompt.ok).toBe(true);
    if (!closedByPrompt.ok) return;
    expect(closedByPrompt.value.turnTransitions.map((transition) => transition.action)).toEqual(["closed", "opened"]);
    expect(await boundaryOf(fixture)).toBe(0);
    expect(await zoneTokensOf(fixture.sdk, filePath)).toBe(140);
  });
});
