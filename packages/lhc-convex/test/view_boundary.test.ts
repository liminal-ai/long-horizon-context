// Visibility boundary rendering and the no-auto-advance intake contract.
// Seeded-boundary tests prove rendering respects a stored position; intake
// never moves the boundary on its own.
import { afterEach, describe, expect, it } from "vitest";
import type { Lhc, MessageEventInput, SdkConfig } from "../src/client/index.js";
import { type ServiceFixture, serviceFixture, validEvent } from "./fixtures/index.js";

// "tok" tokenizes to exactly one o200k token, joined or leading-space alike,
// so a content of n joined "tok" words carries token_estimate n.
function tokens(n: number): string {
  return Array<string>(n).fill("tok").join(" ");
}

const BUDGETS = { maxTokens: 100, targetTokens: 60 };

const fixtures: ServiceFixture[] = [];
afterEach(() => {
  fixtures.splice(0);
});

function visFixture(
  view: SdkConfig["view"] = { visibility: BUDGETS },
  mode: "manual" | "background" = "manual",
): ServiceFixture {
  const fixture = serviceFixture({ view, mode });
  fixtures.push(fixture);
  return fixture;
}

async function newThread(fixture: ServiceFixture): Promise<string> {
  return (await fixture.createThread()).filePath;
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

// Background auto-drain cannot be driven to completion under convex-test
// (harness limitation, not a Convex behavior gap), so background legs settle
// pending work through the explicit drain action instead of drainSettled.
async function drainAll(sdk: Lhc, filePath: string): Promise<void> {
  for (;;) {
    const report = await sdk.work.drain({ filePath });
    if (!report.ok) throw new Error(`drain failed: ${report.error.reason}`);
    if (report.value.remaining === 0) return;
  }
}

async function boundaryOf(fixture: ServiceFixture): Promise<number> {
  return await fixture.test.run(async (ctx) => {
    const rows = await ctx.db.query("viewBoundaries").collect();
    const row = rows.find((candidate) => candidate.instance === fixture.instance);
    if (row === undefined) throw new Error("view boundary missing");
    return row.position;
  });
}

async function seedViewBoundary(fixture: ServiceFixture, position: number): Promise<void> {
  await fixture.test.run(async (ctx) => {
    const rows = await ctx.db.query("viewBoundaries").collect();
    const row = rows.find((candidate) => candidate.instance === fixture.instance);
    if (row === undefined) throw new Error("view boundary missing");
    await ctx.db.patch("viewBoundaries", row._id, { position });
  });
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
    const fixture = visFixture();
    const filePath = await newThread(fixture);

    await intake(fixture.sdk, filePath, toolTurn([20, 20]));
    const afterFirst = await fixture.sdk.threadView.getLlmRequestContext({ filePath });
    expect(afterFirst.ok).toBe(true);
    if (!afterFirst.ok) return;
    expect(await boundaryOf(fixture)).toBe(0);

    await intake(fixture.sdk, filePath, toolTurn([20, 20]));
    const afterSecond = await fixture.sdk.threadView.getLlmRequestContext({ filePath });
    expect(afterSecond.ok).toBe(true);
    if (!afterSecond.ok) return;
    expect(await boundaryOf(fixture)).toBe(0);
    expect(afterSecond.value.messages.slice(0, afterFirst.value.messages.length)).toEqual(afterFirst.value.messages);
    expect(abridgedCount(afterSecond.value.messages)).toBe(0);

    await intake(fixture.sdk, filePath, toolTurn([20, 20]));
    const results = await toolResults(fixture.sdk, filePath);
    expect(results).toHaveLength(6);
    expect(await boundaryOf(fixture)).toBe(0);

    const expectedPosition = results[1]?.sourceEventOrder ?? 0;
    await seedViewBoundary(fixture, expectedPosition);
    const crossed = await fixture.sdk.threadView.getLlmRequestContext({ filePath });
    expect(crossed.ok).toBe(true);
    if (!crossed.ok) return;
    expect(await boundaryOf(fixture)).toBe(expectedPosition);
    expect(abridgedCount(crossed.value.messages)).toBe(2);

    const abridgedIds = results.filter((r) => r.sourceEventOrder <= expectedPosition).map((r) => r.messageId);
    expect(abridgedIds).toEqual(results.slice(0, 2).map((r) => r.messageId));

    const status = await fixture.sdk.threadView.status({ filePath });
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    const expectedZone = results
      .filter((r) => r.sourceEventOrder > expectedPosition)
      .reduce((sum, r) => sum + r.tokenEstimate, 0);
    expect(status.value.visibility.zoneTokens).toBe(expectedZone);
    expect(status.value.visibility.zoneTokens).toBe(80);

    await intake(fixture.sdk, filePath, toolTurn([10]));
    expect(await boundaryOf(fixture)).toBe(expectedPosition);
  });
});

