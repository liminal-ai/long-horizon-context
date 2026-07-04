import { describe, expect, it } from "vitest";

import type { MessageEventInput } from "lhc";

import {
  createReplayDedupeState,
  eventContentSignature,
  filterReplayEvents,
  signaturesForRolloutLine,
} from "../../src/intake/replay-dedupe.js";

function userEvent(text: string): MessageEventInput {
  return {
    eventKind: "user_prompt",
    idempotencyKey: "test",
    actor: "user",
    harness: "cc",
    payload: { text },
  };
}

function toolResultEvent(content: string): MessageEventInput {
  return {
    eventKind: "tool_result",
    idempotencyKey: "test",
    actor: "tool",
    harness: "cc",
    payload: { toolCallId: "tc1", content, isError: false },
  };
}

describe("replay dedupe", () => {
  it("skips replay-prefix events then deactivates on the first novel event", () => {
    const replaySig = signaturesForRolloutLine(
      { type: "user", uuid: "replay-uuid-1", message: { role: "user", content: "hello again" } },
      0,
    )[0]!;
    const state = createReplayDedupeState(true, [replaySig]);

    const replayResult = filterReplayEvents([userEvent("hello again")], state);
    expect(replayResult.toSend).toHaveLength(0);
    expect(replayResult.skipped).toBe(1);
    expect(state.replayWindowActive).toBe(true);

    const liveResult = filterReplayEvents([userEvent("new live prompt")], state);
    expect(liveResult.toSend).toHaveLength(1);
    expect(liveResult.skipped).toBe(0);
    expect(state.replayWindowActive).toBe(false);
  });

  it("keeps duplicate live content after the replay window closes", () => {
    const cached = eventContentSignature(userEvent("continue"));
    const state = createReplayDedupeState(true, [cached]);

    filterReplayEvents([userEvent("brand new live line")], state);
    expect(state.replayWindowActive).toBe(false);

    const duplicateUser = filterReplayEvents([userEvent("continue"), userEvent("continue")], state);
    expect(duplicateUser.toSend).toHaveLength(2);
    expect(duplicateUser.skipped).toBe(0);
  });

  it("keeps duplicate tool results after the replay window closes", () => {
    const cached = eventContentSignature(toolResultEvent("On branch main\nnothing to commit"));
    const state = createReplayDedupeState(true, [cached]);

    filterReplayEvents([userEvent("run git status again")], state);

    const duplicateTools = filterReplayEvents(
      [toolResultEvent("On branch main\nnothing to commit"), toolResultEvent("On branch main\nnothing to commit")],
      state,
    );
    expect(duplicateTools.toSend).toHaveLength(2);
    expect(duplicateTools.skipped).toBe(0);
  });

  it("keeps cached duplicates in the same batch after the first novel event", () => {
    const cached = eventContentSignature(userEvent("replay line"));
    const state = createReplayDedupeState(true, [cached]);

    const mixed = filterReplayEvents(
      [userEvent("replay line"), userEvent("live now"), userEvent("replay line")],
      state,
    );
    expect(mixed.skipped).toBe(1);
    expect(mixed.toSend).toHaveLength(2);
    expect(mixed.toSend.map((event) => (event.payload as { text: string }).text)).toEqual(["live now", "replay line"]);
    expect(state.replayWindowActive).toBe(false);
  });

  it("intakes ambiguous lines when signatures differ slightly", () => {
    const state = createReplayDedupeState(true, [eventContentSignature(userEvent("hello"))]);
    const result = filterReplayEvents([userEvent("hello!")], state);
    expect(result.toSend).toHaveLength(1);
    expect(result.skipped).toBe(0);
    expect(state.replayWindowActive).toBe(false);
  });

  it("does not skip on a brand-new thread", () => {
    const state = createReplayDedupeState(false, ["existing"]);
    const result = filterReplayEvents([userEvent("hello")], state);
    expect(result.toSend).toHaveLength(1);
    expect(result.skipped).toBe(0);
  });

  it("still records signatures for new threads after intake", () => {
    const state = createReplayDedupeState(false, []);
    const result = filterReplayEvents([userEvent("record me")], state);
    expect(result.signaturesToAdd).toHaveLength(1);
  });
});
