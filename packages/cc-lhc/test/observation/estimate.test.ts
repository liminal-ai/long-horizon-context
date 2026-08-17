/**
 * LIM-80 Slice 4 lock-in: the host-byte post-measurement estimate counts ONLY
 * accepted LHC canonical payload (assistant text/thinking, user prompts, runtime
 * notes, tool calls, and ACCEPTED tool results). Event chrome / markers contribute
 * nothing; provider `output_tokens` is preferred when present. These bytes feed the
 * trigger's next-request pressure — SDK view/zone measures never do.
 */
import type { MessageEventInput } from "lhc";
import { describe, expect, it } from "vitest";

import {
  canonicalPayloadBytes,
  HOST_CANONICAL_PAYLOAD_BYTE_ESTIMATE_SOURCE,
  hostEstimateFromCanonicalEvents,
  readProviderOutputTokens,
  totalCanonicalPayloadBytes,
} from "../../src/observation/estimate.js";

const ev = (eventKind: string, payload: Record<string, unknown>): MessageEventInput =>
  ({
    eventKind,
    idempotencyKey: `k-${eventKind}`,
    actor: "assistant",
    harness: "claude",
    payload,
  }) as MessageEventInput;

describe("canonicalPayloadBytes (accepted canonical payload only)", () => {
  it("counts assistant text/thinking, user prompt, runtime note by UTF-8 bytes", () => {
    expect(canonicalPayloadBytes(ev("assistant_text", { text: "hello" }))).toBe(5);
    expect(canonicalPayloadBytes(ev("assistant_thinking", { text: "abc" }))).toBe(3);
    expect(canonicalPayloadBytes(ev("user_prompt", { text: "hi" }))).toBe(2);
    expect(canonicalPayloadBytes(ev("runtime_note", { text: "note" }))).toBe(4);
  });

  it("counts an ACCEPTED tool_result's content", () => {
    expect(canonicalPayloadBytes(ev("tool_result", { content: "tool output body" }))).toBe(
      Buffer.byteLength("tool output body", "utf8"),
    );
  });

  it("counts a tool_call's name + serialized arguments", () => {
    const bytes = canonicalPayloadBytes(ev("tool_call", { toolName: "Bash", arguments: { cmd: "ls" } }));
    expect(bytes).toBe(Buffer.byteLength("Bash", "utf8") + Buffer.byteLength(JSON.stringify({ cmd: "ls" }), "utf8"));
  });

  it("counts NOTHING for markers / chrome (turn_end, model_change, compact markers)", () => {
    expect(canonicalPayloadBytes(ev("turn_end", {}))).toBe(0);
    expect(canonicalPayloadBytes(ev("model_change", { model: "opus" }))).toBe(0);
    expect(canonicalPayloadBytes(ev("thinking_level_change", { level: "high" }))).toBe(0);
  });

  it("totalCanonicalPayloadBytes sums only the accepted events", () => {
    const events = [
      ev("user_prompt", { text: "hi" }), // 2
      ev("assistant_text", { text: "hello" }), // 5
      ev("tool_result", { content: "abcd" }), // 4
      ev("turn_end", {}), // 0
    ];
    expect(totalCanonicalPayloadBytes(events)).toBe(11);
    // ~bytes/4 host estimate, explicitly source-labelled as accepted canonical payload.
    const est = hostEstimateFromCanonicalEvents(events);
    expect(est.source).toBe(HOST_CANONICAL_PAYLOAD_BYTE_ESTIMATE_SOURCE);
  });
});

describe("readProviderOutputTokens (provider-preferred)", () => {
  it("reads a valid output_tokens (snake or camel)", () => {
    expect(readProviderOutputTokens({ output_tokens: 1234 })).toBe(1234);
    expect(readProviderOutputTokens({ outputTokens: 7 })).toBe(7);
  });
  it("rejects missing / invalid / negative", () => {
    expect(readProviderOutputTokens({})).toBeNull();
    expect(readProviderOutputTokens(null)).toBeNull();
    expect(readProviderOutputTokens({ output_tokens: -1 })).toBeNull();
    expect(readProviderOutputTokens({ output_tokens: 1.5 })).toBeNull();
    expect(readProviderOutputTokens({ output_tokens: "9" })).toBeNull();
  });
});
