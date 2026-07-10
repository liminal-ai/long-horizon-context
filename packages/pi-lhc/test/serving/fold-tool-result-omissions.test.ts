import type { SessionThreadViewEntry, SessionToolResultMessage, SessionUserMessage } from "lhc";
import { describe, expect, it } from "vitest";
import { eventKey } from "../../src/capture/idempotency.js";
import {
  foldToolResultOmissionNotes,
  isToolResultOmissionNote,
} from "../../src/serving/fold-tool-result-omissions.js";

function entryKey(entryId: string, blockIndex: number, kind: "tool_result" | "runtime_note"): string {
  return eventKey({ piSessionId: "sess", entryId, blockIndex, kind });
}

function toolKey(toolCallId: string, kind: "tool_result" | "runtime_note"): string {
  return eventKey({ piSessionId: "sess", toolCallId, blockIndex: 0, kind });
}

function toolResult(
  toolCallId: string,
  content: string,
  key: string,
  messageId = `m-${toolCallId}`,
): SessionToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content,
    sourceMessages: [{ messageId, idempotencyKey: key }],
  };
}

function runtimeNoteUser(text: string, key: string, messageId: string): SessionUserMessage {
  return {
    role: "user",
    content: `[runtime note] ${text}`,
    sourceMessages: [{ messageId, idempotencyKey: key }],
  };
}

function rolesOf(entries: readonly SessionThreadViewEntry[]): string[] {
  return entries.map((entry) => {
    if ("role" in entry) return entry.role;
    return entry.kind;
  });
}

describe("isToolResultOmissionNote", () => {
  it("associates via shared PI entry identity and higher block index", () => {
    const result = toolResult("call_1", "body", entryKey("e1", 0, "tool_result"));
    const note = runtimeNoteUser("unsupported content omitted: image part", entryKey("e1", 1, "runtime_note"), "m-n1");
    expect(isToolResultOmissionNote(result, note)).toBe(true);
  });

  it("rejects a different PI entry even when adjacent", () => {
    const result = toolResult("call_1", "body", entryKey("e1", 0, "tool_result"));
    const note = runtimeNoteUser("task finished", entryKey("e-other", 0, "runtime_note"), "m-n");
    expect(isToolResultOmissionNote(result, note)).toBe(false);
  });

  it("associates tool-tier omission keys when entry id is absent", () => {
    const result = toolResult("call_file", "", toolKey("call_file", "tool_result"));
    const note = runtimeNoteUser(
      "unsupported content omitted: file reference (a.bin)",
      toolKey("call_file:omission:0", "runtime_note"),
      "m-n",
    );
    expect(isToolResultOmissionNote(result, note)).toBe(true);
  });

  it("does not use English omission text for association", () => {
    const result = toolResult("call_1", "body", entryKey("e1", 0, "tool_result"));
    // Same wording as capture would emit, but no structural key link.
    const note = runtimeNoteUser(
      "unsupported content omitted: image part (image/png)",
      entryKey("unrelated", 0, "runtime_note"),
      "m-n",
    );
    expect(isToolResultOmissionNote(result, note)).toBe(false);
  });
});

describe("foldToolResultOmissionNotes", () => {
  it("folds four parallel tool-result omission siblings so results stay consecutive", () => {
    const entries: SessionThreadViewEntry[] = [
      { role: "user", content: "read the images", sourceMessages: [{ messageId: "m0", idempotencyKey: "k0" }] },
      {
        role: "assistant",
        content: [1, 2, 3, 4].map((n) => ({
          type: "toolCall" as const,
          toolCallId: `call_${n}`,
          toolName: "read",
          arguments: { path: `img${n}.png` },
        })),
        sourceMessages: [{ messageId: "m1", idempotencyKey: "k1" }],
      },
    ];
    for (const n of [1, 2, 3, 4]) {
      const entryId = `pi-tool-${n}`;
      entries.push(toolResult(`call_${n}`, `text ${n}`, entryKey(entryId, 0, "tool_result"), `m-tr-${n}`));
      entries.push(
        runtimeNoteUser(
          `unsupported content omitted: image part (image/png) #${n}`,
          entryKey(entryId, 1, "runtime_note"),
          `m-om-${n}`,
        ),
      );
    }

    const folded = foldToolResultOmissionNotes(entries);
    expect(rolesOf(folded)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "toolResult",
      "toolResult",
      "toolResult",
    ]);

    for (let n = 1; n <= 4; n += 1) {
      const result = folded[n + 1];
      expect(result).toMatchObject({ role: "toolResult", toolCallId: `call_${n}` });
      if (result === undefined || !("role" in result) || result.role !== "toolResult") return;
      expect(result.content).toContain(`text ${n}`);
      expect(result.content).toContain("[tool-result omission]");
      expect(result.content).toContain(`#${n}`);
      expect(result.sourceMessages).toHaveLength(2);
    }
  });

  it("folds multiple omission notes on one tool result in source order", () => {
    const entryId = "pi-multi";
    const entries: SessionThreadViewEntry[] = [
      toolResult("call_x", "partial", entryKey(entryId, 0, "tool_result")),
      runtimeNoteUser("omission A", entryKey(entryId, 1, "runtime_note"), "m-a"),
      runtimeNoteUser("omission B", entryKey(entryId, 2, "runtime_note"), "m-b"),
    ];

    const folded = foldToolResultOmissionNotes(entries);
    expect(rolesOf(folded)).toEqual(["toolResult"]);
    const result = folded[0];
    expect(result).toMatchObject({ role: "toolResult", toolCallId: "call_x" });
    if (result === undefined || !("role" in result) || result.role !== "toolResult") return;
    expect(result.content).toBe(
      ["partial", "[tool-result omission]\nomission A", "[tool-result omission]\nomission B"].join("\n\n"),
    );
    expect(result.sourceMessages.map((s) => s.messageId)).toEqual(["m-call_x", "m-a", "m-b"]);
  });

  it("leaves a structurally unassociated runtime note as an independent user entry", () => {
    const entries: SessionThreadViewEntry[] = [
      toolResult("call_1", "body", entryKey("e1", 0, "tool_result")),
      runtimeNoteUser(
        "<task-notification>task t-9 completed</task-notification>",
        entryKey("task-entry", 0, "runtime_note"),
        "m-task",
      ),
      toolResult("call_2", "body2", entryKey("e2", 0, "tool_result")),
    ];

    const folded = foldToolResultOmissionNotes(entries);
    expect(rolesOf(folded)).toEqual(["toolResult", "user", "toolResult"]);
    const note = folded[1];
    expect(note).toMatchObject({
      role: "user",
      content: "[runtime note] <task-notification>task t-9 completed</task-notification>",
    });
  });

  it("preserves adjacent unassociated notes while folding associated siblings", () => {
    const entries: SessionThreadViewEntry[] = [
      toolResult("call_1", "body", entryKey("e1", 0, "tool_result")),
      runtimeNoteUser("omission", entryKey("e1", 1, "runtime_note"), "m-om"),
      runtimeNoteUser("capture gap: batch rejected", entryKey("gap-1", 0, "runtime_note"), "m-gap"),
    ];

    const folded = foldToolResultOmissionNotes(entries);
    expect(rolesOf(folded)).toEqual(["toolResult", "user"]);
    const result = folded[0];
    if (result === undefined || !("role" in result) || result.role !== "toolResult") return;
    expect(result.content).toContain("[tool-result omission]\nomission");
    expect(folded[1]).toMatchObject({
      role: "user",
      content: "[runtime note] capture gap: batch rejected",
    });
  });
});
