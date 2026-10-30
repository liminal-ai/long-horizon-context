import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const home = mkdtempSync(join(tmpdir(), "claude-lhc-segment-"));
process.env.CLAUDE_LHC_NO_INFERENCE = "1";
const { createLhc, createThread, threadRef } = await import("../src/lhcHome.ts");
const { segmentEndEvent } = await import("../src/capture/segment-fold.ts");
const { HARNESS } = await import("../src/capture/mapper.ts");

describe("segment end against core", () => {
  test("closes the canonical turn at the boundary; an immediate compact-style end on the fresh turn is a no-op", async () => {
    const lhc = createLhc({ claudeBin: "claude", env: process.env, tokenFamily: "claude-2026" });
    try {
      const threadId = await createThread(home, home);
      const thread = threadRef(threadId, home);
      const ok = async (events: Parameters<typeof lhc.intakeStream.messageEvents>[1]) => {
        const r = await lhc.intakeStream.messageEvents(thread, events);
        if (!r.ok) throw new Error(`${r.error.code}: ${r.error.reason}`);
        return r.value;
      };
      await ok([
        { eventKind: "user_prompt", idempotencyKey: "p1", actor: "user", harness: HARNESS, payload: { text: "go" } },
        {
          eventKind: "tool_call",
          idempotencyKey: "c1",
          actor: "assistant",
          harness: HARNESS,
          payload: { toolCallId: "toolu_1", toolName: "Read", arguments: {} },
        },
        {
          eventKind: "tool_result",
          idempotencyKey: "r1",
          actor: "tool",
          harness: HARNESS,
          payload: { toolCallId: "toolu_1", content: "x".repeat(400), isError: false },
        },
      ]);
      const before = await lhc.threadView.hostMetadata(thread);
      if (!before.ok) throw new Error(before.error.reason);
      expect(before.value.activeTurn?.estimatedTokens ?? 0).toBeGreaterThan(0);

      await ok([segmentEndEvent("wire-1", undefined)]);
      let turns = await lhc.turns.listTurns(thread);
      if (!turns.ok) throw new Error(turns.error.reason);
      expect(turns.value.map((t) => t.status)).toEqual(["closed", "open"]);
      expect(turns.value[0]!.memberMessageIds).toHaveLength(3);
      const after = await lhc.threadView.hostMetadata(thread);
      if (!after.ok) throw new Error(after.error.reason);
      expect(after.value.activeTurn === null ? 0 : after.value.activeTurn.estimatedTokens).toBe(0);

      const openId = turns.value[1]!.turnId;
      await ok([
        {
          eventKind: "turn_end",
          idempotencyKey: `claude-lhc:midturn:${openId}:turn_end`,
          actor: "system",
          harness: HARNESS,
          payload: { outcomeReason: "context compact, continuing", endedAt: new Date().toISOString() },
        },
      ]);
      turns = await lhc.turns.listTurns(thread);
      if (!turns.ok) throw new Error(turns.error.reason);
      expect(turns.value.map((t) => t.status)).toEqual(["closed", "open"]);
      expect(turns.value[1]!.turnId).toBe(openId);

      await ok([
        {
          eventKind: "tool_call",
          idempotencyKey: "c2",
          actor: "assistant",
          harness: HARNESS,
          payload: { toolCallId: "toolu_2", toolName: "Read", arguments: {} },
        },
      ]);
      await ok([segmentEndEvent("wire-1", undefined)]);
      turns = await lhc.turns.listTurns(thread);
      if (!turns.ok) throw new Error(turns.error.reason);
      expect(turns.value.map((t) => t.status)).toEqual(["closed", "open"]);
    } finally {
      await (lhc as unknown as { close?: () => Promise<void> }).close?.();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
