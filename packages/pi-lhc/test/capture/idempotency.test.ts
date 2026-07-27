// Story 2 — idempotency: the deterministic key-construction goldens plus the
// architecture-risk double-replay. Single-event dedup (TC-2.7) does not prove
// reload/replay safety across a corpus, so a whole corpus is replayed twice and
// must add nothing the second time. The key goldens pin construction precedence:
// PI entry id → provider response / tool-call id → content fingerprint, with
// blockIndex and kind disambiguating one message's fan-out.

import { createDeterministicInferenceCallbacks, intakeStream, type MessageEventInput } from "lhc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { capture } from "../../src/capture/converter.js";
import { eventKey, parseEventKeySource } from "../../src/capture/idempotency.js";
import { mapMessage } from "../../src/capture/map-message.js";
import { mapModelSelect } from "../../src/capture/runtime-changes.js";
import { TurnAccumulator } from "../../src/capture/turn-accumulator.js";
import { initInstance } from "../../src/lifecycle/instance.js";
import type { RecordedPiHookEvent } from "../../src/verify/replay.js";
import { loadToolHeavyCorpus } from "../fixtures/corpus.js";
import { makeTempThread, type TempStore, tempStore } from "../fixtures/thread.js";

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
});

describe("Story 2: idempotency key construction (deterministic goldens)", () => {
  it("is deterministic: identical input yields an identical key", () => {
    const input = { piSessionId: "s", entryId: "e1", blockIndex: 0, kind: "assistant_text" } as const;
    expect(eventKey(input)).toBe(eventKey({ ...input }));
  });

  it("prefers the PI entry id, and disambiguates a message's fan-out by blockIndex and kind", () => {
    const thinking = eventKey({ piSessionId: "s", entryId: "e1", blockIndex: 0, kind: "assistant_thinking" });
    const text = eventKey({ piSessionId: "s", entryId: "e1", blockIndex: 1, kind: "assistant_text" });
    const textSameBlock = eventKey({ piSessionId: "s", entryId: "e1", blockIndex: 0, kind: "assistant_text" });
    expect(thinking).toContain("e1");
    // Same entry, different block → different key (fan-out stays distinct).
    expect(text).not.toBe(thinking);
    // Same entry + block, different kind → still distinct.
    expect(textSameBlock).not.toBe(thinking);
  });

  it("falls to the tool-call id when no entry id is present, separating call from result by kind", () => {
    const call = eventKey({ piSessionId: "s", toolCallId: "call_a", blockIndex: 0, kind: "tool_call" });
    const result = eventKey({ piSessionId: "s", toolCallId: "call_a", blockIndex: 0, kind: "tool_result" });
    expect(call).toContain("call_a");
    expect(result).toContain("call_a");
    expect(call).not.toBe(result);
  });

  it("falls to the provider response id below the entry id, above the content fingerprint", () => {
    const key = eventKey({ piSessionId: "s", responseId: "resp_7", blockIndex: 0, kind: "assistant_text" });
    expect(key).toContain("resp_7");
  });

  it("falls to content plus a stable discriminator as last resort", () => {
    const a = eventKey({
      piSessionId: "s",
      fallbackId: "entry-a",
      blockIndex: 0,
      kind: "user_prompt",
      role: "user",
      content: "hello",
    });
    const aAgain = eventKey({
      piSessionId: "s",
      fallbackId: "entry-a",
      blockIndex: 0,
      kind: "user_prompt",
      role: "user",
      content: "hello",
    });
    const b = eventKey({
      piSessionId: "s",
      fallbackId: "entry-b",
      blockIndex: 0,
      kind: "user_prompt",
      role: "user",
      content: "hello",
    });
    expect(aAgain).toBe(a);
    expect(b).not.toBe(a);
  });

  it("honors precedence: a present entry id wins over a present tool-call id", () => {
    const withBoth = eventKey({
      piSessionId: "s",
      entryId: "e9",
      toolCallId: "call_z",
      blockIndex: 0,
      kind: "tool_call",
    });
    const entryOnly = eventKey({ piSessionId: "s", entryId: "e9", blockIndex: 0, kind: "tool_call" });
    expect(withBoth).toBe(entryOnly);
  });

  it("uses caller-supplied source position fallback for same-content no-entry messages", () => {
    const first = mapMessage(
      { role: "user", content: [{ type: "text", text: "repeatable prompt" }], timestamp: 1_700_000_000_000 },
      { piSessionId: "s", fallbackId: "message_end:10" },
    );
    const firstReload = mapMessage(
      { role: "user", content: [{ type: "text", text: "repeatable prompt" }], timestamp: 1_700_000_000_000 },
      { piSessionId: "s", fallbackId: "message_end:10" },
    );
    const second = mapMessage(
      { role: "user", content: [{ type: "text", text: "repeatable prompt" }], timestamp: 1_700_000_000_000 },
      { piSessionId: "s", fallbackId: "message_end:11" },
    );

    expect(firstReload[0]!.idempotencyKey).toBe(first[0]!.idempotencyKey);
    expect(second[0]!.idempotencyKey).not.toBe(first[0]!.idempotencyKey);
  });

  it("uses caller-supplied source position fallback for repeated identical runtime changes", () => {
    const event = { model: { provider: "openai", id: "gpt-4o" } };
    const first = mapModelSelect(event, { piSessionId: "s", fallbackId: "model_select:20" });
    const firstReload = mapModelSelect(event, { piSessionId: "s", fallbackId: "model_select:20" });
    const second = mapModelSelect(event, { piSessionId: "s", fallbackId: "model_select:21" });

    expect(firstReload.idempotencyKey).toBe(first.idempotencyKey);
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
  });
});

