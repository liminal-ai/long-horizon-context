import { describe, expect, it } from "vitest";

import {
  classifyTurnSignal,
  createCodexTurnSignalClassifier,
  turnIdForSignal,
} from "../../src/intake/turn-signal.js";
import type { RolloutLineItem } from "../../src/rollout/types.js";

function event(type: string, turnId = "turn-a"): RolloutLineItem {
  return { timestamp: "2026-07-07T11:09:04.000Z", type: "event_msg", payload: { type, turn_id: turnId } };
}

function turnContext(turnId: string): RolloutLineItem {
  return { timestamp: "2026-07-07T11:09:06.000Z", type: "turn_context", payload: { turn_id: turnId } };
}

describe("codex turn signal", () => {
  it("uses Codex lifecycle events as the primary open/close signal", () => {
    expect(classifyTurnSignal(event("task_started"))).toBe("opens");
    expect(classifyTurnSignal(event("task_complete"))).toBe("closes");
    expect(classifyTurnSignal(event("turn_aborted"))).toBe("closes");
  });

  it("treats non-lifecycle event_msg subtypes as neutral", () => {
    expect(classifyTurnSignal(event("user_message"))).toBe("neutral");
    expect(classifyTurnSignal(event("agent_message"))).toBe("neutral");
    expect(classifyTurnSignal(event("token_count"))).toBe("neutral");
  });

  it("uses turn_context as a stateless opens signal for the copied session fold", () => {
    const item = turnContext("turn-b");
    expect(turnIdForSignal(item)).toBe("turn-b");
    expect(classifyTurnSignal(item)).toBe("opens");
  });

  it("offers a stateful classifier so repeated turn_context ids do not reopen", () => {
    const classifier = createCodexTurnSignalClassifier();
    expect(classifier.classify(turnContext("turn-a"))).toBe("opens");
    expect(classifier.currentTurnId()).toBe("turn-a");
    expect(classifier.classify(turnContext("turn-a"))).toBe("neutral");
    expect(classifier.classify(turnContext("turn-b"))).toBe("opens");
    expect(classifier.currentTurnId()).toBe("turn-b");
  });

  it("closes on task_complete/turn_aborted and stays tolerant of duplicate closes", () => {
    const classifier = createCodexTurnSignalClassifier();
    expect(classifier.classify(event("task_started", "turn-a"))).toBe("opens");
    expect(classifier.currentTurnId()).toBe("turn-a");
    expect(classifier.classify(event("task_complete", "turn-a"))).toBe("closes");
    expect(classifier.currentTurnId()).toBeUndefined();
    expect(classifier.classify(event("task_complete", "turn-a"))).toBe("closes");
    expect(classifier.classify(event("turn_aborted", "turn-a"))).toBe("closes");
  });

  it("ignores response_item content because user prompts close turns in LHC intake", () => {
    expect(
      classifyTurnSignal({
        timestamp: "2026-07-07T11:09:05.099Z",
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "prompt" }] },
      }),
    ).toBe("neutral");
    expect(
      classifyTurnSignal({
        timestamp: "2026-07-07T11:09:09.942Z",
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
      }),
    ).toBe("neutral");
  });

  it("is neutral for malformed or unknown lines", () => {
    expect(classifyTurnSignal({ type: "event_msg", payload: { nope: true } })).toBe("neutral");
    expect(classifyTurnSignal({ type: "turn_context", payload: {} })).toBe("neutral");
    expect(classifyTurnSignal({ type: "garbage_msg", payload: { type: "task_complete" } })).toBe("neutral");
    expect(classifyTurnSignal({ type: "event_msg" })).toBe("neutral");
  });
});
