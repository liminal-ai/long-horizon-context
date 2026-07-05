import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { idempotencyKey, mapRolloutLine, mapRolloutLines } from "../../src/intake/map.js";
import type { RolloutLineItem } from "../../src/rollout/types.js";

const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "rollout-samples.jsonl");

function loadFixtures(): RolloutLineItem[] {
  const raw = readFileSync(FIXTURE_PATH, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RolloutLineItem);
}

function fixtureByUuid(items: RolloutLineItem[], uuid: string): RolloutLineItem {
  const found = items.find((item) => item.uuid === uuid);
  if (found === undefined) throw new Error(`fixture uuid not found: ${uuid}`);
  return found;
}

describe("mapRolloutLine", () => {
  const fixtures = loadFixtures();

  it("maps user string content to user_prompt", () => {
    const item = fixtureByUuid(fixtures, "6af56548-c936-4505-8540-bbb25ca7203c");
    const result = mapRolloutLine(item);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.eventKind).toBe("user_prompt");
    expect(result.events[0]?.payload).toEqual({ text: "hi opus how are you" });
    expect(result.events[0]?.idempotencyKey).toBe(
      idempotencyKey("6af56548-c936-4505-8540-bbb25ca7203c", 0, "user_prompt"),
    );
  });

  it("maps assistant text blocks", () => {
    const item = fixtureByUuid(fixtures, "asst-text-uuid");
    const result = mapRolloutLine(item);
    expect(result.events.map((event) => event.eventKind)).toEqual(["assistant_text"]);
    expect(result.events[0]?.payload).toEqual({ text: "Hey Lee, doing well — ready to work whenever you are." });
  });

  it("maps assistant thinking blocks", () => {
    const item = fixtureByUuid(fixtures, "think-uuid");
    const result = mapRolloutLine(item);
    expect(result.events.map((event) => event.eventKind)).toEqual(["assistant_thinking"]);
    expect(result.events[0]?.idempotencyKey).toBe(idempotencyKey("think-uuid", 0, "assistant_thinking"));
  });

  it("maps assistant tool_use to tool_call", () => {
    const item = fixtureByUuid(fixtures, "tool-use-uuid");
    const result = mapRolloutLine(item);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.eventKind).toBe("tool_call");
    if (result.events[0]?.eventKind !== "tool_call") throw new Error("expected tool_call");
    expect(result.events[0].payload.toolCallId).toBe("toolu_01XpkWcX1HQAKouXbYtDfbDD");
    expect(result.events[0].payload.toolName).toBe("Bash");
    expect(result.events[0].payload.arguments).toEqual({ command: "ls", description: "List dir" });
  });

  it("maps user tool_result with isError", () => {
    const item = fixtureByUuid(fixtures, "tool-result-uuid");
    const result = mapRolloutLine(item);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.eventKind).toBe("tool_result");
    if (result.events[0]?.eventKind !== "tool_result") throw new Error("expected tool_result");
    expect(result.events[0].payload.toolCallId).toBe("toolu_01XpkWcX1HQAKouXbYtDfbDD");
    expect(result.events[0].payload.isError).toBe(true);
    expect(result.events[0].payload.content).toContain("Exit code 1");
  });

  it("maps successful tool_result", () => {
    const item = fixtureByUuid(fixtures, "tool-result-ok-uuid");
    const result = mapRolloutLine(item);
    if (result.events[0]?.eventKind !== "tool_result") throw new Error("expected tool_result");
    expect(result.events[0].payload.isError).toBe(false);
    expect(result.events[0].payload.content).toBe("dump-view.ts");
  });

  it("skips sidechain records and counts them", () => {
    const item = fixtureByUuid(fixtures, "sidechain-uuid");
    const result = mapRolloutLine(item);
    expect(result.events).toHaveLength(0);
    expect(result.stats.sidechain).toBe(1);
  });

  it("skips summary and file-history-snapshot", () => {
    const summary = fixtures.find((item) => item.type === "summary");
    const snapshot = fixtures.find((item) => item.type === "file-history-snapshot");
    expect(summary).toBeDefined();
    expect(snapshot).toBeDefined();
    expect(mapRolloutLine(summary!).stats.unknown).toBe(1);
    expect(mapRolloutLine(snapshot!).stats.unknown).toBe(1);
  });

  it("skips unknown record types (mode, attachment, system)", () => {
    const unknowns = fixtures.filter((item) => item.type === "mode" || item.attachment !== undefined || item.type === "system");
    expect(unknowns.length).toBeGreaterThanOrEqual(3);
    for (const item of unknowns) {
      const result = mapRolloutLine(item);
      expect(result.events).toHaveLength(0);
      expect(result.stats.unknown).toBe(1);
    }
  });

  it("preserves rollout ordering across a batch", () => {
    const batch = [
      fixtureByUuid(fixtures, "6af56548-c936-4505-8540-bbb25ca7203c"),
      fixtureByUuid(fixtures, "asst-text-uuid"),
      fixtureByUuid(fixtures, "tool-use-uuid"),
      fixtureByUuid(fixtures, "tool-result-uuid"),
    ];
    const result = mapRolloutLines(batch);
    expect(result.events.map((event) => event.eventKind)).toEqual([
      "user_prompt",
      "assistant_text",
      "tool_call",
      "tool_result",
    ]);
  });

  it("idempotency keys are stable for re-tail", () => {
    const item = fixtureByUuid(fixtures, "tool-use-uuid");
    const first = mapRolloutLine(item).events[0]?.idempotencyKey;
    const second = mapRolloutLine(item).events[0]?.idempotencyKey;
    expect(first).toBe(second);
    expect(first).toMatch(/^cc-lhc:rollout:/);
  });

  it("skips local-command/meta user noise and counts skipped_meta", () => {
    const metaUuids = [
      "0debcb9a-9684-41d8-a8c3-512ad63caccc",
      "47345acc-c239-4b58-a674-15d4bd02c5d5",
      "25299885-e421-468f-9107-06f15c3cd4db",
    ];
    let metaCount = 0;
    for (const uuid of metaUuids) {
      const result = mapRolloutLine(fixtureByUuid(fixtures, uuid));
      expect(result.events).toHaveLength(0);
      metaCount += result.stats.meta;
    }
    expect(metaCount).toBe(3);
  });

  it("still maps genuine user prompts adjacent to meta lines", () => {
    const result = mapRolloutLine(fixtureByUuid(fixtures, "6af56548-c936-4505-8540-bbb25ca7203c"));
    expect(result.events[0]?.eventKind).toBe("user_prompt");
    expect(result.stats.meta).toBe(0);
  });

  it("appends image placeholder and counts skipped_image for text+image content", () => {
    const imageLine = fixtures.find(
      (item) =>
        Array.isArray(item.message?.content) &&
        (item.message.content as Array<{ type?: string }>).some((block) => block.type === "image"),
    );
    expect(imageLine).toBeDefined();
    const result = mapRolloutLine(imageLine!);
    expect(result.stats.image).toBe(1);
    expect(result.events).toHaveLength(1);
    if (result.events[0]?.eventKind !== "user_prompt") throw new Error("expected user_prompt");
    expect(result.events[0].payload.text).toContain("[Image #1]");
    expect(result.events[0].payload.text).toContain("[image content not captured]");
  });

  it("maps task-notification user messages to runtime_note, not user_prompt", () => {
    const blob =
      '<task-notification>\n<task id="b-1" tool-use-id="toolu_x">\n<status>completed</status>\n<summary>build finished</summary>\n<output-file>/tmp/out.txt</output-file>\n</task>\n</task-notification>';
    const item = {
      type: "user",
      uuid: "task-note-uuid",
      message: { role: "user", content: blob },
    } as RolloutLineItem;
    const result = mapRolloutLine(item);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.eventKind).toBe("runtime_note");
    expect(result.events[0]?.actor).toBe("system");
    expect(result.events[0]?.payload).toEqual({ text: blob });
    expect(result.events[0]?.idempotencyKey).toBe(idempotencyKey("task-note-uuid", 0, "runtime_note"));
    expect(result.stats.meta).toBe(0);
    expect(result.stats.unknown).toBe(0);
  });

  it("maps task-notification text blocks and tolerates leading whitespace", () => {
    const item = {
      type: "user",
      uuid: "task-note-block-uuid",
      message: {
        role: "user",
        content: [{ type: "text", text: "  <task-notification>task done</task-notification>" }],
      },
    } as RolloutLineItem;
    const result = mapRolloutLine(item);
    expect(result.events.map((event) => event.eventKind)).toEqual(["runtime_note"]);
  });

  it("keeps rebuilt-rollout runtime-note lines classified as runtime_note on re-tail", () => {
    const item = {
      type: "user",
      uuid: "rebuilt-note-uuid",
      message: { role: "user", content: "[runtime note] <task-notification>task done</task-notification>" },
    } as RolloutLineItem;
    const result = mapRolloutLine(item);
    expect(result.events.map((event) => event.eventKind)).toEqual(["runtime_note"]);
  });

  it("keeps prompts that merely mention task notifications as user_prompt", () => {
    const item = {
      type: "user",
      uuid: "mention-uuid",
      message: { role: "user", content: "why did the <task-notification> block show up in my transcript?" },
    } as RolloutLineItem;
    const result = mapRolloutLine(item);
    expect(result.events.map((event) => event.eventKind)).toEqual(["user_prompt"]);
  });

  it("uses line index in synthetic idempotency keys for uuid-less lines", () => {
    const lineA = { type: "mode", sessionId: "sess-1" } as RolloutLineItem;
    const lineB = { type: "mode", sessionId: "sess-1" } as RolloutLineItem;
    expect(mapRolloutLine(lineA, 0).stats.unknown).toBe(1);
    expect(mapRolloutLine(lineB, 1).stats.unknown).toBe(1);
    // Exercised via user lines without uuid in batch mapping — keys differ by line index.
    const noUuidA = {
      type: "user",
      sessionId: "sess-1",
      message: { role: "user", content: "a" },
    } as RolloutLineItem;
    const noUuidB = {
      type: "user",
      sessionId: "sess-1",
      message: { role: "user", content: "b" },
    } as RolloutLineItem;
    const batch = mapRolloutLines([noUuidA, noUuidB]);
    const keys = batch.events.map((event) => event.idempotencyKey);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[0]).toContain("synthetic:sess-1:user:0:");
    expect(keys[1]).toContain("synthetic:sess-1:user:1:");
  });
});
