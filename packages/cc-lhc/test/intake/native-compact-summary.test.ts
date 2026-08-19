/**
 * Native Claude compact summary → one bounded closed turn (LIM-95, R8).
 *
 * These are outcome tests: the mapping is driven through the real LHC intake
 * surface so the SDK turn state machine — not a local expectation — decides
 * what "settle the open turn first" and "one complete turn" actually produce.
 */
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDeterministicInferenceCallbacks, initLhc, type Lhc, type MessageEventInput, type ThreadRef } from "lhc";
import { beforeEach, describe, expect, it } from "vitest";

import { mapRolloutLine, nativeCompactSummaryContent } from "../../src/intake/map.js";
import type { RolloutLineItem } from "../../src/rollout/types.js";

const TAG_OPEN = "<claude-compact-summary>";
const TAG_CLOSE = "</claude-compact-summary>";
const TRUNCATION_MARKER = "[... remainder of summary truncated]";

function summaryLine(summary: string, leafUuid = "leaf-1"): RolloutLineItem {
  return { type: "summary", summary, leafUuid, sessionId: "s" };
}

/**
 * Verbatim structural copy of the two records Claude Code 2.1.235 wrote for a
 * native `/compact` during LIM-99 canary (d): session
 * 77658af3-c016-4acf-886f-2bb27498886e, lines 21-22 of the retained exhibit
 * rollout. Only absolute home paths inside strings were sanitized
 * (/home/leemoore -> /home/operator, same length); every structural field is
 * unchanged. See lim99-s7-certification-evidence.md for the original receipt.
 */
const FIXTURE_LINES: RolloutLineItem[] = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../fixtures/native-compact-2.1.235.jsonl"),
  "utf8",
)
  .trimEnd()
  .split("\n")
  .map((line) => JSON.parse(line) as RolloutLineItem);

const BOUNDARY_RECORD = FIXTURE_LINES[0]!;
const INSTALLED_SUMMARY = FIXTURE_LINES[1]!;
const INSTALLED_SUMMARY_TEXT = INSTALLED_SUMMARY.message!.content as string;

function textOf(blocks: Array<{ content: Record<string, unknown> }>): string {
  return blocks.map((block) => (typeof block.content.text === "string" ? block.content.text : "")).join("");
}

describe("native compact summary content", () => {
  it("wraps the summary in a detectable tag", () => {
    const content = nativeCompactSummaryContent("all done");
    expect(content.startsWith(TAG_OPEN)).toBe(true);
    expect(content.endsWith(TAG_CLOSE)).toBe(true);
    expect(content).toContain("all done");
  });

  it("leaves a short summary whole, with no truncation marker", () => {
    expect(nativeCompactSummaryContent("short")).not.toContain(TRUNCATION_MARKER);
  });

  it("bounds a long summary at ~2,000 characters and marks the remainder truncated", () => {
    const content = nativeCompactSummaryContent("x".repeat(5_000));
    expect(content).toContain(TRUNCATION_MARKER);
    const body = content.slice(TAG_OPEN.length + 1, content.indexOf(`\n${TRUNCATION_MARKER}`));
    expect(body).toHaveLength(2_000);
  });

  it("truncates on whole characters, never splitting a multi-byte character", () => {
    // Astral plane: each character is two UTF-16 code units.
    const content = nativeCompactSummaryContent("𝄞".repeat(3_000));
    const body = content.slice(TAG_OPEN.length + 1, content.indexOf(`\n${TRUNCATION_MARKER}`));
    expect([...body]).toHaveLength(2_000);
    expect(body).toBe("𝄞".repeat(2_000));
    // No lone surrogate survived the cut.
    expect(Buffer.from(body, "utf8").toString("utf8")).toBe(body);
  });
});

describe("native compact summary mapping", () => {
  it("maps one summary record to exactly one tagged prompt plus one turn close", () => {
    const mapped = mapRolloutLine(summaryLine("compacted the session"));
    expect(mapped.events.map((e) => e.eventKind)).toEqual(["user_prompt", "turn_end"]);
    expect(mapped.stats.meta).toBe(0);
    const prompt = mapped.events[0] as Extract<MessageEventInput, { eventKind: "user_prompt" }>;
    expect(prompt.payload.text).toContain(TAG_OPEN);
    expect(prompt.payload.text).toContain("compacted the session");
  });

  it("keeps file-history-snapshot and other housekeeping records as meta", () => {
    const snapshot = mapRolloutLine({ type: "file-history-snapshot", messageId: "m" } as RolloutLineItem);
    expect(snapshot.events).toHaveLength(0);
    expect(snapshot.stats.meta).toBe(1);
  });
});

