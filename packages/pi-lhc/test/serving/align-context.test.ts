// TC-7.2c — tail-cut alignment (the pinned proof, epic Flow 7). The seam:
// Pi entry id of the first kept message → index in the `context` event's
// message list. Shapes: bash-execution and custom messages, a prior Pi
// compaction summary, parallel tool results in flight with equal
// timestamps, an entry Pi did not materialize, ambiguity, and a target Pi
// has already compacted past. Every failure serves raw, never misaligned.
import { describe, expect, it } from "vitest";
import type { AgentMessage, SessionEntry } from "../../src/pi/types.js";
import { alignTailStart } from "../../src/serving/align-context.js";

let clock = 1_700_000_000_000;
const tick = (): number => (clock += 1000);

function user(text: string, timestamp = tick()): AgentMessage {
  return { role: "user", content: text, timestamp } as AgentMessage;
}
function assistant(text: string, calls: string[] = [], timestamp = tick()): AgentMessage {
  return {
    role: "assistant",
    content: [
      { type: "text", text },
      ...calls.map((id) => ({ type: "toolCall" as const, id, name: "read", arguments: {} })),
    ],
    timestamp,
  } as unknown as AgentMessage;
}
function toolResult(toolCallId: string, timestamp = tick()): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content: [{ type: "text", text: `result ${toolCallId}` }],
    isError: false,
    timestamp,
  } as unknown as AgentMessage;
}
function bash(command: string, excludeFromContext = false, timestamp = tick()): AgentMessage {
  return {
    role: "bashExecution",
    command,
    output: "ok",
    exitCode: 0,
    cancelled: false,
    truncated: false,
    excludeFromContext,
    timestamp,
  } as unknown as AgentMessage;
}
function custom(text: string, timestamp = tick()): AgentMessage {
  return { role: "custom", customType: "ext", content: text, display: true, timestamp } as unknown as AgentMessage;
}

let seq = 0;
function entry(message: AgentMessage): SessionEntry {
  seq += 1;
  return { type: "message", id: `e${seq}`, parentId: null, message };
}
function customMessageEntry(text: string): { entry: SessionEntry; message: AgentMessage } {
  seq += 1;
  const timestamp = tick();
  return {
    entry: {
      type: "custom_message",
      id: `e${seq}`,
      parentId: null,
      customType: "ext",
      content: text,
      display: true,
      timestamp: new Date(timestamp).toISOString(),
    },
    message: custom(text, timestamp),
  };
}
function nonMessageEntry(type: string): SessionEntry {
  seq += 1;
  return { type, id: `e${seq}`, parentId: null };
}
function compactionEntry(timestamp: number): { entry: SessionEntry; message: AgentMessage } {
  seq += 1;
  return {
    entry: {
      type: "compaction",
      id: `e${seq}`,
      parentId: null,
      summary: "older history",
      firstKeptEntryId: "e1",
      tokensBefore: 1000,
      timestamp: new Date(timestamp).toISOString(),
    },
    message: {
      role: "compactionSummary",
      summary: "older history",
      tokensBefore: 1000,
      timestamp,
    } as unknown as AgentMessage,
  };
}

/** Pi's list is the entries' messages in order; `custom_message` and
 *  `compaction` entries materialize their own message objects. */
function listOf(entries: readonly SessionEntry[], materialized: Map<string, AgentMessage>): AgentMessage[] {
  const list: AgentMessage[] = [];
  for (const e of entries) {
    if (e.type === "message" && e.message !== undefined) list.push(e.message);
    else if (materialized.has(e.id as string)) list.push(materialized.get(e.id as string) as AgentMessage);
  }
  return list;
}

