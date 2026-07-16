import { describe, expect, test } from "vitest";
import type { Lhc, PreviewCompactOutcome } from "../src/client/index.js";
import {
  type SelectionInputs,
  type SelectionMessage,
  type SelectionTurn,
  selectArrangement,
} from "../src/shared/view_select.js";
import { serviceFixture, validEvent } from "./fixtures/index.js";

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

function okPreview(
  result: Awaited<ReturnType<Lhc["threadView"]["previewCompact"]>>,
): NonNullable<PreviewCompactOutcome["preview"]> {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.reason);
  expect(result.value.kind).toBe("ok");
  if (result.value.kind !== "ok" || result.value.preview === undefined) {
    throw new Error(result.value.reason ?? "preview missing");
  }
  return result.value.preview;
}

async function oversizedFinalTurn(removeOpenTurn: boolean) {
  const fixture = serviceFixture();
  const { sdk } = fixture;
  const filePath = (await fixture.createThread()).filePath;
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
    await fixture.test.run(async (ctx) => {
      const turns = await ctx.db.query("turns").collect();
      const open = turns.find((turn) => turn.instance === fixture.instance && turn.status === "open");
      if (open !== undefined) await ctx.db.delete("turns", open._id);
    });
  }

  return okPreview(
    await sdk.threadView.previewCompact(
      { filePath },
      { params: { lowerBound: 120, percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 } } },
    ),
  );
}

describe("compact full-band boundary rounding", () => {
  test("keeps an oversized newest closed turn ahead of an empty open turn", async () => {
    const preview = await oversizedFinalTurn(false);
    expect(preview.compactPoint).toBe(3);
    expect(preview.firstKeptMessageId).toBe("m4");
  });

  test("keeps an oversized newest closed turn when there is no open turn", async () => {
    const preview = await oversizedFinalTurn(true);
    expect(preview.compactPoint).toBe(3);
    expect(preview.firstKeptMessageId).toBe("m4");
  });

  test("keeps a mid-thread straddling turn when most of its tokens are on the full side", () => {
    expect(compactPointAt(80)).toBe(3);
  });

  test("evicts a mid-thread straddling turn when most of its tokens are on the smooth side", () => {
    expect(compactPointAt(60)).toBe(7);
  });

  test("keeps a mid-thread straddling turn on an exact 50/50 split", () => {
    expect(compactPointAt(70)).toBe(3);
  });

  test("keeps an exactly-covered closed turn in full", () => {
    expect(compactPointAt(120)).toBe(3);
  });

  test("starts the tail at an open turn even when the budget crosses inside it", () => {
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
    expect(
      selectArrangement(selectionInputs(turns, messages), {
        lowerBound: 40,
        percentages: { full: 100, smooth: 0, detailed: 0, brief: 0 },
      }).compactPoint,
    ).toBe(6);
  });

  test("treats a runtime_note-only post-eviction tail as empty and keeps the straddling turn", () => {
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
    expect(
      selectArrangement(selectionInputs(turns, messages), {
        lowerBound: 60,
        percentages: { full: 100, smooth: 0, detailed: 0, brief: 0 },
      }).compactPoint,
    ).toBe(3);
  });

  test("runtime_note-only tail keeps straddling turn; preview anchor is non-null", async () => {
    const fixture = serviceFixture();
    const filePath = (await fixture.createThread()).filePath;
    const captured = await fixture.sdk.intakeStream.messageEvents({ filePath }, [
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
      await fixture.sdk.threadView.previewCompact(
        { filePath },
        { params: { lowerBound: 120, percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 } } },
      ),
    );
    expect(preview.compactPoint).toBe(3);
    expect(preview.firstKeptMessageId).toBe("m4");
    expect(preview.firstKeptMessageId).not.toBeNull();
  });
});
