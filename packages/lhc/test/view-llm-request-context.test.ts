// Epic 03 Story 1: model context and status on the record (TC-1.1, TC-1.2, TC-1.4,
// TC-2.5 pre-compact legs, the per-kind tail-mapping legs, and the model-context/status
// legs of the suite-wide zero-model assertion). Every TC goes through the
// real SDK surface (initLhc().threadView.model-context/status) against real temp
// thread files; the inference callbacks double appears only in construction/fixture
// setup — no Epic 03 operation may touch it.
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

// Below-SDK read-only snapshot of everything a read could illegally mutate:
// queue rows, derivation states, view rows, boundary position (TC-1.2 / TC-2.5
// reads-only assertions).
function stateSnapshot(filePath: string): Record<string, unknown> {
  const db = openRaw(filePath);
  try {
    return {
      workItems: (
        db
          .prepare(`SELECT work_item_id, status, attempts FROM work_item ORDER BY work_item_id`)
          .all() as unknown as Array<{ work_item_id: string; status: string; attempts: number | bigint }>
      ).map((row) => ({ id: row.work_item_id, status: row.status, attempts: Number(row.attempts) })),
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

// Surface-skeleton describe retired (Epic 03 Story 5, sanctioned amendment):
// every thread-view operation is real now — compact since Story 2, sweep
// since Story 3, materialize since Story 5 (view-render-targets.test.ts owns
// the operation). No stubbed op remains on this surface.

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
    // All committed intake appears, in record order; the new batch appends
    // after the first round's messages, which are byte-unchanged (AC-1.2).
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
    // The double's capture log starts recording here; any Epic 03 read that
    // touched inference callbacks would append to it (zero-model assertion, model-context
    // leg of the suite-wide architecture-risk row).
    const captured = fixture.double.captureInputs();
    const before = stateSnapshot(fixture.filePath);
    const workRowsBefore = workItemCount(fixture.filePath);

    const one = await fixture.sdk.threadView.getLlmRequestContext({ filePath: fixture.filePath });
    const two = await fixture.sdk.threadView.getLlmRequestContext({ filePath: fixture.filePath });
    expect(one.ok && two.ok).toBe(true);
    if (!one.ok || !two.ok) return;

    // Byte-identical via the FULL serialized result, not field spot-checks
    // (story Anti-Shim Requirements).
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
    // Summaries are pending on this undrained thread, but rendering now uses
    // deterministic truncation for at-or-behind-boundary tool results.
    expect(short).toEqual({
      role: "user",
      content: textPart(
        `[tool result · read_file · abridged]\nmapping output [full content in record §${result.messageId}]`,
      ),
    });
  });
});