describe("installed Claude Code 2.1.235 native compact shape", () => {
  it("is the shape the retained canary (d) exhibit actually contains", () => {
    // Guards the fixture itself: if this drifts, the discriminator below is
    // being proven against something other than the live record.
    expect(BOUNDARY_RECORD.type).toBe("system");
    expect(BOUNDARY_RECORD.subtype).toBe("compact_boundary");
    expect(INSTALLED_SUMMARY.type).toBe("user");
    expect(INSTALLED_SUMMARY.isCompactSummary).toBe(true);
    expect(INSTALLED_SUMMARY.message?.role).toBe("user");
    expect(typeof INSTALLED_SUMMARY_TEXT).toBe("string");
    expect(INSTALLED_SUMMARY_TEXT.length).toBeGreaterThan(2_000);
    expect(INSTALLED_SUMMARY.version).toBe("2.1.235");
  });

  it("maps to exactly one tagged prompt plus one turn close — no ordinary user_prompt", () => {
    const mapped = mapRolloutLine(INSTALLED_SUMMARY);
    expect(mapped.events.map((e) => e.eventKind)).toEqual(["user_prompt", "turn_end"]);
    const prompt = mapped.events[0] as Extract<MessageEventInput, { eventKind: "user_prompt" }>;
    expect(prompt.payload.text.startsWith(TAG_OPEN)).toBe(true);
    expect(prompt.payload.text).toContain(TRUNCATION_MARKER);
    // The raw summary must not also appear as an untagged ordinary prompt.
    expect(prompt.payload.text).not.toBe(INSTALLED_SUMMARY_TEXT);
    expect(mapped.stats.meta).toBe(0);
  });

  it("leaves the adjacent compact_boundary record as harness metadata", () => {
    // No pairing state, no adjacency inference: the boundary carries no
    // conversation content and stays exactly what current mapping made it.
    const mapped = mapRolloutLine(BOUNDARY_RECORD);
    expect(mapped.events).toHaveLength(0);
    expect(mapped.stats.meta).toBe(1);
  });

  it('keeps the legacy type:"summary" shape recognized for compatibility', () => {
    const mapped = mapRolloutLine(summaryLine("legacy compacted"));
    expect(mapped.events.map((e) => e.eventKind)).toEqual(["user_prompt", "turn_end"]);
  });
});

describe("records that only resemble a native compact summary", () => {
  const notSummaries: Array<[string, RolloutLineItem]> = [
    ["ordinary user prompt", { type: "user", uuid: "u1", message: { role: "user", content: "hello" } }],
    [
      "ordinary user prompt that mentions the flag in its text",
      { type: "user", uuid: "u2", message: { role: "user", content: "isCompactSummary:true" } },
    ],
    ["boundary record alone", BOUNDARY_RECORD],
    [
      "isCompactSummary on an assistant record",
      {
        type: "assistant",
        uuid: "a1",
        isCompactSummary: true,
        message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "hi" }] },
      },
    ],
    [
      "isCompactSummary with block-array content",
      {
        type: "user",
        uuid: "u3",
        isCompactSummary: true,
        message: { role: "user", content: [{ type: "text", text: "not a string" }] },
      },
    ],
    [
      "isCompactSummary with a non-user message role",
      { type: "user", uuid: "u4", isCompactSummary: true, message: { role: "assistant", content: "x" } },
    ],
    [
      "isCompactSummary that is not exactly true",
      { type: "user", uuid: "u5", isCompactSummary: "true", message: { role: "user", content: "x" } },
    ],
    ["isCompactSummary with no message at all", { type: "user", uuid: "u6", isCompactSummary: true }],
  ];

  for (const [label, item] of notSummaries) {
    it(`does not summary-map: ${label}`, () => {
      const mapped = mapRolloutLine(item);
      const texts = mapped.events
        .filter((e) => e.eventKind === "user_prompt")
        .map((e) => (e.payload as { text: string }).text);
      expect(texts.some((t) => t.includes(TAG_OPEN))).toBe(false);
      expect(mapped.events.some((e) => e.eventKind === "turn_end")).toBe(false);
    });
  }
});

