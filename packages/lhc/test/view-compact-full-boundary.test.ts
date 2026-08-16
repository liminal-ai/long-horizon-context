import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDeterministicInferenceCallbacks, initLhc, type Lhc, type PreviewCompactResult } from "../src/index.js";
import {
  type SelectionInputs,
  type SelectionMessage,
  type SelectionTurn,
  selectArrangement,
} from "../src/thread-view/internal/select.js";
import { openRaw, type TempStore, tempStore, validEvent } from "./fixtures/index.js";

let store: TempStore;

beforeAll(() => {
  store = tempStore();
});
afterAll(() => {
  store.cleanup();
});

const EMPTY_DERIVATION_COUNTS: SelectionInputs["derivationCounts"] = {};

function selectionInputs(
  turns: SelectionTurn[],
  messages: Array<
    Pick<SelectionMessage, "messageId" | "order" | "tokenEstimate" | "turnId"> & {
      kind?: string;
    }
  >,
): SelectionInputs {
  return {
    turns,
    messages: messages.map((message) => ({
      messageId: message.messageId,
      order: message.order,
      tokenEstimate: message.tokenEstimate,
      turnId: message.turnId,
      kind: message.kind ?? "assistant_text",
      text: message.messageId,
    })),
    chunks: [],
    derivations: new Map(),
    maxEventOrder: Math.max(0, ...turns.map((turn) => turn.closedAt ?? turn.openedAt)),
    derivationCounts: EMPTY_DERIVATION_COUNTS,
  };
}

const MID_THREAD_TURNS: SelectionTurn[] = [
  { turnId: "t1", turnOrder: 1, status: "closed", openedAt: 1, closedAt: 3 },
  { turnId: "t2", turnOrder: 2, status: "closed", openedAt: 4, closedAt: 7 },
  { turnId: "t3", turnOrder: 3, status: "closed", openedAt: 8, closedAt: 9 },
  { turnId: "t4", turnOrder: 4, status: "open", openedAt: 10, closedAt: null },
];

const MID_THREAD_MESSAGES = [
  { messageId: "m1", order: 1, tokenEstimate: 10, turnId: "t1" },
  { messageId: "m2-old", order: 4, tokenEstimate: 40, turnId: "t2" },
  { messageId: "m2-mid", order: 5, tokenEstimate: 30, turnId: "t2" },
  { messageId: "m2-new", order: 6, tokenEstimate: 30, turnId: "t2" },
  { messageId: "m3", order: 8, tokenEstimate: 20, turnId: "t3" },
];

function compactPointAt(fullBudget: number): number {
  return selectArrangement(selectionInputs(MID_THREAD_TURNS, MID_THREAD_MESSAGES), {
    lowerBound: fullBudget,
    percentages: { full: 100, smooth: 0, detailed: 0, brief: 0 },
  }).compactPoint;
}

async function newSdk(): Promise<{ sdk: Lhc; filePath: string }> {
  const sdk = initLhc({ mode: "manual", inferenceCallbacks: createDeterministicInferenceCallbacks() });
  const filePath = store.threadPath();
  const created = await sdk.threads.newThread({ filePath, registryPath: store.registryPath });
  if (!created.ok) throw new Error(created.error.reason);
  return { sdk, filePath };
}

function okPreview(result: Awaited<ReturnType<Lhc["threadView"]["previewCompact"]>>): PreviewCompactResult {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.reason);
  expect(result.value.kind).toBe("ok");
  if (result.value.kind !== "ok") throw new Error(result.value.reason);
  return result.value.preview;
}

async function oversizedFinalTurn(removeOpenTurn: boolean): Promise<PreviewCompactResult> {
  const { sdk, filePath } = await newSdk();
  const captured = await sdk.intakeStream.messageEvents({ filePath }, [
    validEvent("user_prompt", { payload: { text: "small first turn" } }),
    validEvent("assistant_text", { payload: { text: "done" } }),
    validEvent("turn_end"),
    validEvent("user_prompt", { payload: { text: "large final turn" } }),
    validEvent("assistant_text", { payload: { text: "oversized ".repeat(1_000) } }),
    validEvent("turn_end"),
  ]);
  if (!captured.ok) throw new Error(captured.error.reason);

  if (removeOpenTurn) {
    const db = openRaw(filePath);
    try {
      db.prepare("DELETE FROM turns WHERE status = 'open'").run();
    } finally {
      db.close();
    }
  }

  return okPreview(
    await sdk.threadView.previewCompact(
      { filePath },
      { params: { lowerBound: 120, percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 } } },
    ),
  );
}

