// Story 2 (Epic 04), default suite: TC-1.1–1.3 — the inspect overview.
// One read-only call composing thread identity, event/message/turn/chunk
// counts, derivation states, view summary, and visibility from the other
// domains' surfaces. Every thread shape returns the FULL shape with absent
// pieces as zeros/nulls (AC-1.3); counts honor the deleted contract
// (AC-1.2); the read is pure (AC-1.4) — asserted as absence of delta and
// zero model calls, including under a throwing inference callback.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type InferenceCallbacks,
  type InspectOverview,
  initLhc,
  type Lhc,
  type MessageEventInput,
  threadView,
} from "../src/index.js";
import {
  createInferenceCallbacksDouble,
  derivedThreadFixture,
  expectReadOnly,
  mutationInFlightVariant,
  type TempStore,
  tempStore,
  validEvent,
} from "./fixtures/index.js";

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
});

// A inference callbacks whose every operation throws: any inference reached through an
// inspect read fails the test loudly (the suite-wide zero-model assert
// extended to the new operations).
function throwingProvider(): InferenceCallbacks {
  const refuse = (): never => {
    throw new Error("inference callbacks must never be called by a read operation");
  };
  return {
    smoothPrompt: refuse,
    summarizeToolResult: refuse,
    composeTurnRendering: refuse,
    compressSmoothTurn: refuse,
    summarizeChunkDetailed: refuse,
    summarizeChunkBrief: refuse,
  };
}

interface SmallThread {
  filePath: string;
  threadId: string;
  sdk: Lhc;
  double: ReturnType<typeof createInferenceCallbacksDouble>;
}

// Two closed turns through real intake, fully drained: m1 prompt, m2 text,
// m3 call, m4 result (t1; turn_end is event 5), m6 prompt, m7 text (t2;
// turn_end is event 8). Never compacted.
async function twoTurnThread(): Promise<SmallThread> {
  const double = createInferenceCallbacksDouble();
  const sdk = initLhc({ inferenceCallbacks: double, mode: "manual" });
  const filePath = store.threadPath();
  const created = await sdk.threads.newThread({
    filePath,
    registryPath: store.registryPath,
    title: "overview fixture",
  });
  if (!created.ok) throw new Error(`fixture thread creation failed: ${created.error.reason}`);
  const batches: MessageEventInput[][] = [
    [
      validEvent("user_prompt", { payload: { text: "please read notes.txt" } }),
      validEvent("assistant_text", { payload: { text: "reading it now" } }),
      validEvent("tool_call", {
        payload: {
          toolCallId: "call-ov-1",
          toolName: "read_file",
          arguments: { path: "notes.txt" },
        },
      }),
      validEvent("tool_result", {
        payload: { toolCallId: "call-ov-1", content: "contents of notes.txt", isError: false },
      }),
      validEvent("turn_end"),
    ],
    [
      validEvent("user_prompt", { payload: { text: "summarize what you read" } }),
      validEvent("assistant_text", { payload: { text: "here is the summary" } }),
      validEvent("turn_end"),
    ],
  ];
  for (const batch of batches) {
    const sent = await sdk.intakeStream.messageEvents({ filePath }, batch);
    if (!sent.ok) throw new Error(`fixture batch failed: ${sent.error.reason}`);
  }
  const drained = await sdk.work.drain({ filePath });
  if (!drained.ok || drained.value.remaining !== 0) {
    throw new Error("fixture drain left work behind");
  }
  return { filePath, threadId: created.value.threadId, sdk, double };
}

function overviewValue(result: { ok: boolean }): InspectOverview {
  if (!result.ok) {
    throw new Error(`expected ok overview: ${JSON.stringify(result)}`);
  }
  return (result as { ok: true; value: InspectOverview }).value;
}

const ZERO_DERIVATION = { ready: 0, pending: 0, retrying: 0, failed: 0, blocked: 0 };

