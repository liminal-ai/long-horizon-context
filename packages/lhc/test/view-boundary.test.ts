// Epic 03 Story 4: visibility boundary rendering and the no-auto-advance
// intake contract. Seeded-boundary tests prove rendering respects a stored
// position; intake never moves the boundary on its own.
import { afterEach, describe, expect, it } from "vitest";
import { initLhc, type Lhc, type MessageEventInput, type SdkViewConfig, setSchedulerPoke } from "../src/index.js";
import {
  createInferenceCallbacksDouble,
  openRaw,
  seedViewBoundary,
  type TempStore,
  tempStore,
  validEvent,
} from "./fixtures/index.js";

// "tok" tokenizes to exactly one o200k token, joined or leading-space alike,
// so a content of n joined "tok" words carries token_estimate n.
function tokens(n: number): string {
  return Array<string>(n).fill("tok").join(" ");
}

const BUDGETS = { maxTokens: 100, targetTokens: 60 };

const stores: TempStore[] = [];
afterEach(() => {
  setSchedulerPoke(null);
  for (const store of stores.splice(0)) store.cleanup();
});

function visSdk(view: SdkViewConfig = { visibility: BUDGETS }, mode: "manual" | "background" = "manual"): Lhc {
  return initLhc({ inferenceCallbacks: createInferenceCallbacksDouble(), mode, view });
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
  const toolCallId = `call-vb-${callCounter}`;
  return [
    validEvent("tool_call", {
      payload: { toolCallId, toolName: "read_file", arguments: { path: `vb-${callCounter}.txt` } },
    }),
    validEvent("tool_result", {
      payload: { toolCallId, content: tokens(resultTokens), isError: false },
    }),
  ];
}

function toolTurn(resultTokens: readonly number[], opts: { turnEnd?: boolean } = {}): MessageEventInput[] {
  const events: MessageEventInput[] = [validEvent("user_prompt", { payload: { text: "scripted boundary turn" } })];
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

function messageTexts(messages: ReadonlyArray<{ content: readonly { text: string }[] }>): string[] {
  return messages.map((message) => messageText(message));
}

function abridgedCount(messages: ReadonlyArray<{ content: readonly { text: string }[] }>): number {
  return messages.filter((m) => {
    const text = messageText(m);
    return text.startsWith("[tool result · ") && text.includes(" · abridged]");
  }).length;
}

describe("TC-4.1 (AC-4.3): under-max intake never moves the boundary; a seeded position flips whole turns", () => {
  it("holds position below max, then respects a seeded boundary that flips the oldest whole turn", async () => {
    const sdk = visSdk();
    const filePath = await newThread(sdk);

    await intake(sdk, filePath, toolTurn([20, 20]));
    const afterFirst = await sdk.threadView.getLlmRequestContext({ filePath });
    expect(afterFirst.ok).toBe(true);
    if (!afterFirst.ok) return;
    expect(await boundaryOf(filePath)).toBe(0);

    await intake(sdk, filePath, toolTurn([20, 20]));
    const afterSecond = await sdk.threadView.getLlmRequestContext({ filePath });
    expect(afterSecond.ok).toBe(true);
    if (!afterSecond.ok) return;
    expect(await boundaryOf(filePath)).toBe(0);
    expect(afterSecond.value.messages.slice(0, afterFirst.value.messages.length)).toEqual(afterFirst.value.messages);
    expect(abridgedCount(afterSecond.value.messages)).toBe(0);

    await intake(sdk, filePath, toolTurn([20, 20]));
    const results = await toolResults(sdk, filePath);
    expect(results).toHaveLength(6);
    expect(await boundaryOf(filePath)).toBe(0);

    const expectedPosition = results[1]?.sourceEventOrder ?? 0;
    seedViewBoundary(filePath, expectedPosition);
    const crossed = await sdk.threadView.getLlmRequestContext({ filePath });
    expect(crossed.ok).toBe(true);
    if (!crossed.ok) return;
    expect(await boundaryOf(filePath)).toBe(expectedPosition);
    expect(abridgedCount(crossed.value.messages)).toBe(2);

    const abridgedIds = results.filter((r) => r.sourceEventOrder <= expectedPosition).map((r) => r.messageId);
    expect(abridgedIds).toEqual(results.slice(0, 2).map((r) => r.messageId));

    const status = await sdk.threadView.status({ filePath });
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    const expectedZone = results
      .filter((r) => r.sourceEventOrder > expectedPosition)
      .reduce((sum, r) => sum + r.tokenEstimate, 0);
    expect(status.value.visibility.zoneTokens).toBe(expectedZone);
    expect(status.value.visibility.zoneTokens).toBe(80);

    await intake(sdk, filePath, toolTurn([10]));
    expect(await boundaryOf(filePath)).toBe(expectedPosition);
  });
});

describe("TC-4.2 (AC-4.1, AC-4.2): flipped renders — full-band boundary uses deterministic truncation; non-tool content untouched", () => {
  it.skip("renders deterministic tool-result floors even when a ready summary exists", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = initLhc({
      inferenceCallbacks: double,
      mode: "manual",
      view: { visibility: BUDGETS },
      toolResult: { smallTierTokens: 1, smallTargetRatio: 0.15, midTargetRatio: 0.04 },
    });
    const filePath = await newThread(sdk);

    await intake(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "flip rendering prompt" } }),
      ...toolRun(60),
      validEvent("assistant_text", { payload: { text: "interleaved assistant text" } }),
      ...toolRun(20),
      validEvent("turn_end"),
    ]);
    double.failKind("tool_result_summary", 1, {
      retryable: false,
      reason: "content_refusal: scripted permanent failure (boundary test)",
    });
    const drained = await sdk.work.drain({ filePath });
    expect(drained.ok).toBe(true);

    const listed = await sdk.messages.list({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const results = listed.value.filter((m) => m.kind === "tool_result");
    const [r1, r2] = results;
    expect(r1 && r2).toBeTruthy();
    if (r1 === undefined || r2 === undefined) return;
    expect(r1.derivations?.find((f) => f.derivationType === "tool_result_summary")?.state).toBe("ready");
    const r2Summary = r2.derivations?.find(
      (f) => f.derivationType === "tool_result_summary" && f.state === "ready",
    )?.content;
    expect(r2Summary).toBeDefined();

    await intake(sdk, filePath, toolTurn([80]));
    seedViewBoundary(filePath, r2.sourceEventOrder);

    const contextRead = await sdk.threadView.getLlmRequestContext({ filePath });
    expect(contextRead.ok).toBe(true);
    if (!contextRead.ok) return;
    const contents = messageTexts(contextRead.value.messages);

    expect(contents).toContain(`[tool result · read_file · abridged]\n${tokens(60)}`);
    expect(contents).toContain(`[tool result · read_file · abridged]\n${tokens(20)}`);
    expect(contents).not.toContain(`[tool result · read_file · abridged]\n${r2Summary}`);
    expect(contents).toContain("interleaved assistant text");
    expect(contents).toContain(`[tool result · read_file]\n${tokens(80)}`);
  });
});

