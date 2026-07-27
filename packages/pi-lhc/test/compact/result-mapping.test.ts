import type { SessionThreadView } from "lhc";
import { describe, expect, it } from "vitest";
import { eventKey } from "../../src/capture/idempotency.js";
import { assembleCompactionResult, assembleSummaryFromRenderedBands, mapFirstKeptToEntryId } from "../../src/index.js";
import { liveIdempotencyKey, makeBranchEntries, makeCompactReceipt, makeSeedEntryMap } from "./fixtures.js";

const PI_SESSION = "th_abc123def4567890";

describe("mapFirstKeptToEntryId", () => {
  const sessionView: SessionThreadView = {
    threadId: PI_SESSION,
    entries: [
      {
        role: "user",
        content: "older",
        sourceMessages: [{ messageId: "m1", idempotencyKey: liveIdempotencyKey(PI_SESSION, "entry_0") }],
      },
      {
        role: "user",
        content: "kept",
        sourceMessages: [{ messageId: "m14", idempotencyKey: liveIdempotencyKey(PI_SESSION, "entry_3") }],
      },
    ],
  };

  it("live tier resolves firstKeptMessageId via current-session idempotency key", () => {
    const mapping = mapFirstKeptToEntryId("m14", sessionView, null, makeBranchEntries(4), PI_SESSION);
    expect(mapping).toEqual({ firstKeptEntryId: "entry_3", origin: "live" });
  });

  it("seed tier resolves when idempotency key is from a prior session", () => {
    const priorSessionView: SessionThreadView = {
      threadId: PI_SESSION,
      entries: [
        {
          role: "user",
          content: "kept",
          sourceMessages: [
            { messageId: "m14", idempotencyKey: liveIdempotencyKey("th_prior_session_id", "old_entry") },
          ],
        },
      ],
    };
    const mapping = mapFirstKeptToEntryId(
      "m14",
      priorSessionView,
      makeSeedEntryMap([{ lhcMessageId: "m14", piEntryId: "entry_3" }]),
      makeBranchEntries(4),
      PI_SESSION,
    );
    expect(mapping).toEqual({ firstKeptEntryId: "entry_3", origin: "seeded" });
  });

  it("fail-closed when neither tier resolves", () => {
    const mapping = mapFirstKeptToEntryId("m99", sessionView, null, makeBranchEntries(4), PI_SESSION);
    expect(mapping).toMatchObject({ mappingFailed: true });
  });

  it("does not content-match duplicate prompts", () => {
    const duplicateView: SessionThreadView = {
      threadId: PI_SESSION,
      entries: [
        {
          role: "user",
          content: "same text",
          sourceMessages: [{ messageId: "m1", idempotencyKey: null }],
        },
        {
          role: "user",
          content: "same text",
          sourceMessages: [{ messageId: "m2", idempotencyKey: liveIdempotencyKey(PI_SESSION, "entry_1") }],
        },
      ],
    };
    const mapping = mapFirstKeptToEntryId("m1", duplicateView, null, makeBranchEntries(4), PI_SESSION);
    expect(mapping).toMatchObject({ mappingFailed: true });
  });

  it("stale branch: live entry id not in branchEntries falls through to seed tier", () => {
    const mapping = mapFirstKeptToEntryId(
      "m14",
      sessionView,
      makeSeedEntryMap([{ lhcMessageId: "m14", piEntryId: "entry_1" }]),
      makeBranchEntries(2),
      PI_SESSION,
    );
    expect(mapping).toEqual({ firstKeptEntryId: "entry_1", origin: "seeded" });
  });

  it("stale live key with current session prefix but absent entry id resolves via seed map", () => {
    const resumedView: SessionThreadView = {
      threadId: PI_SESSION,
      entries: [
        {
          role: "user",
          content: "kept",
          sourceMessages: [
            {
              messageId: "m14",
              idempotencyKey: liveIdempotencyKey(PI_SESSION, "stale_old_entry"),
            },
          ],
        },
      ],
    };
    const mapping = mapFirstKeptToEntryId(
      "m14",
      resumedView,
      makeSeedEntryMap([{ lhcMessageId: "m14", piEntryId: "entry_regenerated" }]),
      [
        {
          type: "message",
          id: "entry_regenerated",
          parentId: null,
          message: { role: "user", content: "kept", timestamp: 1_700_000_000_000 },
        },
      ],
      PI_SESSION,
    );
    expect(mapping).toEqual({ firstKeptEntryId: "entry_regenerated", origin: "seeded" });
  });

  it("stale branch with no seed map still fails closed", () => {
    const mapping = mapFirstKeptToEntryId("m14", sessionView, null, makeBranchEntries(2), PI_SESSION);
    expect(mapping).toMatchObject({ mappingFailed: true });
  });

  it("non-entry identity keys fail closed", () => {
    const toolView: SessionThreadView = {
      threadId: PI_SESSION,
      entries: [
        {
          role: "user",
          content: "kept",
          sourceMessages: [
            {
              messageId: "m14",
              idempotencyKey: eventKey({
                piSessionId: PI_SESSION,
                toolCallId: "call_x",
                blockIndex: 0,
                kind: "tool_call",
              }),
            },
          ],
        },
      ],
    };
    const mapping = mapFirstKeptToEntryId("m14", toolView, null, makeBranchEntries(4), PI_SESSION);
    expect(mapping).toMatchObject({ mappingFailed: true });
  });

  it("assistant grouping: resolves tool_call message via seed row", () => {
    const groupedView: SessionThreadView = {
      threadId: PI_SESSION,
      entries: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hmm" },
            { type: "text", text: "doing" },
            { type: "toolCall", toolCallId: "call_1", toolName: "read", arguments: {} },
          ],
          sourceMessages: [
            { messageId: "m10", idempotencyKey: liveIdempotencyKey(PI_SESSION, "pi_asst", "assistant_thinking") },
            { messageId: "m11", idempotencyKey: liveIdempotencyKey(PI_SESSION, "pi_asst", "assistant_text") },
            { messageId: "m12", idempotencyKey: liveIdempotencyKey(PI_SESSION, "pi_asst", "tool_call") },
          ],
        },
      ],
    };
    const mapping = mapFirstKeptToEntryId(
      "m12",
      groupedView,
      makeSeedEntryMap([
        { lhcMessageId: "m10", piEntryId: "pi_asst" },
        { lhcMessageId: "m11", piEntryId: "pi_asst" },
        { lhcMessageId: "m12", piEntryId: "pi_asst" },
      ]),
      [
        {
          type: "message",
          id: "pi_asst",
          parentId: null,
          message: {
            role: "assistant",
            content: [],
            provider: "test",
            model: "test-model",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: 1_700_000_000_000,
          },
        },
      ],
      "other_session",
    );
    expect(mapping).toEqual({ firstKeptEntryId: "pi_asst", origin: "seeded" });
  });
});

describe("assembleCompactionResult", () => {
  it("assembles summary in [context · band] format and preserves tokensBefore", () => {
    const receipt = makeCompactReceipt();
    const result = assembleCompactionResult(receipt, "entry_3", 88_888);
    expect(result.summary).toBe(
      "[context · brief]\nbrief band body\n\n[context · detailed]\ndetailed band body\n\n[context · smooth]\nsmooth band body",
    );
    expect(result.tokensBefore).toBe(88_888);
    expect(result.details).toBe(receipt);
    expect(result.firstKeptEntryId).toBe("entry_3");
  });

  it("omits empty band text", () => {
    const summary = assembleSummaryFromRenderedBands([
      { band: "brief", text: "   " },
      { band: "smooth", text: "only smooth" },
    ]);
    expect(summary).toBe("[context · smooth]\nonly smooth");
  });

  it("tokensBefore comes from preparation, not receipt.totalTokens", () => {
    const receipt = makeCompactReceipt({ totalTokens: 999 });
    const result = assembleCompactionResult(receipt, "entry_1", 42_000);
    expect(result.tokensBefore).toBe(42_000);
    expect(result.tokensBefore).not.toBe(receipt.totalTokens);
  });
});