describe("TC-1.1 / AC-1.1, AC-1.3: full overview shape across thread shapes", () => {
  it("fresh-empty: full shape with zeros and nulls, never omitted fields", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = initLhc({ inferenceCallbacks: double, mode: "manual" });
    const filePath = store.threadPath();
    const created = await sdk.threads.newThread({ filePath, registryPath: store.registryPath });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const overview = overviewValue(await sdk.inspect.overview({ filePath }));
    expect(overview.thread.id).toBe(created.value.threadId);
    expect(typeof overview.thread.createdAt).toBe("string");
    expect(overview.events).toEqual({ count: 0, span: null });
    expect(overview.messages).toEqual({
      visible: 0,
      byKind: {},
      deleted: 0,
      visibleTokens: 0,
    });
    expect(overview.turns).toEqual({ open: 0, closed: 0 });
    expect(overview.chunks).toEqual({ count: 0, unchunkedTurns: 0 });
    expect(overview.derivation).toEqual(ZERO_DERIVATION);
    expect(overview.view).toBeNull();
    expect(overview.visibility).toEqual({ boundaryPosition: 0, zoneTokens: 0 });
  });

  it("mid-first-turn: open turn, queued derivation, no view — full shape", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = initLhc({ inferenceCallbacks: double, mode: "manual" });
    const filePath = store.threadPath();
    const created = await sdk.threads.newThread({ filePath, registryPath: store.registryPath });
    expect(created.ok).toBe(true);
    const sent = await sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: "first prompt, turn still open" } }),
      validEvent("assistant_thinking", { payload: { text: "thinking about it" } }),
    ]);
    expect(sent.ok).toBe(true);

    const overview = overviewValue(await sdk.inspect.overview({ filePath }));
    expect(overview.events).toEqual({ count: 2, span: { first: 1, last: 2 } });
    expect(overview.messages.visible).toBe(2);
    expect(overview.messages.byKind).toEqual({ user_prompt: 1, assistant_thinking: 1 });
    expect(overview.messages.deleted).toBe(0);
    expect(overview.messages.visibleTokens).toBeGreaterThan(0);
    expect(overview.turns).toEqual({ open: 1, closed: 0 });
    expect(overview.chunks).toEqual({ count: 0, unchunkedTurns: 0 });
    // The prompt's smoothing sits queued, never attempted: pending.
    expect(overview.derivation).toEqual({ ...ZERO_DERIVATION, pending: 1 });
    expect(overview.view).toBeNull();
    expect(overview.visibility.boundaryPosition).toBe(0);
  });

  it("never-compacted-with-record: real counts, view null", async () => {
    const { filePath, threadId, sdk } = await twoTurnThread();
    const overview = overviewValue(await sdk.inspect.overview({ filePath }));
    expect(overview.thread.id).toBe(threadId);
    expect(overview.events).toEqual({ count: 8, span: { first: 1, last: 8 } });
    expect(overview.messages.visible).toBe(6);
    expect(overview.messages.byKind).toEqual({
      user_prompt: 2,
      assistant_text: 2,
      tool_call: 1,
      tool_result: 1,
    });
    expect(overview.messages.deleted).toBe(0);
    expect(overview.turns).toEqual({ open: 0, closed: 2 });
    // Both closed turns placed by their derivations into the one open chunk.
    expect(overview.chunks).toEqual({ count: 1, unchunkedTurns: 0 });
    // 2 smoothings + 1 result summary + 2 turns × 2 forms.
    expect(overview.derivation).toEqual({ ...ZERO_DERIVATION, ready: 7 });
    expect(overview.view).toBeNull();
  });

  it("compacted tool-heavy fixture: exact counts in every section", async () => {
    const fixture = await derivedThreadFixture(store);
    const { filePath, sdk } = fixture;
    // sweep: false keeps the two manufactured failed states failed — the
    // default sweep would requeue the transient one and move the counts.
    const compacted = await sdk.threadView.compact({ filePath }, { sweep: false });
    expect(compacted.ok).toBe(true);
    if (!compacted.ok) return;

    const overview = overviewValue(await sdk.inspect.overview({ filePath }));
    // 8 plain turns × 4 events + 4 tool-heavy turns × 8 events.
    expect(overview.events).toEqual({ count: 64, span: { first: 1, last: 64 } });
    // Messages: events minus the 12 turn_ends.
    expect(overview.messages.visible).toBe(52);
    expect(overview.messages.byKind).toEqual({
      user_prompt: 12,
      assistant_thinking: 12,
      assistant_text: 12,
      tool_call: 8,
      tool_result: 8,
    });
    expect(overview.messages.deleted).toBe(0);
    expect(overview.messages.visibleTokens).toBeGreaterThan(0);
    expect(overview.turns).toEqual({ open: 0, closed: 12 });
    expect(overview.chunks).toEqual({ count: 4, unchunkedTurns: 0 });
    // 12 smoothings + 6 ready result summaries + 24 turn
    // forms + 6 chunk summaries ready; the scripted transient and permanent
    // exhaustions stay failed.
    expect(overview.derivation).toEqual({ ...ZERO_DERIVATION, ready: 48, failed: 2 });
    expect(overview.view).toEqual({
      viewId: compacted.value.viewId,
      createdAt: expect.any(String),
      compactPoint: compacted.value.compactPoint,
      coveredFrom: compacted.value.coveredFrom,
    });
    // Visibility mirrors the serving surface: the stored boundary pull
    // reports and the zone sum status computes live.
    const pulled = await threadView.pull({ filePath });
    const status = await sdk.threadView.status({ filePath });
    expect(pulled.ok && status.ok).toBe(true);
    if (!pulled.ok || !status.ok) return;
    expect(overview.visibility).toEqual({
      boundaryPosition: pulled.value.meta.boundaryPosition,
      zoneTokens: status.value.visibility.zoneTokens,
    });
  });

  it("mid-rebuild: cleared cascade pending, view summary intact — full shape", async () => {
    const fixture = await mutationInFlightVariant(store);
    const overview = overviewValue(await fixture.sdk.inspect.overview({ filePath: fixture.filePath }));
    // The edit cleared exactly the cascade set — its own smoothing, t2's two
    // turn forms, c1's two chunk summaries — all pending, drain not settled.
    expect(fixture.mutation.cleared).toHaveLength(5);
    expect(overview.derivation).toEqual({ ...ZERO_DERIVATION, ready: 45, pending: 5 });
    expect(overview.turns).toEqual({ open: 0, closed: 12 });
    expect(overview.chunks).toEqual({ count: 4, unchunkedTurns: 0 });
    // The view is the pre-edit compact's snapshot, untouched by the mutation.
    expect(overview.view).toEqual({
      viewId: fixture.compactReceipt.viewId,
      createdAt: expect.any(String),
      compactPoint: fixture.compactReceipt.compactPoint,
      coveredFrom: fixture.compactReceipt.coveredFrom,
    });
    expect(overview.events.count).toBe(64);
    expect(overview.messages.visible).toBe(52);
  });
});

