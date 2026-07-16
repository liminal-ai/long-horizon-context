// Render targets — the in-memory model-context shape (TC-5.1). One view, two
// shapes: model-context messages and the materialized PI session file must
// carry the same content because they come from the same assembly. Only the
// in-memory model-context leg is ported here.
//
// EXCLUDED (substrate-only, deliberately absent — no analog on the Convex
// surface): the port exposes no `threadView.materialize` and no PI-session
// file target, so the frozen file-writing legs cannot be ported:
//   - TC-5.2 (AC-5.2, AC-5.3): materialize/model-context parity, byte-identical
//     repeat, thread state untouched — needs materialize + on-disk session file.
//   - TC-5.3 (AC-5.4): a never-compacted thread materializes its tail-only view
//     — needs materialize + PI-session conformance fixture.
//   - TC-5.5 (AC-5.3): materialized file conforms to the real-PI-session
//     structure fixture — needs materialize + the .jsonl parentId chain.
// The model-context/materialize parity these guard is the same assembly the
// ported TC-5.1 exercises directly; the file target itself is out of scope.
import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { LlmRequestContext } from "../src/client/index.js";

type LlmRequestContextMessage = LlmRequestContext["messages"][number];

import { type DerivedThreadFixture, derivedThreadFixture } from "./fixtures/index.js";

let fixture: DerivedThreadFixture;

beforeAll(async () => {
  fixture = await derivedThreadFixture();
});

// All three bands non-empty (Story 2's reference config: smooth t7+t8,
// detailed c2, brief c1; compact point at t9's start).
const GRADIENT_PARAMS = {
  lowerBound: 400,
  percentages: { full: 25, smooth: 16, detailed: 10, brief: 49 },
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function messageText(message: LlmRequestContextMessage | undefined): string | undefined {
  return message?.content.map((part) => part.text).join("");
}

describe("TC-5.1 (AC-5.1): model context opens with band context messages in gradient order, tail in record order, deterministic", () => {
  it("bands brief → detailed → smooth with labels, then the tail; repeated contexts byte-identical", async () => {
    const ref = { filePath: fixture.filePath };
    const compacted = await fixture.sdk.threadView.compact(ref, { params: GRADIENT_PARAMS });
    expect(compacted.ok).toBe(true);

    const first = await fixture.sdk.threadView.getLlmRequestContext(ref);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const messages = first.value.messages;
    const texts = messages.map((message) => messageText(message));

    // Band messages open the array in gradient order, each a labeled `user`
    // context message carrying its band marker.
    const bandTexts = texts.filter((text) => text?.startsWith("[context ·"));
    expect(bandTexts.map((text) => text?.match(/^\[context · ([^\]]+)\]/)?.[1])).toEqual([
      "brief",
      "detailed",
      "smooth",
    ]);
    for (let i = 0; i < bandTexts.length; i += 1) {
      expect(messages[i]?.role).toBe("user");
    }
    expect(texts.slice(0, bandTexts.length)).toEqual(bandTexts);

    // Tail follows in record order: with this config the compact point sits
    // at t9's start, so the tail opens with turn 9's prompt and carries the
    // turn 9–12 prompts in conversation order.
    const tail = messages.slice(bandTexts.length);
    const tailTexts = tail.map((message) => messageText(message));
    expect(tail[0]).toEqual({ role: "user", content: [{ type: "text", text: "turn 9: please investigate area 9" }] });
    const prompts = tailTexts.filter((text) => text?.startsWith("turn ")).map((text) => text?.split(":")[0]);
    expect(prompts).toEqual(["turn 9", "turn 10", "turn 11", "turn 12"]);
    // Roles per the pinned mapping: prompts/tool-results user, the
    // assistant kinds assistant.
    for (const m of tail) {
      const text = messageText(m) ?? "";
      if (text.startsWith("[tool call") || text.startsWith("[thinking]")) {
        expect(m.role).toBe("assistant");
      }
      if (text.startsWith("[tool result")) expect(m.role).toBe("user");
    }

    // Deterministic across repeated model-context reads: byte-identical result.
    const second = await fixture.sdk.threadView.getLlmRequestContext(ref);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(sha256(JSON.stringify(second.value))).toBe(sha256(JSON.stringify(first.value)));
    expect(JSON.stringify(second.value)).toBe(JSON.stringify(first.value));
  });
});