describe("parseEventKeySource structural boundaries", () => {
  it.each([
    {
      name: "entry id with colons",
      key: eventKey({ piSessionId: "sess", entryId: "id:with:colons", blockIndex: 2, kind: "runtime_note" }),
      expected: { entryId: "id:with:colons", blockIndex: 2, kind: "runtime_note" },
    },
    {
      name: "entry id with % and delimiter-like segments",
      key: eventKey({
        piSessionId: "sess",
        entryId: "a%b:tool:x:kind:y",
        blockIndex: 0,
        kind: "tool_result",
      }),
      expected: { entryId: "a%b:tool:x:kind:y", blockIndex: 0, kind: "tool_result" },
    },
    {
      name: "session id containing :entry: still parses final entry segment",
      key: eventKey({ piSessionId: "s:entry:weird", entryId: "e1", blockIndex: 1, kind: "tool_result" }),
      expected: { entryId: "e1", blockIndex: 1, kind: "tool_result" },
    },
    {
      name: "tool id with colons",
      key: eventKey({ piSessionId: "sess", toolCallId: "T:colon", blockIndex: 0, kind: "tool_result" }),
      expected: { toolCallId: "T:colon", kind: "tool_result" },
    },
    {
      name: "tool-tier omission sibling id",
      key: eventKey({
        piSessionId: "sess",
        toolCallId: "T:colon:omission:12",
        blockIndex: 0,
        kind: "runtime_note",
      }),
      expected: { toolCallId: "T:colon:omission:12", kind: "runtime_note" },
    },
  ])("decodes URI-encoded ids: $name", ({ key, expected }) => {
    expect(parseEventKeySource(key)).toEqual(expected);
  });

  it.each([
    { name: "malformed percent escape", key: "pi:sess:entry:%zz:block:0:kind:tool_result" },
    { name: "malformed tool percent escape", key: "pi:sess:tool:%E0%A4%A:kind:tool_result" },
    { name: "partial entry key (no kind)", key: "pi:sess:entry:e1:block:0" },
    { name: "partial tool key (no kind)", key: "pi:sess:tool:call_a" },
    { name: "non-PI key", key: "other:system:entry:e1:block:0:kind:tool_result" },
    { name: "nonnumeric block index", key: "pi:sess:entry:e1:block:x:kind:tool_result" },
  ])("fails closed: $name", ({ key }) => {
    expect(parseEventKeySource(key)).toBeNull();
  });
});

function buildCorpusBatch(source: RecordedPiHookEvent[]): MessageEventInput[] {
  const acc = new TurnAccumulator({ piSessionId: "corpus" });
  const events: MessageEventInput[] = [];
  for (const record of source) {
    if (record.hook === "agent_end") {
      events.push(...acc.onAgentEnd());
      continue;
    }
    const mapped = mapMessage(record.message, { piSessionId: "corpus", entryId: record.entryId });
    acc.onMessage(mapped);
    events.push(...mapped);
  }
  return events;
}

describe("Story 2: corpus double-replay (idempotency architecture-risk)", () => {
  it("replaying the same corpus twice produces no duplicate events; re-delivered keys come back skipped", async () => {
    const thread = await makeTempThread(store);
    const built = await initInstance(thread.threadRef, {
      inferenceCallbacks: createDeterministicInferenceCallbacks(),
      mode: "background",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const instance = built.value;

    const batch = buildCorpusBatch(loadToolHeavyCorpus().source);

    const first = await capture(batch, instance);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value.events.every((entry) => entry.outcome === "recorded")).toBe(true);

    const replay = await capture(batch, instance);
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.value.events.every((entry) => entry.outcome === "skipped")).toBe(true);
    }

    const read = await intakeStream.listEvents(instance.threadRef);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value).toHaveLength(batch.length);

    await instance.dispose();
  });
});
