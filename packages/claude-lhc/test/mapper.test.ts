import { describe, expect, test } from "bun:test";
import { compactCommand, mapPrompt, mapSdkMessage, stringifyToolResultContent } from "../src/capture/mapper.ts";

const prompt = (text: string) => ({ type: "user", message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null, session_id: "" }) as never;

describe("mapPrompt", () => {
  test("a prompt into a closed turn is user_prompt", () => {
    const [event] = mapPrompt(prompt("hello"), "u1", false);
    expect(event?.eventKind).toBe("user_prompt");
    expect(event?.idempotencyKey).toBe("claude-lhc:u1:0:user_prompt");
  });
  test("a prompt into an open turn is a labelled steer note", () => {
    const [event] = mapPrompt(prompt("faster"), "u2", true);
    expect(event?.eventKind).toBe("runtime_note");
    expect((event?.payload as { text: string }).text).toBe("[user steer] faster");
  });
  test("task notifications are runtime notes", () => {
    expect(mapPrompt(prompt("<task-notification>done</task-notification>"), "u3", false)[0]?.eventKind).toBe("runtime_note");
  });
  test("/compact is the manual compact command", () => {
    expect(compactCommand(prompt("/compact"))).toEqual({ args: "" });
    expect(compactCommand(prompt("/compact focus on tests"))).toEqual({ args: "focus on tests" });
    expect(compactCommand(prompt("please /compact"))).toBeNull();
  });
});

describe("mapSdkMessage", () => {
  const usage = { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 5 };
  test("assistant blocks map in order with provenance and usage; context tokens are input + cache", () => {
    const result = mapSdkMessage({
      type: "assistant", uuid: "a1", session_id: "s", parent_tool_use_id: null,
      message: { model: "claude-sonnet-5", usage, content: [
        { type: "thinking", thinking: "", signature: "sig" },
        { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "x" } },
        { type: "text", text: "done" },
      ] },
    } as never, undefined);
    expect(result.events.map((e) => e.eventKind)).toEqual(["assistant_thinking", "tool_call", "assistant_text"]);
    expect(result.events[0]?.idempotencyKey).toBe("claude-lhc:a1:0:assistant_thinking");
    expect((result.events[0]?.payload as { signature: string; model: string }).signature).toBe("sig");
    expect((result.events[2]?.payload as { providerUsage: unknown; provider: string }).provider).toBe("anthropic");
    expect(result.contextTokens).toBe(1002);
  });
  test("subagent output is skipped", () => {
    expect(mapSdkMessage({ type: "assistant", uuid: "a2", parent_tool_use_id: "toolu_task", message: { content: [{ type: "text", text: "x" }] } } as never, undefined).events).toEqual([]);
  });
  test("tool results map by tool_use_id with stringified content", () => {
    const result = mapSdkMessage({ type: "user", uuid: "r1", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }], is_error: true }] } } as never, undefined);
    expect(result.events[0]?.payload).toEqual({ toolCallId: "toolu_1", content: "a\nb", isError: true });
    expect(stringifyToolResultContent({ k: 1 })).toBe('{"k":1}');
  });
  test("result closes the turn", () => {
    const result = mapSdkMessage({ type: "result", subtype: "success", is_error: false, uuid: "x", session_id: "s" } as never, "2026-09-03T00:00:00.000Z");
    expect(result.turnEnd).toBe(true);
    expect((result.events[0]?.payload as { outcome: string; startedAt: string }).outcome).toBe("completed");
    expect(mapSdkMessage({ type: "result", subtype: "error_during_execution", is_error: true, uuid: "y" } as never, undefined).events[0]?.payload).toMatchObject({ outcome: "aborted" });
  });
});

describe("compact view policy", () => {
  test("viewTargetFor keeps the view under a share of the trigger it must clear", async () => {
    const { viewTargetFor } = await import("../src/session.ts");
    expect(viewTargetFor(150_000)).toBe(60_000);
    expect(viewTargetFor(100_000)).toBe(40_000);
  });

  test("evictedTurns names closed turns that fell past the view's coverage edge", async () => {
    const { evictedTurns } = await import("../src/session.ts");
    // Turn orders of the thread the orchestrator's smoke lost: three tool turns, the
    // continuation-marker turn, the post-compact turn, and the open turn.
    const turns = [
      { turnId: "t1", turnOrder: 1, status: "closed", memberMessageIds: ["a", "b", "c", "d"], openedAtEventOrder: 0, closedAtEventOrder: 5 },
      { turnId: "t2", turnOrder: 2, status: "closed", memberMessageIds: ["e", "f", "g", "h"], openedAtEventOrder: 5, closedAtEventOrder: 10 },
      { turnId: "t3", turnOrder: 3, status: "closed", memberMessageIds: ["i", "j", "k", "l"], openedAtEventOrder: 10, closedAtEventOrder: 15 },
      { turnId: "t4", turnOrder: 4, status: "closed", memberMessageIds: ["m"], openedAtEventOrder: 15, closedAtEventOrder: 17 },
      { turnId: "t5", turnOrder: 5, status: "open", memberMessageIds: [], openedAtEventOrder: 17 },
    ] as never[];
    expect(evictedTurns(turns, 11)).toEqual(["t1", "t2"]); // the view that only carried t3
    expect(evictedTurns(turns, 1)).toEqual([]); // bands starting at t1's first message
    expect(evictedTurns(turns, 0)).toEqual([]); // no bands: everything in the tail
  });
});