describe("native compact summary intake", () => {
  let sdk: Lhc;
  let threadRef: ThreadRef;

  beforeEach(async () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-lim95-"));
    mkdirSync(join(root, "threads"), { recursive: true });
    const filePath = join(root, "threads", "t.sqlite");
    sdk = initLhc({ mode: "manual", inferenceCallbacks: createDeterministicInferenceCallbacks() });
    const created = await sdk.threads.newThread({
      filePath,
      registryPath: join(root, "registry.sqlite"),
    });
    if (!created.ok) throw new Error(created.error.reason);
    threadRef = { filePath };
  });

  /** One batch per call, as capture submits a watcher emission (zero-event lines contribute nothing). */
  async function intake(...items: RolloutLineItem[]): Promise<void> {
    const events = items.flatMap((item, index) => mapRolloutLine(item, index).events);
    if (events.length === 0) return;
    const result = await sdk.intakeStream.messageEvents(threadRef, events);
    if (!result.ok) throw new Error(result.error.reason);
  }

  async function closedTurns() {
    const turns = await sdk.turns.listTurns(threadRef);
    if (!turns.ok) throw new Error(turns.error.reason);
    return turns.value.filter((turn) => turn.status === "closed");
  }

  it("lands as one closed turn holding one tagged user message and no response", async () => {
    await intake(summaryLine("session compacted natively"));

    const closed = await closedTurns();
    expect(closed).toHaveLength(1);
    expect(closed[0]!.memberMessageIds).toHaveLength(1);
    expect(closed[0]!.outcomeReason).toBe("claude_native_compact_summary");

    const messages = await sdk.messages.list(threadRef);
    if (!messages.ok) throw new Error(messages.error.reason);
    expect(messages.value.map((m) => m.kind)).toEqual(["user_prompt"]);
    expect(textOf(messages.value[0]!.blocks)).toContain("session compacted natively");
  });

  it("settles an open turn first, then lands the summary as its own complete turn", async () => {
    await intake({ type: "user", uuid: "u1", message: { role: "user", content: "do the thing" } });
    await intake({
      type: "assistant",
      uuid: "a1",
      message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "did it" }] },
    });

    // The work turn is still open here: nothing has closed it yet.
    const beforeSummary = await closedTurns();
    expect(beforeSummary).toHaveLength(0);

    await intake(summaryLine("session compacted natively"));

    const closed = await closedTurns();
    expect(closed).toHaveLength(2);
    // The prior turn settled with its own members; the summary is not inside it.
    expect(closed[0]!.memberMessageIds).toHaveLength(2);
    expect(closed[1]!.memberMessageIds).toHaveLength(1);

    const messages = await sdk.messages.list(threadRef);
    if (!messages.ok) throw new Error(messages.error.reason);
    const summaryMessage = messages.value.find((m) => textOf(m.blocks).includes(TAG_OPEN));
    expect(summaryMessage?.kind).toBe("user_prompt");
    expect(summaryMessage?.turnId).toBe(closed[1]!.turnId);
  });

  it("lands the installed 2.1.235 shape as one bounded tagged closed turn", async () => {
    // Drives the exact retained canary (d) records, boundary first, in order,
    // in one batch — the shape capture actually submits.
    await intake(BOUNDARY_RECORD, INSTALLED_SUMMARY);

    const closed = await closedTurns();
    expect(closed).toHaveLength(1);
    expect(closed[0]!.memberMessageIds).toHaveLength(1);
    expect(closed[0]!.outcomeReason).toBe("claude_native_compact_summary");

    const messages = await sdk.messages.list(threadRef);
    if (!messages.ok) throw new Error(messages.error.reason);
    // Exactly one message: the boundary contributed none, and the summary did
    // not additionally land as an ordinary user prompt.
    expect(messages.value).toHaveLength(1);
    expect(messages.value[0]!.kind).toBe("user_prompt");

    const stored = textOf(messages.value[0]!.blocks);
    expect(stored.startsWith(TAG_OPEN)).toBe(true);
    expect(stored.endsWith(TAG_CLOSE)).toBe(true);
    expect(stored).toContain(TRUNCATION_MARKER);
    expect(stored).toContain("This session is being continued");
    // Unicode-safe 2,000 code points of summary, plus tag and marker lines.
    const body = stored.slice(TAG_OPEN.length + 1, stored.indexOf(`\n${TRUNCATION_MARKER}`));
    expect([...body]).toHaveLength(2_000);
    expect(body).toBe([...INSTALLED_SUMMARY_TEXT].slice(0, 2_000).join(""));
  });

  it("bounds the installed shape on whole characters when the summary is astral", async () => {
    const astral: RolloutLineItem = {
      ...INSTALLED_SUMMARY,
      uuid: "astral-summary",
      message: { role: "user", content: "𝄞".repeat(3_000) },
    };
    await intake(astral);

    const messages = await sdk.messages.list(threadRef);
    if (!messages.ok) throw new Error(messages.error.reason);
    const stored = textOf(messages.value[0]!.blocks);
    const body = stored.slice(TAG_OPEN.length + 1, stored.indexOf(`\n${TRUNCATION_MARKER}`));
    expect([...body]).toHaveLength(2_000);
    expect(body).toBe("𝄞".repeat(2_000));
    expect(Buffer.from(body, "utf8").toString("utf8")).toBe(body);
  });

  it("bounds an oversized summary in the record it stores", async () => {
    await intake(summaryLine("y".repeat(10_000)));

    const messages = await sdk.messages.list(threadRef);
    if (!messages.ok) throw new Error(messages.error.reason);
    const stored = textOf(messages.value[0]!.blocks);
    expect(stored).toContain(TRUNCATION_MARKER);
    expect(stored.length).toBeLessThan(2_200);
  });
});
