import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CODEX_HARNESS_ID,
  idempotencyKey,
  mapRolloutLine,
  mapRolloutLines,
  rolloutLineId,
} from "../../src/intake/map.js";
import type { RolloutLineItem } from "../../src/rollout/types.js";

const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "codex-rollout-samples.jsonl");

function loadFixtures(): RolloutLineItem[] {
  return readFileSync(FIXTURE_PATH, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("//"))
    .map((line) => JSON.parse(line) as RolloutLineItem);
}

function payload(item: RolloutLineItem): Record<string, unknown> {
  if (typeof item.payload !== "object" || item.payload === null) throw new Error("expected payload");
  return item.payload as Record<string, unknown>;
}

function byPayloadType(items: RolloutLineItem[], type: string): RolloutLineItem {
  const found = items.find((item) => payload(item).type === type);
  if (found === undefined) throw new Error(`missing payload type ${type}`);
  return found;
}

function byRole(items: RolloutLineItem[], role: string): RolloutLineItem {
  const found = items.find((item) => item.type === "response_item" && payload(item).role === role);
  if (found === undefined) throw new Error(`missing role ${role}`);
  return found;
}

describe("codex rollout mapper", () => {
  const fixtures = loadFixtures();

  it("exports the codex harness id and codex idempotency prefix", () => {
    expect(CODEX_HARNESS_ID).toBe("codex");
    expect(idempotencyKey("msg_test", 0, "user_prompt")).toBe("codex-lhc:rollout:msg_test:0:user_prompt");
  });

  it("captures first session identity and counts embedded session_meta lines", () => {
    const result = mapRolloutLines(fixtures);
    expect(result.sessionInfo).toEqual(
      expect.objectContaining({
        id: "019f3c44-62fa-7161-975a-3f456e028ff4",
        sessionId: "019f3c44-62fa-7161-975a-3f456e028ff4",
        cwd: "/Users/leemoore/code/example",
      }),
    );
    expect(result.stats.sessionMeta).toBe(3);
    expect(result.stats.embeddedSessionMeta).toBe(2);
  });

  it("tolerates old-format session_meta without session_id", () => {
    const oldMeta = fixtures.find(
      (item) => item.type === "session_meta" && payload(item).id === "019d7eb3-c9c9-7be0-9edf-9920bff15b94",
    );
    expect(oldMeta).toBeDefined();
    const result = mapRolloutLine(oldMeta!);
    expect(result.events).toEqual([]);
    expect(result.sessionInfo).toEqual(
      expect.objectContaining({ id: "019d7eb3-c9c9-7be0-9edf-9920bff15b94" }),
    );
    expect(result.sessionInfo?.sessionId).toBeUndefined();
  });

  it("maps user, image, runtime-note, assistant, and reasoning response items", () => {
    const user = mapRolloutLine(byRole(fixtures, "user"));
    expect(user.events[0]?.eventKind).toBe("user_prompt");
    expect(user.events[0]?.payload).toEqual({ text: "sanitized user prompt" });
    expect(user.events[0]?.harness).toBe("codex");

    const image = mapRolloutLine(
      fixtures.find((item) => JSON.stringify(item).includes("input_image")) ?? byRole(fixtures, "user"),
    );
    expect(image.stats.image).toBe(1);
    expect(image.events[0]?.payload).toEqual({
      text: "describe this screenshot\n[image content not captured]",
    });

    const note = mapRolloutLine(
      fixtures.find((item) => JSON.stringify(item).includes("[runtime note]")) ?? byRole(fixtures, "user"),
    );
    expect(note.events[0]?.eventKind).toBe("runtime_note");
    expect(note.events[0]?.actor).toBe("system");
    expect(note.events[0]?.payload).toEqual({ text: "swapped to rebuilt Codex rollout" });

    const assistant = mapRolloutLine(byRole(fixtures, "assistant"));
    expect(assistant.events[0]?.eventKind).toBe("assistant_text");
    expect(assistant.events[0]?.payload).toEqual({ text: "sanitized assistant response" });

    const thinking = mapRolloutLine(byPayloadType(fixtures, "reasoning"));
    expect(thinking.events[0]?.eventKind).toBe("assistant_thinking");
    expect(thinking.events[0]?.payload).toEqual({ text: "sanitized reasoning summary" });
  });

  it("skips developer/system bootstrap and encrypted-only reasoning with per-path counters", () => {
    const developer = mapRolloutLine(byRole(fixtures, "developer"));
    expect(developer.events).toEqual([]);
    expect(developer.stats.developerMessage).toBe(1);
    expect(developer.stats.meta).toBe(1);

    const system = mapRolloutLine(byRole(fixtures, "system"));
    expect(system.events).toEqual([]);
    expect(system.stats.systemMessage).toBe(1);
    expect(system.stats.meta).toBe(1);

    const encrypted = mapRolloutLine(
      fixtures.find((item) => JSON.stringify(item).includes("encryptedOnly")) ?? byPayloadType(fixtures, "reasoning"),
    );
    expect(encrypted.events).toEqual([]);
    expect(encrypted.stats.encryptedReasoning).toBe(1);
    expect(encrypted.stats.meta).toBe(1);
  });

  it("maps function, custom, web, local shell, and tool-search calls/results", () => {
    const functionCall = mapRolloutLine(byPayloadType(fixtures, "function_call")).events[0];
    expect(functionCall?.eventKind).toBe("tool_call");
    if (functionCall?.eventKind !== "tool_call") throw new Error("expected tool_call");
    expect(functionCall.payload).toEqual({
      toolCallId: "call_rwnyHXTRCCDxHI1Q8PosPqSS",
      toolName: "exec_command",
      arguments: { cmd: "pwd", workdir: "/Users/leemoore/code/example" },
    });

    const functionOutput = mapRolloutLine(byPayloadType(fixtures, "function_call_output")).events[0];
    expect(functionOutput?.eventKind).toBe("tool_result");
    if (functionOutput?.eventKind !== "tool_result") throw new Error("expected tool_result");
    expect(functionOutput.payload.toolCallId).toBe("call_rwnyHXTRCCDxHI1Q8PosPqSS");
    expect(functionOutput.payload.content).toBe("sanitized command output");

    const customCall = mapRolloutLine(byPayloadType(fixtures, "custom_tool_call")).events[0];
    const customOutput = mapRolloutLine(byPayloadType(fixtures, "custom_tool_call_output")).events[0];
    expect(customCall?.eventKind).toBe("tool_call");
    expect(customOutput?.eventKind).toBe("tool_result");
    if (customCall?.eventKind !== "tool_call" || customOutput?.eventKind !== "tool_result") return;
    expect(customCall.payload.toolCallId).toBe("call_customTool123");
    expect(customCall.payload.arguments).toEqual({ path: "report.docx" });
    expect(customOutput.payload.toolCallId).toBe("call_customTool123");

    const toolSearchCall = mapRolloutLine(byPayloadType(fixtures, "tool_search_call")).events[0];
    const toolSearchOutput = mapRolloutLine(byPayloadType(fixtures, "tool_search_output")).events[0];
    expect(toolSearchCall?.eventKind).toBe("tool_call");
    expect(toolSearchOutput?.eventKind).toBe("tool_result");
    if (toolSearchCall?.eventKind !== "tool_call" || toolSearchOutput?.eventKind !== "tool_result") return;
    expect(toolSearchCall.payload.toolCallId).toBe("call_toolSearch123");
    expect(toolSearchCall.payload.toolName).toBe("tool_search");
    expect(toolSearchOutput.payload.toolCallId).toBe("call_toolSearch123");
  });

  it("synthesizes stable call ids when Codex omits call_id", () => {
    const web = byPayloadType(fixtures, "web_search_call");
    const firstWeb = mapRolloutLine(web).events[0];
    const secondWeb = mapRolloutLine(web).events[0];
    expect(firstWeb?.eventKind).toBe("tool_call");
    expect(secondWeb?.eventKind).toBe("tool_call");
    if (firstWeb?.eventKind !== "tool_call" || secondWeb?.eventKind !== "tool_call") return;
    expect(firstWeb.payload.toolCallId).toMatch(/^synthetic:[0-9a-f]{24}$/);
    expect(secondWeb.payload.toolCallId).toBe(firstWeb.payload.toolCallId);
    expect(firstWeb.payload.toolName).toBe("web_search");

    const localShell = byPayloadType(fixtures, "local_shell_call");
    const firstLocal = mapRolloutLine(localShell).events[0];
    const secondLocal = mapRolloutLine(localShell).events[0];
    expect(firstLocal?.eventKind).toBe("tool_call");
    expect(secondLocal?.eventKind).toBe("tool_call");
    if (firstLocal?.eventKind !== "tool_call" || secondLocal?.eventKind !== "tool_call") return;
    expect(firstLocal.payload.toolCallId).toMatch(/^synthetic:[0-9a-f]{24}$/);
    expect(secondLocal.payload.toolCallId).toBe(firstLocal.payload.toolCallId);
    expect(firstLocal.payload.arguments).toEqual({ cmd: "printf sanitized" });
  });

  it("maps top-level compacted to a runtime note and counts it", () => {
    const compacted = fixtures.find((item) => item.type === "compacted");
    expect(compacted).toBeDefined();
    const result = mapRolloutLine(compacted!);
    expect(result.stats.compacted).toBe(1);
    expect(result.events[0]?.eventKind).toBe("runtime_note");
    expect(result.events[0]?.payload).toEqual({
      text: "Codex native compaction occurred. window_number=2 first_window_id=win_first previous_window_id=win_prev window_id=win_current",
    });
  });

  it("skips turn_context, event_msg, unrecognized response items, and garbage without throwing", () => {
    const turnContext = mapRolloutLine(fixtures.find((item) => item.type === "turn_context")!);
    expect(turnContext.events).toEqual([]);
    expect(turnContext.stats.turnContext).toBe(1);
    expect(turnContext.stats.unknown).toBe(1);

    const eventMsg = mapRolloutLine(fixtures.find((item) => item.type === "event_msg")!);
    expect(eventMsg.events).toEqual([]);
    expect(eventMsg.stats.eventMsg).toBe(1);
    expect(eventMsg.stats.unknown).toBe(1);

    const unknownResponse = mapRolloutLine(byPayloadType(fixtures, "image_generation_call"));
    expect(unknownResponse.events).toEqual([]);
    expect(unknownResponse.stats.unrecognizedResponseItem).toBe(1);
    expect(unknownResponse.stats.unknown).toBe(1);

    expect(() => mapRolloutLine({ type: "totally_unknown", payload: { nope: true } })).not.toThrow();
    expect(mapRolloutLine({ type: "totally_unknown", payload: { nope: true } }).stats.unknown).toBe(1);
  });

  it("keeps event ordering and stable idempotency keys across re-tails", () => {
    const interesting = fixtures.filter((item) => item.type === "response_item" || item.type === "compacted");
    const result = mapRolloutLines(interesting);
    expect(result.events.map((event) => event.eventKind)).toEqual([
      "user_prompt",
      "user_prompt",
      "runtime_note",
      "assistant_text",
      "assistant_thinking",
      "tool_call",
      "tool_result",
      "tool_call",
      "tool_result",
      "tool_call",
      "tool_call",
      "tool_result",
      "tool_call",
      "runtime_note",
    ]);

    const userWithoutId = byRole(fixtures, "user");
    const first = mapRolloutLine(userWithoutId).events[0]?.idempotencyKey;
    const second = mapRolloutLine(userWithoutId).events[0]?.idempotencyKey;
    expect(first).toBe(second);
    expect(first).toMatch(/^codex-lhc:rollout:[0-9a-f]{24}:0:user_prompt$/);

    const assistant = byRole(fixtures, "assistant");
    expect(rolloutLineId(assistant)).toBe("msg_0628d05ea268274c016a4cde52bd4c8193808b70ab8accde2e");
    expect(mapRolloutLine(assistant).events[0]?.idempotencyKey).toBe(
      idempotencyKey("msg_0628d05ea268274c016a4cde52bd4c8193808b70ab8accde2e", 0, "assistant_text"),
    );
  });
});

describe("bootstrap instruction user messages", () => {
  it("maps AGENTS.md bootstrap to runtime_note, not user_prompt", () => {
    const line = {
      timestamp: "2026-07-07T12:00:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "# AGENTS.md instructions for /some/repo\n\n<INSTRUCTIONS>\ndo things\n</INSTRUCTIONS>" }],
      },
    } as never;
    const result = mapRolloutLine(line, 0);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.eventKind).toBe("runtime_note");
  });

  it("maps user_instructions and environment_context wrappers to runtime_note", () => {
    for (const text of ["<user_instructions>\nstuff\n</user_instructions>", "<environment_context>\ncwd: /x\n</environment_context>"]) {
      const line = {
        timestamp: "2026-07-07T12:00:00.000Z",
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
      } as never;
      const result = mapRolloutLine(line, 0);
      expect(result.events[0]!.eventKind).toBe("runtime_note");
    }
  });

  it("keeps ordinary prompts as user_prompt", () => {
    const line = {
      timestamp: "2026-07-07T12:00:00.000Z",
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "please fix the bug in AGENTS.md" }] },
    } as never;
    const result = mapRolloutLine(line, 0);
    expect(result.events[0]!.eventKind).toBe("user_prompt");
  });
});
