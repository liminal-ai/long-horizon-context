// FC-0.4 fixture builders: the Convex test fixtures produce golden-shaped
// events. This is the applicable-ported core of the frozen fixtures suite —
// the only legs whose SUBJECT (the shared test-fixture builders) exists on the
// Convex port and has no other home.
//
// Substrate / frozen-fixture-specific legs (documented n/a in the ledger):
//   - FC-0.1/FC-0.2 `InferenceCallbacksDouble` (smoothPrompt/summarizeToolResult/
//     failNext/failKind/delayKind/captureInputs) is a DIRECT-CALLBACK double
//     that the Convex port does not have. Its analog is the fake model host
//     (`test/convex/model.ts`) with model-string scripting and `capturedCalls`,
//     which is exercised across smoothed_prompt_guards / smoothing_recovery /
//     inference_* suites. The two mechanisms share no API, so there is no
//     faithful port.
//   - FC-0.4 `tempStore`/`openRaw` build a real SQLite file and a raw handle;
//     the Convex analog is `convexTest` + `fixture.test.run`, used throughout.
//   - FC-0.1 production-seam `initLhc({ inferenceCallbacks })` asserts the
//     direct-callback config surface (absent on Convex — see
//     inference_construction.test.ts) and lease defaults (lease was removed
//     upstream). Construction validation and config-default resolution are
//     covered by inference_construction.test.ts and assignment_config.test.ts.
//   - FC-0.3/FC-0.6 frozen thread-builders (`threadWithClosedTurns`,
//     `threadWithToolRun`, `multiStateThread`, `damagedSourceThread`) do not
//     exist on the Convex port. Their behavioral SUBJECTS are covered by
//     dedicated ported suites: the four-state derivation vocabulary and its
//     state-shape contract by view_fixture.test.ts / inspect_health.test.ts,
//     tool-outcome metadata by tool_result_summary_inference.test.ts (whose
//     metadata carries provenance beyond `{ outcome }`, unlike the frozen
//     double), closed-turn membership by turns.test.ts, and the
//     two-open-turns corruption refusal by turns.test.ts (`turn_state_corrupt`).
import { describe, expect, test } from "vitest";
import type { EventKind } from "../src/client/index.js";
import { conversationTurn, eventBatch, validEvent } from "./fixtures/index.js";

const ALL_KINDS: readonly EventKind[] = [
  "user_prompt",
  "assistant_text",
  "assistant_thinking",
  "runtime_note",
  "model_change",
  "thinking_level_change",
  "tool_call",
  "tool_result",
  "turn_end",
];

const GOLDEN_PAYLOAD_KEYS: Record<EventKind, string[]> = {
  user_prompt: ["text"],
  assistant_text: ["text"],
  assistant_thinking: ["text"],
  runtime_note: ["text"],
  model_change: ["previousModel", "newModel"],
  thinking_level_change: ["previousLevel", "newLevel"],
  tool_call: ["toolCallId", "toolName", "arguments"],
  tool_result: ["toolCallId", "content", "isError"],
  turn_end: [],
};

describe("FC-0.4: fixture builders", () => {
  test("validEvent produces a golden-shaped event for every kind", () => {
    for (const kind of ALL_KINDS) {
      const event = validEvent(kind);
      expect(event.eventKind).toBe(kind);
      expect(event.idempotencyKey.length).toBeGreaterThan(0);
      expect(event.actor.length).toBeGreaterThan(0);
      expect(event.harness.length).toBeGreaterThan(0);
      expect(Object.keys(event.payload).sort()).toEqual([...GOLDEN_PAYLOAD_KEYS[kind]].sort());
      expect(Object.keys(event).sort()).toEqual(["actor", "eventKind", "harness", "idempotencyKey", "payload"].sort());
    }
  });

  test("validEvent applies overrides without changing the kind", () => {
    const event = validEvent("user_prompt", {
      actor: "custom-actor",
      payload: { text: "custom prompt" },
    });
    expect(event.eventKind).toBe("user_prompt");
    expect(event.actor).toBe("custom-actor");
    expect(event.payload.text).toBe("custom prompt");
  });

  test("eventBatch yields unique idempotency keys in order", () => {
    const batch = eventBatch(ALL_KINDS);
    expect(batch.map((e) => e.eventKind)).toEqual([...ALL_KINDS]);
    const keys = new Set(batch.map((e) => e.idempotencyKey));
    expect(keys.size).toBe(batch.length);
  });

  test("conversationTurn is one complete turn", () => {
    expect(conversationTurn().map((e) => e.eventKind)).toEqual([
      "user_prompt",
      "assistant_text",
      "tool_call",
      "tool_result",
      "turn_end",
    ]);
  });
});
