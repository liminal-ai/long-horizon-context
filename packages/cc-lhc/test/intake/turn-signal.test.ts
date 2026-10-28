import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { classifyTurnSignal } from "../../src/intake/turn-signal.js";
import type { RolloutLineItem } from "../../src/rollout/types.js";

function userText(text: string, extra: Partial<RolloutLineItem> = {}): RolloutLineItem {
  return { type: "user", uuid: "u1", message: { role: "user", content: text }, ...extra };
}

function assistant(stopReason: string | undefined, content: unknown = [{ type: "text", text: "hi" }]): RolloutLineItem {
  return {
    type: "assistant",
    uuid: "a1",
    message: {
      role: "assistant",
      content: content as never,
      ...(stopReason === undefined ? {} : { stop_reason: stopReason }),
    },
  };
}

describe("classifyTurnSignal", () => {
  it("a user prompt opens a turn", () => {
    expect(classifyTurnSignal(userText("do the thing"))).toBe("opens");
    expect(
      classifyTurnSignal({ type: "user", message: { role: "user", content: [{ type: "text", text: "hello" }] } }),
    ).toBe("opens");
  });

  it("a tool_result keeps the turn open", () => {
    expect(
      classifyTurnSignal({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      }),
    ).toBe("opens");
  });

  it("assistant classification is content-first, stop_reason as refinement", () => {
    expect(classifyTurnSignal(assistant("tool_use"))).toBe("opens");
    expect(classifyTurnSignal(assistant("end_turn"))).toBe("closes");
    expect(classifyTurnSignal(assistant("stop_sequence"))).toBe("closes");
    expect(classifyTurnSignal(assistant("max_tokens"))).toBe("closes");

    const toolBlocks = [{ type: "tool_use", id: "t1", name: "Bash", input: {} }];
    expect(classifyTurnSignal(assistant(undefined, toolBlocks))).toBe("opens");
    expect(classifyTurnSignal(assistant("tool_use", toolBlocks))).toBe("opens");

    expect(classifyTurnSignal(assistant(undefined))).toBe("closes");
    expect(classifyTurnSignal(assistant(undefined, "plain string response"))).toBe("closes");
    expect(classifyTurnSignal(assistant(undefined, [{ type: "thinking", thinking: "hmm" }]))).toBe("neutral");
    expect(classifyTurnSignal(assistant(undefined, []))).toBe("neutral");
  });

  it("folds the real 2.1.201 fixture (no stop_reason anywhere) without sticking open", () => {
    const fixturePath = new URL("../fixtures/rollout-samples.jsonl", import.meta.url);
    const items = readFileSync(fixturePath, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Parameters<typeof classifyTurnSignal>[0]);

    let open = false;
    const states: boolean[] = [];
    for (const item of items) {
      const signal = classifyTurnSignal(item);
      if (signal === "opens") open = true;
      else if (signal === "closes") open = false;
      states.push(open);
    }

    expect(states[0]).toBe(true);
    expect(states[1]).toBe(false);
    expect(states[2]).toBe(false);
    expect(states[3]).toBe(true);
    expect(states[4]).toBe(true);
    expect(states[5]).toBe(true);
    expect(states[14]).toBe(states[5]);
    expect(states[states.length - 1]).toBe(true);
  });

  it("interrupts close the turn (text, blocks, and interrupted tool_result forms)", () => {
    expect(classifyTurnSignal(userText("[Request interrupted by user]"))).toBe("closes");
    expect(
      classifyTurnSignal({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] },
      }),
    ).toBe("closes");
    expect(
      classifyTurnSignal({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "[Request interrupted by user for tool use]" }],
        },
      }),
    ).toBe("closes");
  });

  it("meta and runtime-note user lines are neutral", () => {
    expect(classifyTurnSignal(userText("anything", { isMeta: true }))).toBe("neutral");
    expect(classifyTurnSignal(userText("<local-command-stdout>ok</local-command-stdout>"))).toBe("neutral");
    expect(classifyTurnSignal(userText("[runtime note] swap receipt text"))).toBe("neutral");
    expect(classifyTurnSignal(userText("<task-notification>task done</task-notification>"))).toBe("neutral");
  });

  it("sidechain and non-conversation lines are neutral", () => {
    expect(classifyTurnSignal(userText("hello", { isSidechain: true }))).toBe("neutral");
    expect(classifyTurnSignal({ type: "summary", summary: "s" })).toBe("neutral");
    expect(classifyTurnSignal({ type: "file-history-snapshot" })).toBe("neutral");
    expect(classifyTurnSignal({ type: "attachment", attachment: {} })).toBe("neutral");
    expect(classifyTurnSignal({ type: "user" })).toBe("neutral");
  });
});