describe("TC-4.4 (AC-4.6, AC-4.7): compact resets to the compact point; fresh tail renders full", () => {
  it("resets a seeded boundary to the compact point with a full fresh tail", async () => {
    const sdk = visSdk();
    const filePath = await newThread(sdk);
    for (let i = 0; i < 3; i += 1) await intake(sdk, filePath, toolTurn([20, 20]));
    const results = await toolResults(sdk, filePath);
    const seededPosition = results[1]?.sourceEventOrder ?? 0;
    seedViewBoundary(filePath, seededPosition);
    expect(await boundaryOf(filePath)).toBe(seededPosition);

    const receipt = await sdk.threadView.compact({ filePath }, { params: { lowerBound: 40 } });
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    const afterCompact = await sdk.threadView.getLlmRequestContext({ filePath });
    expect(afterCompact.ok).toBe(true);
    if (!afterCompact.ok) return;
    expect(await boundaryOf(filePath)).toBe(receipt.value.compactPoint);

    await intake(sdk, filePath, toolTurn([20]));
    const fresh = await sdk.threadView.getLlmRequestContext({ filePath });
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(abridgedCount(fresh.value.messages)).toBe(0);
    expect(messageTexts(fresh.value.messages)).toContain(`[tool result · read_file]\n${tokens(20)}`);
  });
});

describe("TC-4.5 (AC-4.8 as amended by Epic 05 AC-5.4): budget validation names the violated constraint", () => {
  it("rejects max ≤ target at construction, naming the constraint", () => {
    expect(() => visSdk({ visibility: { maxTokens: 100, targetTokens: 200 } })).toThrow(
      /maxTokens \(100\) must be greater than targetTokens \(200\)/,
    );
  });
});

describe("TC-4.6 (AC-4.9): intake never auto-advances; over-max zone stays visible in status", () => {
  it("background mode: intake commits over-max tool results with boundary unchanged and drain still runs", async () => {
    const sdk = visSdk({ visibility: BUDGETS }, "background");
    const filePath = await newThread(sdk);

    const result = await sdk.intakeStream.messageEvents({ filePath }, [
      ...toolTurn([40]),
      ...toolTurn([40]),
      ...toolTurn([40]),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.events.every((e) => e.outcome === "recorded")).toBe(true);

    const results = await toolResults(sdk, filePath);
    expect(results).toHaveLength(3);
    expect(await boundaryOf(filePath)).toBe(0);
    const status = await sdk.threadView.status({ filePath });
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.value.visibility.zoneTokens).toBe(120);
    expect(status.value.visibility.zoneTokens).toBeGreaterThan(status.value.visibility.maxTokens);

    await sdk.drainSettled({ filePath });
    const listed = await sdk.messages.list({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    for (const m of listed.value.filter((msg) => msg.kind === "tool_result")) {
      expect(m.derivations?.find((f) => f.derivationType === "tool_result_summary")?.state).toBe("ready");
    }
  });
});

describe("deleted-filter consistency: status zone sum skips deleted results", () => {
  it("drops a deleted zone result from the live sum", async () => {
    const sdk = visSdk();
    const filePath = await newThread(sdk);
    await intake(sdk, filePath, toolTurn([40, 40]));
    expect(await boundaryOf(filePath)).toBe(0);

    const results = await toolResults(sdk, filePath);
    const deleted = await sdk.messages.remove({ filePath }, { messageId: results[0]?.messageId ?? "" });
    expect(deleted.ok).toBe(true);
    const status = await sdk.threadView.status({ filePath });
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.value.visibility.zoneTokens).toBe(40);
  });
});

describe("both host modes leave the boundary at intake (story DoD)", () => {
  it.each(["manual", "background"] as const)("%s-mode SDK intake does not auto-advance the boundary", async (mode) => {
    const sdk = visSdk({ visibility: BUDGETS }, mode);
    const filePath = await newThread(sdk);
    await intake(sdk, filePath, [...toolTurn([40]), ...toolTurn([40]), ...toolTurn([40])]);
    expect(await boundaryOf(filePath)).toBe(0);
    if (mode === "background") await sdk.drainSettled({ filePath });
  });
});
