/** F5 note shaping: which tool calls of the rejected turn had completed. */

import { describe, expect, it } from "vitest";

import {
  completedToolCallsInLastTurn,
  MAX_LISTED_TOOL_CALLS,
  rejectionContinueNote,
} from "../../src/wrapper/rejection-continue.js";

const line = (value: unknown) => JSON.stringify(value);
const user = (content: unknown, extra: Record<string, unknown> = {}) =>
  line({ type: "user", message: { role: "user", content }, ...extra });
const toolUse = (id: string, name: string, input: unknown) =>
  line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
const toolResult = (id: string) => user([{ type: "tool_result", tool_use_id: id, content: "ok" }]);

describe("completedToolCallsInLastTurn", () => {
  it("lists only tool calls with a result, after the last real prompt, oldest first", () => {
    const rollout = [
      user("an earlier prompt"),
      toolUse("t0", "Bash", { command: "ls" }),
      toolResult("t0"),
      user("Read the whole PDF"),
      toolUse("t1", "Read", { file_path: "/w/report80.pdf", pages: "1-20" }),
      toolResult("t1"),
      toolUse("t2", "Read", { file_path: "/w/report80.pdf", pages: "21-40" }),
      toolResult("t2"),
      toolUse("t3", "Read", { file_path: "/w/report80.pdf", pages: "61-80" }),
      user("[runtime note] not a prompt"),
      '{"type":"user","message":{"content":"TORN',
    ].join("\n");
    expect(completedToolCallsInLastTurn(rollout)).toEqual([
      "Read(/w/report80.pdf, pages 1-20)",
      "Read(/w/report80.pdf, pages 21-40)",
    ]);
  });

  it("ignores meta and sidechain lines and returns nothing for an empty turn", () => {
    const rollout = [
      user("the prompt"),
      user("meta", { isMeta: true }),
      line({
        type: "assistant",
        isSidechain: true,
        message: { content: [{ type: "tool_use", id: "s", name: "Bash", input: {} }] },
      }),
      toolResult("s"),
    ].join("\n");
    expect(completedToolCallsInLastTurn(rollout)).toEqual([]);
    expect(completedToolCallsInLastTurn("")).toEqual([]);
  });
});

describe("rejectionContinueNote", () => {
  it("is one runtime-note line naming the rejection and the completed calls", () => {
    const note = rejectionContinueNote(["Read(/a, pages 1-20)"]);
    expect(note.startsWith("[runtime note] cc-lhc:")).toBe(true);
    expect(note).not.toContain("\n");
    expect(note).toContain("Prompt is too long");
    expect(note).toContain("Read(/a, pages 1-20)");
    expect(rejectionContinueNote([])).toContain("No tool calls had completed");
  });

  it("caps the list and counts the rest", () => {
    const calls = Array.from({ length: MAX_LISTED_TOOL_CALLS + 3 }, (_, i) => `Bash(${i})`);
    const note = rejectionContinueNote(calls);
    expect(note).toContain(`Bash(${MAX_LISTED_TOOL_CALLS - 1})`);
    expect(note).not.toContain(`Bash(${MAX_LISTED_TOOL_CALLS})`);
    expect(note).toContain("and 3 more");
  });
});