describe("TC-1.2 / AC-1.2: deleted accounting", () => {
  it("deleting one message drops visible/kind/token counts, raises deleted, leaves events alone", async () => {
    const { filePath, sdk } = await twoTurnThread();
    const before = overviewValue(await sdk.inspect.overview({ filePath }));

    const listed = await sdk.messages.list({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const target = listed.value.find((record) => record.messageId === "m2");
    expect(target?.kind).toBe("assistant_text");
    if (target === undefined) return;

    const deleted = await sdk.messages.remove({ filePath }, { messageId: "m2" });
    expect(deleted.ok).toBe(true);

    const after = overviewValue(await sdk.inspect.overview({ filePath }));
    expect(after.messages.visible).toBe(before.messages.visible - 1);
    expect(after.messages.deleted).toBe(1);
    expect(after.messages.byKind).toEqual({
      ...before.messages.byKind,
      assistant_text: (before.messages.byKind["assistant_text"] ?? 0) - 1,
    });
    expect(after.messages.visibleTokens).toBe(before.messages.visibleTokens - target.tokenEstimate);
    // The record retains everything: event count and span are unaffected.
    expect(after.events).toEqual(before.events);
  });
});

describe("TC-1.3 / AC-1.4: overview is a pure read", () => {
  it("repeated calls are deep-equal, leave no delta, create no work, call no model", async () => {
    const fixture = await mutationInFlightVariant(store);
    const { filePath, sdk, double } = fixture;
    const captured = double.captureInputs();

    // Both calls under the read-only delta assert (DD-6): observable state —
    // queued work, boundary/zone, view identity, events, messages, forms —
    // is snapshot-equal around each read. No work_item rows can appear under
    // a green delta (queued work is part of the snapshot).
    const first = await expectReadOnly(filePath, () => sdk.inspect.overview({ filePath }));
    const second = await expectReadOnly(filePath, () => sdk.inspect.overview({ filePath }));
    expect(first.ok && second.ok).toBe(true);
    expect(second).toEqual(first);
    expect(captured).toHaveLength(0);
  });

  it("overview succeeds under a throwing inference callback, and wraps Story 1's reads in the delta assert", async () => {
    const { filePath } = await twoTurnThread();
    // A separate SDK whose inference callbacks throw on contact: the read path is
    // inference-callback-free structurally, in both the new and the Story 1 surfaces.
    const reader = initLhc({ inferenceCallbacks: throwingProvider(), mode: "manual" });

    const overview = await expectReadOnly(filePath, () => reader.inspect.overview({ filePath }));
    expect(overview.ok).toBe(true);
    // Retroactive wrap (test plan, Chunk 2): the Chunk 1 read surface runs
    // under the same shared delta helper.
    const listed = await expectReadOnly(filePath, () => reader.messages.list({ filePath }, { includeDeleted: true }));
    const shown = await expectReadOnly(filePath, () => reader.messages.show({ filePath }, "m1"));
    expect(listed.ok && shown.ok).toBe(true);
  });

  it("overview on a missing thread is thread_not_found, not a shape error", async () => {
    const sdk = initLhc({ inferenceCallbacks: createInferenceCallbacksDouble(), mode: "manual" });
    const missing = await sdk.inspect.overview({ filePath: store.threadPath("missing") });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.errorClass).toBe("caller_error");
    expect(missing.error.code).toBe("thread_not_found");
  });
});
