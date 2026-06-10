import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { EventKind } from "../src/index.js";
import {
  conversationTurn,
  eventBatch,
  openRaw,
  tempStore,
  validEvent,
} from "./fixtures/index.js";

const ALL_KINDS: readonly EventKind[] = [
  "user_prompt",
  "assistant_text",
  "assistant_thinking",
  "runtime_note",
  "tool_call",
  "tool_result",
  "turn_end",
];

const GOLDEN_PAYLOAD_KEYS: Record<EventKind, string[]> = {
  user_prompt: ["text"],
  assistant_text: ["text"],
  assistant_thinking: ["text"],
  runtime_note: ["text"],
  tool_call: ["toolCallId", "toolName", "arguments"],
  tool_result: ["toolCallId", "content", "isError"],
  turn_end: [],
};

describe("FC-0.4: fixture builders", () => {
  it("validEvent produces a golden-shaped event for every kind", () => {
    for (const kind of ALL_KINDS) {
      const event = validEvent(kind);
      expect(event.eventKind).toBe(kind);
      expect(event.idempotencyKey.length).toBeGreaterThan(0);
      expect(event.actor.length).toBeGreaterThan(0);
      expect(event.harness.length).toBeGreaterThan(0);
      expect(Object.keys(event.payload).sort()).toEqual(
        [...GOLDEN_PAYLOAD_KEYS[kind]].sort(),
      );
      expect(Object.keys(event).sort()).toEqual(
        ["actor", "eventKind", "harness", "idempotencyKey", "payload"].sort(),
      );
    }
  });

  it("validEvent applies overrides without changing the kind", () => {
    const event = validEvent("user_prompt", {
      actor: "custom-actor",
      payload: { text: "custom prompt" },
    });
    expect(event.eventKind).toBe("user_prompt");
    expect(event.actor).toBe("custom-actor");
    expect(event.payload.text).toBe("custom prompt");
  });

  it("building an invalid kind/payload pairing requires an explicit cast", () => {
    const forced = validEvent("user_prompt", {
      // @ts-expect-error — a tool_call payload on a user_prompt event must not compile
      payload: { toolCallId: "x", toolName: "y", arguments: {} },
    });
    expect(forced.eventKind).toBe("user_prompt");
  });

  it("eventBatch yields unique idempotency keys in order", () => {
    const batch = eventBatch(ALL_KINDS);
    expect(batch.map((e) => e.eventKind)).toEqual([...ALL_KINDS]);
    const keys = new Set(batch.map((e) => e.idempotencyKey));
    expect(keys.size).toBe(batch.length);
  });

  it("conversationTurn is one complete turn", () => {
    expect(conversationTurn().map((e) => e.eventKind)).toEqual([
      "user_prompt",
      "assistant_text",
      "tool_call",
      "tool_result",
      "turn_end",
    ]);
  });

  it("tempStore creates an isolated directory and cleans it up", () => {
    const store = tempStore();
    expect(existsSync(store.dir)).toBe(true);
    expect(store.registryPath.startsWith(store.dir)).toBe(true);
    const a = store.threadPath();
    const b = store.threadPath();
    expect(a).not.toBe(b);
    store.cleanup();
    expect(existsSync(store.dir)).toBe(false);
  });

  it("openRaw opens a real sqlite handle for below-SDK assertions", () => {
    const store = tempStore();
    const path = store.threadPath("raw");
    const writer = openRaw(path);
    writer.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, note TEXT)");
    writer.exec("INSERT INTO probe (note) VALUES ('hello')");
    writer.close();
    const reader = openRaw(path);
    const row = reader.prepare("SELECT note FROM probe WHERE id = 1").get() as
      | { note: string }
      | undefined;
    expect(row?.note).toBe("hello");
    reader.close();
    store.cleanup();
  });
});