describe("TC-4.2 (AC-4.1, AC-4.2): flipped renders — full-band boundary uses deterministic truncation; non-tool content untouched", () => {
  // Skipped upstream in packages/lhc (frozen): the "render deterministic floors
  // even when a ready summary exists" behavior is not finalized. Kept skipped
  // and adapted to the Convex surface for parity.
  it.skip("renders deterministic tool-result floors even when a ready summary exists", async () => {
    const fixture = serviceFixture({
      mode: "manual",
      view: { visibility: BUDGETS },
      toolResult: { smallTierTokens: 1, smallTargetRatio: 0.15, midTargetRatio: 0.04 },
      models: { tool_result_summary: "failure:content_refusal:scripted permanent failure (boundary test)" },
    });
    const filePath = (await fixture.createThread()).filePath;

    await intake(fixture.sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "flip rendering prompt" } }),
      ...toolRun(60),
      validEvent("assistant_text", { payload: { text: "interleaved assistant text" } }),
      ...toolRun(20),
      validEvent("turn_end"),
    ]);
    const drained = await fixture.sdk.work.drain({ filePath });
    expect(drained.ok).toBe(true);

    const listed = await fixture.sdk.messages.list({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const results = listed.value.filter((m) => m.kind === "tool_result");
    const [r1, r2] = results;
    expect(r1 && r2).toBeTruthy();
    if (r1 === undefined || r2 === undefined) return;
    const r2Summary = r2.derivations?.find(
      (f) => f.derivationType === "tool_result_summary" && f.state === "ready",
    )?.content;

    await intake(fixture.sdk, filePath, toolTurn([80]));
    await seedViewBoundary(fixture, r2.sourceEventOrder);

    const contextRead = await fixture.sdk.threadView.getLlmRequestContext({ filePath });
    expect(contextRead.ok).toBe(true);
    if (!contextRead.ok) return;
    const contents = messageTexts(contextRead.value.messages);

    expect(contents).toContain(`[tool result · read_file · abridged]\n${tokens(60)}`);
    expect(contents).toContain(`[tool result · read_file · abridged]\n${tokens(20)}`);
    if (r2Summary !== undefined) {
      expect(contents).not.toContain(`[tool result · read_file · abridged]\n${r2Summary}`);
    }
    expect(contents).toContain("interleaved assistant text");
    expect(contents).toContain(`[tool result · read_file]\n${tokens(80)}`);
  });
});

describe("TC-4.4 (AC-4.6, AC-4.7): compact resets to the compact point; fresh tail renders full", () => {
  it("resets a seeded boundary to the compact point with a full fresh tail", async () => {
    const fixture = visFixture();
    const filePath = await newThread(fixture);
    for (let i = 0; i < 3; i += 1) await intake(fixture.sdk, filePath, toolTurn([20, 20]));
    const results = await toolResults(fixture.sdk, filePath);
    const seededPosition = results[1]?.sourceEventOrder ?? 0;
    await seedViewBoundary(fixture, seededPosition);
    expect(await boundaryOf(fixture)).toBe(seededPosition);

    const receipt = await fixture.sdk.threadView.compact({ filePath }, { params: { lowerBound: 40 } });
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    const afterCompact = await fixture.sdk.threadView.getLlmRequestContext({ filePath });
    expect(afterCompact.ok).toBe(true);
    if (!afterCompact.ok) return;
    expect(await boundaryOf(fixture)).toBe(receipt.value.compactPoint);

    await intake(fixture.sdk, filePath, toolTurn([20]));
    const fresh = await fixture.sdk.threadView.getLlmRequestContext({ filePath });
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(abridgedCount(fresh.value.messages)).toBe(0);
    expect(messageTexts(fresh.value.messages)).toContain(`[tool result · read_file]\n${tokens(20)}`);
  });
});

describe("TC-4.5 (AC-4.8 as amended by Epic 05 AC-5.4): budget validation names the violated constraint", () => {
  it("rejects max ≤ target at construction, naming the constraint", () => {
    expect(() => visFixture({ visibility: { maxTokens: 100, targetTokens: 200 } })).toThrow(
      /maxTokens \(100\) must be greater than targetTokens \(200\)/,
    );
  });
});

describe("TC-4.6 (AC-4.9): intake never auto-advances; over-max zone stays visible in status", () => {
  it("background mode: intake commits over-max tool results with boundary unchanged and drain still runs", async () => {
    const fixture = visFixture({ visibility: BUDGETS }, "background");
    const filePath = await newThread(fixture);

    const result = await fixture.sdk.intakeStream.messageEvents({ filePath }, [
      ...toolTurn([40]),
      ...toolTurn([40]),
      ...toolTurn([40]),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.events.every((e) => e.outcome === "recorded")).toBe(true);

    const results = await toolResults(fixture.sdk, filePath);
    expect(results).toHaveLength(3);
    expect(await boundaryOf(fixture)).toBe(0);
    const status = await fixture.sdk.threadView.status({ filePath });
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.value.visibility.zoneTokens).toBe(120);
    expect(status.value.visibility.zoneTokens).toBeGreaterThan(status.value.visibility.maxTokens);

    await drainAll(fixture.sdk, filePath);
    const listed = await fixture.sdk.messages.list({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    for (const m of listed.value.filter((msg) => msg.kind === "tool_result")) {
      expect(m.derivations?.find((f) => f.derivationType === "tool_result_summary")?.state).toBe("ready");
    }
  });
});

describe("deleted-filter consistency: status zone sum skips deleted results", () => {
  it("drops a deleted zone result from the live sum", async () => {
    const fixture = visFixture();
    const filePath = await newThread(fixture);
    await intake(fixture.sdk, filePath, toolTurn([40, 40]));
    expect(await boundaryOf(fixture)).toBe(0);

    const results = await toolResults(fixture.sdk, filePath);
    const deleted = await fixture.sdk.messages.remove({ filePath }, { messageId: results[0]?.messageId ?? "" });
    expect(deleted.ok).toBe(true);
    const status = await fixture.sdk.threadView.status({ filePath });
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.value.visibility.zoneTokens).toBe(40);
  });
});

describe("both host modes leave the boundary at intake (story DoD)", () => {
  it.each(["manual", "background"] as const)("%s-mode SDK intake does not auto-advance the boundary", async (mode) => {
    const fixture = visFixture({ visibility: BUDGETS }, mode);
    const filePath = await newThread(fixture);
    await intake(fixture.sdk, filePath, [...toolTurn([40]), ...toolTurn([40]), ...toolTurn([40])]);
    expect(await boundaryOf(fixture)).toBe(0);
    if (mode === "background") await drainAll(fixture.sdk, filePath);
  });
});
