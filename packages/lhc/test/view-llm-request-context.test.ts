import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initLhc, type Lhc, type LlmRequestContextMessage, type SdkViewConfig } from "../src/index.js";
import {
  blockedSiblingThread,
  createInferenceCallbacksDouble,
  type DerivedThreadFixture,
  derivedThreadFixture,
  openRaw,
  seedViewBoundary,
  type TempStore,
  tempStore,
  validEvent,
} from "./fixtures/index.js";

let store: TempStore;
let fixture: DerivedThreadFixture;

beforeAll(async () => {
  store = tempStore();
  fixture = await derivedThreadFixture(store);
});
afterAll(() => {
  store.cleanup();
});

function manualSdk(view?: SdkViewConfig): Lhc {
  return initLhc({
    tokenFamily: "o200k",
    inferenceCallbacks: createInferenceCallbacksDouble(),
    mode: "manual",
    ...(view === undefined ? {} : { view }),
  });
}

async function newThread(sdk: Lhc): Promise<string> {
  const filePath = store.threadPath();
  const created = await sdk.threads.newThread({ filePath, registryPath: store.registryPath });
  if (!created.ok) throw new Error(`thread creation failed: ${created.error.reason}`);
  return filePath;
}

async function intake(
  sdk: Lhc,
  filePath: string,
  batch: Parameters<Lhc["intakeStream"]["messageEvents"]>[1],
): Promise<void> {
  const result = await sdk.intakeStream.messageEvents({ filePath }, batch);
  if (!result.ok) throw new Error(`intake failed: ${result.error.reason}`);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function textPart(text: string): [{ type: "text"; text: string }] {
  return [{ type: "text", text }];
}

function messageText(message: LlmRequestContextMessage | undefined): string | undefined {
  return message?.content.map((part) => part.text).join("");
}

function workItemCount(filePath: string): number {
  const db = openRaw(filePath);
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM work_item`).get() as {
      n: number | bigint;
    };
    return Number(row.n);
  } finally {
    db.close();
  }
}

function stateSnapshot(filePath: string): Record<string, unknown> {
  const db = openRaw(filePath);
  try {
    return {
      workItems: (
        db.prepare(`SELECT work_item_id, status FROM work_item ORDER BY work_item_id`).all() as unknown as Array<{
          work_item_id: string;
          status: string;
        }>
      ).map((row) => ({ id: row.work_item_id, status: row.status })),
      derivations: db
        .prepare(`SELECT subject_id, derivation_type, state FROM derivation ORDER BY subject_id, derivation_type`)
        .all(),
      viewRows: Number((db.prepare(`SELECT COUNT(*) AS n FROM thread_view`).get() as { n: number | bigint }).n),
      boundary: Number(
        (db.prepare(`SELECT position FROM view_boundary`).get() as { position: number | bigint }).position,
      ),
    };
  } finally {
    db.close();
  }
}

describe("TC-1.1 (AC-1.2, AC-1.3): never-compacted thread returns full model context in order; later intake appends", () => {
  it("carries threadId and both intake rounds in record order", async () => {
    const sdk = manualSdk();
    const filePath = await newThread(sdk);
    await intake(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "first question" } }),
      validEvent("assistant_text", { payload: { text: "first answer" } }),
      validEvent("turn_end"),
    ]);

    const first = await sdk.threadView.getLlmRequestContext({ filePath });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const info = await sdk.threads.info({ filePath });
    expect(info.ok).toBe(true);
    if (!info.ok) return;
    expect(first.value.threadId).toBe(info.value.threadId);
    expect(first.value.messages).toEqual([
      { role: "user", content: textPart("first question") },
      { role: "assistant", content: textPart("first answer") },
    ]);

    await intake(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "second question" } }),
      validEvent("assistant_text", { payload: { text: "second answer" } }),
      validEvent("turn_end"),
    ]);
    const second = await sdk.threadView.getLlmRequestContext({ filePath });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.messages).toEqual([
      { role: "user", content: textPart("first question") },
      { role: "assistant", content: textPart("first answer") },
      { role: "user", content: textPart("second question") },
      { role: "assistant", content: textPart("second answer") },
    ]);
  });
});

describe("TC-1.2 (AC-1.1, AC-1.7): two model-context reads with nothing between are byte-identical and create no work or model calls", () => {
  it("hashes identical, zero work rows created, inference callbacks double observes zero calls", async () => {
    const captured = fixture.double.captureInputs();
    const before = stateSnapshot(fixture.filePath);
    const workRowsBefore = workItemCount(fixture.filePath);

    const one = await fixture.sdk.threadView.getLlmRequestContext({ filePath: fixture.filePath });
    const two = await fixture.sdk.threadView.getLlmRequestContext({ filePath: fixture.filePath });
    expect(one.ok && two.ok).toBe(true);
    if (!one.ok || !two.ok) return;

    expect(sha256(one.value)).toBe(sha256(two.value));
    expect(JSON.stringify(one.value)).toBe(JSON.stringify(two.value));

    expect(workItemCount(fixture.filePath)).toBe(workRowsBefore);
    expect(stateSnapshot(fixture.filePath)).toEqual(before);
    expect(captured.length).toBe(0);
  });
});

describe("tail mapping legs (architecture-risk): one named leg per message kind", () => {
  let sdk: Lhc;
  let filePath: string;
  let contextMessages: LlmRequestContextMessage[];

  beforeAll(async () => {
    sdk = manualSdk();
    filePath = await newThread(sdk);
    await intake(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "mapping prompt" } }),
      validEvent("assistant_thinking", { payload: { text: "mapping thought" } }),
      validEvent("tool_call", {
        payload: { toolCallId: "call-map-1", toolName: "read_file", arguments: { path: "map.txt" } },
      }),
      validEvent("tool_result", {
        payload: { toolCallId: "call-map-1", content: "mapping output", isError: false },
      }),
      validEvent("runtime_note", { payload: { text: "mapping note" } }),
      validEvent("assistant_text", { payload: { text: "mapping answer" } }),
      validEvent("turn_end"),
    ]);
    const result = await sdk.threadView.getLlmRequestContext({ filePath });
    if (!result.ok) throw new Error(`model context failed: ${result.error.reason}`);
    contextMessages = result.value.messages;
  });

  it("user_prompt: user role, text verbatim", () => {
    expect(contextMessages[0]).toEqual({ role: "user", content: textPart("mapping prompt") });
  });

  it("assistant_thinking: assistant role, fenced [thinking] block", () => {
    expect(contextMessages[1]).toEqual({
      role: "assistant",
      content: textPart("[thinking]\nmapping thought\n[/thinking]"),
    });
  });

  it("tool_call: assistant role, name marker plus deterministic arg rendering", () => {
    expect(contextMessages[2]).toEqual({
      role: "assistant",
      content: textPart('[tool call · read_file] {"path":"map.txt"}'),
    });
  });

  it("tool_result ahead of the boundary: user role, name marker plus full content", () => {
    expect(contextMessages[3]).toEqual({
      role: "user",
      content: textPart("[tool result · read_file]\nmapping output"),
    });
  });

  it("runtime_note: user role, [runtime note] marker plus text", () => {
    expect(contextMessages[4]).toEqual({ role: "user", content: textPart("[runtime note] mapping note") });
  });

  it("assistant_text: assistant role, text verbatim", () => {
    expect(contextMessages[5]).toEqual({ role: "assistant", content: textPart("mapping answer") });
  });

  it("tool_result at-or-behind the boundary: abridged marker plus short form (boundary seeded below-SDK)", async () => {
    const listed = await sdk.messages.list({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const result = listed.value.find((m) => m.kind === "tool_result");
    expect(result).toBeDefined();
    if (result === undefined) return;
    seedViewBoundary(filePath, result.sourceEventOrder);

    const refreshedContext = await sdk.threadView.getLlmRequestContext({ filePath });
    expect(refreshedContext.ok).toBe(true);
    if (!refreshedContext.ok) return;
    const short = refreshedContext.value.messages[3];
    expect(short).toEqual({
      role: "user",
      content: textPart("[tool result · read_file · abridged]\nmapping output"),
    });
  });
});

describe("TC-1.4 (AC-1.5): boundary mid-tail — short behind, full ahead, non-tool content full everywhere", () => {
  it.skip("renders deterministic tool-result floors behind the boundary and full content ahead of it", async () => {
    const sdk = initLhc({
      tokenFamily: "o200k",
      inferenceCallbacks: createInferenceCallbacksDouble(),
      mode: "manual",
      toolResult: { smallTierTokens: 1, smallTargetRatio: 0.15, midTargetRatio: 0.04 },
    });
    const filePath = await newThread(sdk);
    for (const turn of [1, 2]) {
      await intake(sdk, filePath, [
        validEvent("user_prompt", { payload: { text: `boundary prompt ${turn}` } }),
        validEvent("assistant_thinking", { payload: { text: `boundary thought ${turn}` } }),
        validEvent("tool_call", {
          payload: {
            toolCallId: `call-bd-${turn}`,
            toolName: "read_file",
            arguments: { path: `bd-${turn}.txt` },
          },
        }),
        validEvent("tool_result", {
          payload: { toolCallId: `call-bd-${turn}`, content: `boundary output ${turn}`, isError: false },
        }),
        validEvent("assistant_text", { payload: { text: `boundary answer ${turn}` } }),
        validEvent("turn_end"),
      ]);
    }
    const drained = await sdk.work.drain({ filePath });
    expect(drained.ok).toBe(true);

    const listed = await sdk.messages.list({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const results = listed.value.filter((m) => m.kind === "tool_result");
    expect(results).toHaveLength(2);
    const [behind, ahead] = results;
    if (behind === undefined || ahead === undefined) return;
    const behindSummary = behind.derivations?.find(
      (derivation) => derivation.derivationType === "tool_result_summary" && derivation.state === "ready",
    );
    expect(behindSummary?.content).toBeDefined();

    seedViewBoundary(filePath, behind.sourceEventOrder);

    const context = await sdk.threadView.getLlmRequestContext({ filePath });
    expect(context.ok).toBe(true);
    if (!context.ok) return;
    const contents = context.value.messages.map((m) => messageText(m));

    expect(contents).toContain("[tool result · read_file · abridged]\nboundary output 1");
    expect(contents).not.toContain(`[tool result · read_file · abridged]\n${behindSummary?.content}`);
    expect(contents).toContain("[tool result · read_file]\nboundary output 2");
    for (const turn of [1, 2]) {
      expect(contents).toContain(`boundary prompt ${turn}`);
      expect(contents).toContain(`[thinking]\nboundary thought ${turn}\n[/thinking]`);
      expect(contents).toContain(`boundary answer ${turn}`);
    }
  });

  it("falls to deterministic truncation when no summary is ready and the content is oversized", async () => {
    const sdk = manualSdk();
    const filePath = await newThread(sdk);
    const longContent = "x".repeat(560);
    await intake(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "truncation prompt" } }),
      validEvent("tool_call", {
        payload: { toolCallId: "call-tr-1", toolName: "read_file", arguments: { path: "tr.txt" } },
      }),
      validEvent("tool_result", {
        payload: { toolCallId: "call-tr-1", content: longContent, isError: false },
      }),
      validEvent("turn_end"),
    ]);
    const listed = await sdk.messages.list({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const result = listed.value.find((m) => m.kind === "tool_result");
    if (result === undefined) return;
    seedViewBoundary(filePath, result.sourceEventOrder);

    const context = await sdk.threadView.getLlmRequestContext({ filePath });
    expect(context.ok).toBe(true);
    if (!context.ok) return;
    const short = context.value.messages.find((m) => messageText(m)?.startsWith("[tool result"));
    expect(messageText(short)).toBe(`[tool result · read_file · abridged]\n${"x".repeat(500)}… [truncated 60 chars]`);
  });
});

describe("TC-2.5 pre-compact legs (AC-2.8): the status read on a heavy thread", () => {
  let heavyStore: TempStore;
  let heavy: DerivedThreadFixture;
  let statusSdk: Lhc;

  beforeAll(async () => {
    heavyStore = tempStore();
    heavy = await derivedThreadFixture(heavyStore);
    statusSdk = manualSdk({ compactThreshold: 100 });
  });
  afterAll(() => {
    heavyStore.cleanup();
  });

  it("reports tail tokens vs threshold, recommendation, derivation counts, null view health, and the zone sum — reads only", async () => {
    const captured = heavy.double.captureInputs();
    const before = stateSnapshot(heavy.filePath);

    const status = await statusSdk.threadView.status({ filePath: heavy.filePath });
    expect(status.ok).toBe(true);
    if (!status.ok) return;

    expect(status.value.threshold).toBe(100);
    expect(status.value.tailTokens).toBeGreaterThan(100);
    expect(status.value.compactRecommended).toBe(true);

    expect(status.value.derivation).toEqual({ pending: 0, failed: 2, blocked: 0 });

    expect(status.value.view).toBeNull();

    const listed = await statusSdk.messages.list({ filePath: heavy.filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const expectedZone = listed.value
      .filter((m) => m.kind === "tool_result")
      .reduce((sum, m) => sum + m.tokenEstimate, 0);
    expect(status.value.visibility).toEqual({ boundaryPosition: 0, zoneTokens: expectedZone, maxTokens: 64000 });

    expect(stateSnapshot(heavy.filePath)).toEqual(before);
    expect(captured.length).toBe(0);
  });

  it("counts blocked derivations through the owner's report (sacrificial sibling)", async () => {
    const sibling = await blockedSiblingThread(heavyStore);
    const status = await sibling.sdk.threadView.status({ filePath: sibling.filePath });
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.value.derivation.blocked).toBe(2);
    expect(status.value.view).toBeNull();
  });

  it("after more intake the tail grew; still no compact without invocation", async () => {
    const first = await statusSdk.threadView.status({ filePath: heavy.filePath });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    await intake(heavy.sdk, heavy.filePath, [
      validEvent("user_prompt", { payload: { text: "one more question for the heavy thread" } }),
      validEvent("assistant_text", { payload: { text: "one more answer for the heavy thread" } }),
      validEvent("turn_end"),
    ]);

    const second = await statusSdk.threadView.status({ filePath: heavy.filePath });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.tailTokens).toBeGreaterThan(first.value.tailTokens);
    expect(second.value.view).toBeNull();
    expect(stateSnapshot(heavy.filePath)["viewRows"]).toBe(0);
  });
});

describe("TC-1.2 / TC-2.5 background legs (SV-01-PULL-STATUS-001): model context and status are reads-only in a background SDK with pending work queued", () => {
  it("schedules no catch-up drain: work rows, derivation states, inference callback count, and status all unchanged; repeated model-context reads byte-identical", async () => {
    const seeder = manualSdk();
    const filePath = await newThread(seeder);
    await intake(seeder, filePath, [
      validEvent("user_prompt", { payload: { text: "background prompt" } }),
      validEvent("tool_call", {
        payload: { toolCallId: "call-bg-1", toolName: "read_file", arguments: { path: "bg.txt" } },
      }),
      validEvent("tool_result", {
        payload: { toolCallId: "call-bg-1", content: "background output", isError: false },
      }),
      validEvent("assistant_text", { payload: { text: "background answer" } }),
      validEvent("turn_end"),
    ]);
    expect(workItemCount(filePath)).toBeGreaterThan(0);

    const bgDouble = createInferenceCallbacksDouble();
    const bg = initLhc({
      tokenFamily: "o200k",
      inferenceCallbacks: bgDouble,
      mode: "background",
      view: { compactThreshold: 100 },
    });
    const captured = bgDouble.captureInputs();
    const before = stateSnapshot(filePath);

    const one = await bg.threadView.getLlmRequestContext({ filePath });
    const firstStatus = await bg.threadView.status({ filePath });
    const two = await bg.threadView.getLlmRequestContext({ filePath });
    expect(one.ok && two.ok && firstStatus.ok).toBe(true);
    if (!one.ok || !two.ok || !firstStatus.ok) return;

    expect(firstStatus.value.derivation.pending).toBeGreaterThan(0);

    await new Promise((resolve) => setTimeout(resolve, 25));
    await bg.drainSettled({ filePath });

    expect(sha256(one.value)).toBe(sha256(two.value));
    expect(JSON.stringify(one.value)).toBe(JSON.stringify(two.value));

    expect(stateSnapshot(filePath)).toEqual(before);
    expect(captured.length).toBe(0);

    const secondStatus = await bg.threadView.status({ filePath });
    expect(secondStatus.ok).toBe(true);
    if (!secondStatus.ok) return;
    expect(JSON.stringify(secondStatus.value)).toBe(JSON.stringify(firstStatus.value));
  });
});