describe("compact full-band boundary rounding", () => {
  it("evicts an oversized newest closed turn ahead of an empty open turn", async () => {
    const preview = await oversizedFinalTurn(false);

    // Token split puts most of t2 on the smooth side. Empty open turn is not
    // a reason to keep t2 in full; tail starts after t2 close with no
    // mappable messages.
    expect(preview.compactPoint).toBe(6);
    expect(preview.firstKeptMessageId).toBeNull();
  });

  it("evicts an oversized newest closed turn when there is no open turn", async () => {
    const preview = await oversizedFinalTurn(true);

    expect(preview.compactPoint).toBe(6);
    expect(preview.firstKeptMessageId).toBeNull();
  });

  it("keeps a mid-thread straddling turn when most of its tokens are on the full side", () => {
    expect(compactPointAt(80)).toBe(3);
  });

  it("evicts a mid-thread straddling turn when most of its tokens are on the smooth side", () => {
    expect(compactPointAt(60)).toBe(7);
  });

  it("compactPointUpperBound keeps the compact point behind a later event order", () => {
    // Token split at 60 would evict t2 (compactPoint=7). The bound keeps the
    // point at t1 close so later events stay in the full tail.
    const selection = selectArrangement(selectionInputs(MID_THREAD_TURNS, MID_THREAD_MESSAGES), {
      lowerBound: 60,
      percentages: { full: 100, smooth: 0, detailed: 0, brief: 0 },
      compactPointUpperBound: 3,
    });
    expect(selection.compactPoint).toBe(3);
  });

  it("compactPointUpperBound snaps to the greatest closed-turn boundary, not a raw clamp", () => {
    // Upper bound 5 is inside t2 (closedAt=7). The greatest legal
    // closed-turn boundary <= 5 is t1.closedAt=3, not 5 itself.
    const selection = selectArrangement(selectionInputs(MID_THREAD_TURNS, MID_THREAD_MESSAGES), {
      lowerBound: 60,
      percentages: { full: 100, smooth: 0, detailed: 0, brief: 0 },
      compactPointUpperBound: 5,
    });
    expect(selection.compactPoint).toBe(3);
  });

  it("keeps a mid-thread straddling turn on an exact 50/50 split", () => {
    expect(compactPointAt(70)).toBe(3);
  });

  it("keeps an exactly-covered closed turn in full", () => {
    expect(compactPointAt(120)).toBe(3);
  });

  it("starts the tail at an open turn even when the budget crosses inside it", () => {
    const turns: SelectionTurn[] = [
      { turnId: "t1", turnOrder: 1, status: "closed", openedAt: 1, closedAt: 3 },
      { turnId: "t2", turnOrder: 2, status: "closed", openedAt: 4, closedAt: 6 },
      { turnId: "t3", turnOrder: 3, status: "open", openedAt: 7, closedAt: null },
    ];
    const messages = [
      { messageId: "m1", order: 1, tokenEstimate: 10, turnId: "t1" },
      { messageId: "m2", order: 4, tokenEstimate: 10, turnId: "t2" },
      { messageId: "m3-old", order: 7, tokenEstimate: 25, turnId: "t3" },
      { messageId: "m3-mid", order: 8, tokenEstimate: 25, turnId: "t3" },
      { messageId: "m3-new", order: 9, tokenEstimate: 25, turnId: "t3" },
    ];

    const selection = selectArrangement(selectionInputs(turns, messages), {
      lowerBound: 40,
      percentages: { full: 100, smooth: 0, detailed: 0, brief: 0 },
    });

    expect(selection.compactPoint).toBe(6);
  });

  it("evicts a straddling turn even when the only newer message is a runtime_note", () => {
    // Same mid-thread token layout as compactPointAt(60). A runtime_note is
    // not mappable, but emptiness no longer overrides the token split.
    const turns: SelectionTurn[] = [
      { turnId: "t1", turnOrder: 1, status: "closed", openedAt: 1, closedAt: 3 },
      { turnId: "t2", turnOrder: 2, status: "closed", openedAt: 4, closedAt: 7 },
      { turnId: "t3", turnOrder: 3, status: "open", openedAt: 8, closedAt: null },
    ];
    const messages = [
      { messageId: "m1", order: 1, tokenEstimate: 10, turnId: "t1" },
      { messageId: "m2-old", order: 4, tokenEstimate: 40, turnId: "t2" },
      { messageId: "m2-mid", order: 5, tokenEstimate: 30, turnId: "t2" },
      { messageId: "m2-new", order: 6, tokenEstimate: 30, turnId: "t2" },
      { messageId: "m-note", order: 8, tokenEstimate: 20, turnId: "t3", kind: "runtime_note" },
    ];

    const selection = selectArrangement(selectionInputs(turns, messages), {
      lowerBound: 60,
      percentages: { full: 100, smooth: 0, detailed: 0, brief: 0 },
    });

    expect(selection.compactPoint).toBe(7);
  });

  it("runtime_note-only tail leaves firstKeptMessageId null after token-split eviction", async () => {
    const { sdk, filePath } = await newSdk();
    // t1 small, t2 oversized (token-split evicts). Open turn holds only a
    // runtime_note — not mappable, so the preview tail has no PI anchor.
    const captured = await sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: "small first turn" } }),
      validEvent("assistant_text", { payload: { text: "done" } }),
      validEvent("turn_end"),
      validEvent("user_prompt", { payload: { text: "large final turn" } }),
      validEvent("assistant_text", { payload: { text: "oversized ".repeat(1_000) } }),
      validEvent("turn_end"),
      validEvent("runtime_note", { payload: { text: "harness note only" } }),
    ]);
    if (!captured.ok) throw new Error(captured.error.reason);

    const preview = okPreview(
      await sdk.threadView.previewCompact(
        { filePath },
        { params: { lowerBound: 120, percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 } } },
      ),
    );

    expect(preview.compactPoint).toBe(6);
    expect(preview.firstKeptMessageId).toBeNull();
  });

  it("compact_continuation_marker is mappable and anchors firstKeptMessageId", async () => {
    const { sdk, filePath } = await newSdk();
    const captured = await sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: "small first turn" } }),
      validEvent("assistant_text", { payload: { text: "done" } }),
      validEvent("turn_end"),
      validEvent("user_prompt", { payload: { text: "large final turn" } }),
      validEvent("assistant_text", { payload: { text: "oversized ".repeat(1_000) } }),
      validEvent("turn_end"),
      validEvent("compact_continuation_marker"),
    ]);
    if (!captured.ok) throw new Error(captured.error.reason);

    const preview = okPreview(
      await sdk.threadView.previewCompact(
        { filePath },
        { params: { lowerBound: 120, percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 } } },
      ),
    );

    expect(preview.compactPoint).toBe(6);
    expect(preview.firstKeptMessageId).not.toBeNull();
  });
});
