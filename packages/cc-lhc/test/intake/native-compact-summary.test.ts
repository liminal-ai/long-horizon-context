/**
 * Native Claude compact summary → one bounded closed turn (LIM-95, R8).
 *
 * These are outcome tests: the mapping is driven through the real LHC intake
 * surface so the SDK turn state machine — not a local expectation — decides
 * what "settle the open turn first" and "one complete turn" actually produce.
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  async function intake(item: RolloutLineItem): Promise<void> {
    const result = await sdk.intakeStream.messageEvents(threadRef, mapRolloutLine(item).events);
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

  it("bounds an oversized summary in the record it stores", async () => {
    await intake(summaryLine("y".repeat(10_000)));

    const messages = await sdk.messages.list(threadRef);
    if (!messages.ok) throw new Error(messages.error.reason);
    const stored = textOf(messages.value[0]!.blocks);
    expect(stored).toContain(TRUNCATION_MARKER);
    expect(stored.length).toBeLessThan(2_200);
  });
});