describe("TC-7.2c: tail-cut alignment", () => {
  it("counts through bash-execution (kept and !!-excluded), custom, and non-message entries to the first message of step k+1, verified at both ends", () => {
    const stepEdge = tick();
    const injected = customMessageEntry("injected");
    const entries: SessionEntry[] = [
      entry(user("task")),
      entry(assistant("step 0", ["c0"])),
      entry(bash("ls")),
      entry(toolResult("c0")),
      nonMessageEntry("model_change"),
      injected.entry,
      entry(bash("secret", true)),
      entry(assistant("step 1", ["c1"], stepEdge)), // first message of step k+1
      entry(toolResult("c1")),
      nonMessageEntry("custom"),
      entry(assistant("step 2")),
    ];
    const list = listOf(entries, new Map([[injected.entry.id as string, injected.message]]));

    const aligned = alignTailStart({
      firstKeptEntryId: entries[7]!.id as string,
      contextEntries: entries,
      messages: list,
    });
    expect(aligned).toEqual({ ok: true, index: 6, via: "count" });
    expect(list.slice(6).map((m) => m.role)).toEqual(["assistant", "toolResult", "assistant"]);
    expect((list[6] as { timestamp: number }).timestamp).toBe(stepEdge);
  });

  it("drops a prior Pi compaction summary before the cut and keeps parallel tool results with equal timestamps intact", () => {
    const summaryAt = tick();
    const compaction = compactionEntry(summaryAt);
    const sameMs = tick();
    const edge = tick();
    const entries: SessionEntry[] = [
      compaction.entry,
      entry(user("kept prompt")),
      entry(assistant("step k", ["a", "b"])),
      entry(toolResult("a", sameMs)),
      entry(toolResult("b", sameMs)),
      entry(assistant("step k+1", ["c"], edge)),
      entry(toolResult("c")),
    ];
    const list = listOf(entries, new Map([[compaction.entry.id as string, compaction.message]]));
    expect(list[0]!.role).toBe("compactionSummary");
    const aligned = alignTailStart({
      firstKeptEntryId: entries[5]!.id as string,
      contextEntries: entries,
      messages: list,
    });
    expect(aligned).toEqual({ ok: true, index: 5, via: "count" });
    // The cut sits after both results of step k: the pair never splits.
    expect(list.slice(0, 5).filter((m) => m.role === "toolResult")).toHaveLength(2);
    expect(list.slice(5)[0]).toBe(entries[5]!.message);
    // A cut at a tool result itself is still exact under equal timestamps: toolCallId disambiguates.
    const atB = alignTailStart({ firstKeptEntryId: entries[4]!.id as string, contextEntries: entries, messages: list });
    expect(atB).toEqual({ ok: true, index: 4, via: "count" });
  });

  it("falls back to a unique identity match when Pi's list and its entries disagree in count, and refuses ambiguity", () => {
    const edge = tick();
    const entries: SessionEntry[] = [
      entry(user("task")),
      entry(assistant("step 0")),
      entry(assistant("step 1", [], edge)),
      entry(assistant("step 2")),
    ];
    // Pi's list carries one message with no entry (count disagrees).
    const stray = user("ghost");
    const list = [entries[0]!.message!, stray, entries[1]!.message!, entries[2]!.message!, entries[3]!.message!];
    expect(alignTailStart({ firstKeptEntryId: "e" + (seq - 1), contextEntries: entries, messages: list })).toEqual({
      ok: true,
      index: 3,
      via: "identity",
    });
    // Two messages share the target's role and timestamp: refused, never guessed.
    const twin = assistant("twin", [], edge);
    expect(
      alignTailStart({ firstKeptEntryId: "e" + (seq - 1), contextEntries: entries, messages: [...list, twin] }),
    ).toMatchObject({ ok: false });
  });

  it("refuses when the first kept entry is not among Pi's context entries (Pi compacted past it) or matches nothing", () => {
    const entries: SessionEntry[] = [entry(user("task")), entry(assistant("step 0")), entry(assistant("step 1"))];
    const list = listOf(entries, new Map());
    expect(alignTailStart({ firstKeptEntryId: "missing", contextEntries: entries, messages: list })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("not in Pi's context entries"),
    });
    const drifted = list.map((m) => ({ ...(m as object), timestamp: 1 }) as AgentMessage);
    expect(
      alignTailStart({ firstKeptEntryId: entries[2]!.id as string, contextEntries: entries, messages: drifted }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining("no message matches"),
    });
  });
});