describe("TC-1.4 (AC-1.5): boundary mid-tail — short behind, full ahead, non-tool content full everywhere", () => {
  it.skip("renders deterministic tool-result floors behind the boundary and full content ahead of it", async () => {
    const sdk = initLhc({
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
    // Drain through the real Epic 02 machinery so the tool-result summaries
    // are ready but still not rendered for at-or-behind-boundary results.
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

    // The sanctioned below-SDK helper seeds the boundary mid-tail: at the
    // first result's event order (at-or-behind includes it), ahead of nothing
    // else. Boundary mechanics are Story 4's; only the position's effect on
    // rendering is under test here.
    seedViewBoundary(filePath, behind.sourceEventOrder);

    const context = await sdk.threadView.getLlmRequestContext({ filePath });
    expect(context.ok).toBe(true);
    if (!context.ok) return;
    const contents = context.value.messages.map((m) => messageText(m));

    // Behind: deterministic short form, abridged marker, record pointer.
    // Ready model summaries remain stored derivations but are not rendered
    // on the at-or-behind-boundary full-band surface.
    expect(contents).toContain(
      `[tool result · read_file · abridged]\nboundary output 1 [full content in record §${behind.messageId}]`,
    );
    expect(contents).not.toContain(
      `[tool result · read_file · abridged]\n${behindSummary?.content} [full content in record §${behind.messageId}]`,
    );
    // Ahead: full content.
    expect(contents).toContain("[tool result · read_file]\nboundary output 2");
    // Non-tool-result content renders full everywhere, both sides of the
    // boundary (prompts, thinking, assistant text).
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
    // No drain: the summary stays pending, so the ladder's truncation rung
    // renders — fixed 500-char prefix plus the exact dropped-count marker.
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
    expect(messageText(short)).toBe(
      `[tool result · read_file · abridged]\n${"x".repeat(500)}… [truncated 60 chars] [full content in record §${result.messageId}]`,
    );
  });
});

describe("TC-2.5 pre-compact legs (AC-2.8): the status read on a heavy thread", () => {
  // TC-2.5's intake leg mutates its thread, so this describe builds its own
  // fixture instance instead of sharing the suite's read-only one.
  let heavyStore: TempStore;
  let heavy: DerivedThreadFixture;
  let statusSdk: Lhc;

  beforeAll(async () => {
    heavyStore = tempStore();
    heavy = await derivedThreadFixture(heavyStore);
    // A low threshold makes the fixture "heavy" relative to config: the
    // recommendation must trip without any conversation-scale inflation.
    statusSdk = manualSdk({ compactThreshold: 100 });
  });
  afterAll(() => {
    heavyStore.cleanup();
  });

  it("reports tail tokens vs threshold, recommendation, derivation counts, null view health, and the zone sum — reads only", async () => {
    // Status legs of the zero-model assertion: the builder's double
    // records every call from here on; status must add none.
    const captured = heavy.double.captureInputs();
    const before = stateSnapshot(heavy.filePath);

    const status = await statusSdk.threadView.status({ filePath: heavy.filePath });
    expect(status.ok).toBe(true);
    if (!status.ok) return;

    expect(status.value.threshold).toBe(100);
    expect(status.value.tailTokens).toBeGreaterThan(100);
    expect(status.value.compactRecommended).toBe(true);

    // Derivation counts by state, from the owners' report surfaces: the
    // fixture's two scripted failures (transient-exhausted + permanent), all
    // other derivations drained ready — nothing pending, retrying, or blocked here
    // (the blocked leg reads the sacrificial sibling below).
    expect(status.value.derivation).toEqual({ pending: 0, retrying: 0, failed: 2, blocked: 0 });

    // Pre-compact: view health is null, not a zeroed shape (AC-2.8 leg owned
    // here; the view-health legs complete in Story 2).
    expect(status.value.view).toBeNull();

    // The visibility zone: boundary at its seeded default 0, so the sum is
    // every live tool result's estimate — cross-checked against the record.
    const listed = await statusSdk.messages.list({ filePath: heavy.filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const expectedZone = listed.value
      .filter((m) => m.kind === "tool_result")
      .reduce((sum, m) => sum + m.tokenEstimate, 0);
    expect(status.value.visibility).toEqual({ boundaryPosition: 0, zoneTokens: expectedZone, maxTokens: 64000 });

    // Reads only: no work rows, no derivation-state change, no view row, boundary
    // unmoved, zero model calls — and no compact occurred uninvoked.
    expect(stateSnapshot(heavy.filePath)).toEqual(before);
    expect(captured.length).toBe(0);
  });

  it("counts blocked derivations through the owner's report (sacrificial sibling)", async () => {
    const sibling = await blockedSiblingThread(heavyStore);
    const status = await sibling.sdk.threadView.status({ filePath: sibling.filePath });
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    // The sibling's damaged turn landed both turn derivations blocked through the
    // production terminal path (turn_rendering + detailed_turn_compression).
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
    // Pending work manufactured through a manual SDK (its no-op seam never
    // drains): one tool-heavy turn leaves live queue rows and pending derivations.
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

    // The production background path: a fresh background SDK whose scheduler
    // WOULD hang a first-touch catch-up drain off the open announcement
    // (openThreadDatabase → fireThreadTouch → scheduler.touch) if model context or
    // status fired it — the SV-01-PULL-STATUS-001 side-effect path.
    const bgDouble = createInferenceCallbacksDouble();
    const bg = initLhc({
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

    // The pending work is visible through the read itself (never-attempted
    // derivations bucket as pending) — proof the reads ran against live queue rows.
    expect(firstStatus.value.derivation.pending).toBeGreaterThan(0);

    // Give any wrongly-scheduled catch-up drain room to surface, then wait
    // out the scheduler before asserting nothing happened.
    await new Promise((resolve) => setTimeout(resolve, 25));
    await bg.drainSettled({ filePath });

    // Byte-identical repeated model-context reads (AC-1.7) in background mode.
    expect(sha256(one.value)).toBe(sha256(two.value));
    expect(JSON.stringify(one.value)).toBe(JSON.stringify(two.value));

    // Reads only: queue rows, derivation states, view rows, and boundary all
    // unchanged; the inference callback double observed zero calls.
    expect(stateSnapshot(filePath)).toEqual(before);
    expect(captured.length).toBe(0);

    // The status read repeats unchanged too — no state moved underneath it.
    const secondStatus = await bg.threadView.status({ filePath });
    expect(secondStatus.ok).toBe(true);
    if (!secondStatus.ok) return;
    expect(JSON.stringify(secondStatus.value)).toBe(JSON.stringify(firstStatus.value));
  });
});
