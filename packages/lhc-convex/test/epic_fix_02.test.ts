// Epic 02 Fix Batch 001:
//   - EPIC-02-BLOCK-001: a manual instance never auto-drains — its queued work
//     waits for an explicit `work.drain`.
//   - EPIC-02-BLOCK-002: deleting a tool_result drops only its own
//     tool_result_summary; unrelated derivations stay byte-stable.
//   - FIX-2: consecutive tool activity groups into run parts in the turn
//     rendering, with mixed outcomes named explicitly.
//   - FIX-3.3: the claimed-straggler stale-discard leg is upstream-skipped and
//     stays skipped.
//
// Substrate-only / harness-limited frozen legs (documented):
//   - BLOCK-001's cross-instance positive control drives a live BACKGROUND SDK
//     to prove its scheduler is not merely inert. On Convex, scheduler mode is
//     per-instance stored config (not a process-global poke/touch seam), so a
//     manual instance CANNOT be contaminated by a background one; and a
//     background scheduled drain cannot be advanced under convex-test, so the
//     background half is not driven here. The manual-never-auto-drains
//     invariant (the actual regression) is ported.
//   - FIX-3.3 uses an in-flight `delayKind` claim window with a mid-handler
//     delete; convex-test exposes no such in-flight seam. It is upstream
//     `it.skip` and remains skipped.
import { describe, expect, test } from "vitest";
import type { Lhc, MessageEventInput } from "../src/client/index.js";
import { type ServiceFixture, serviceFixture, validEvent } from "./fixtures/index.js";

async function readForms(fixture: ServiceFixture, thread: string): Promise<Array<Record<string, unknown>>> {
  return await fixture.test.run(async (ctx) => {
    const rows = await ctx.db.query("derivations").collect();
    return rows
      .filter((row) => row.instance === fixture.instance && row.thread === thread)
      .map(({ _id, _creationTime, ...rest }) => rest as Record<string, unknown>);
  });
}

async function liveCount(fixture: ServiceFixture, thread: string): Promise<number> {
  return await fixture.test.run(async (ctx) => {
    const rows = await ctx.db.query("workItems").collect();
    return rows.filter((row) => row.instance === fixture.instance && row.thread === thread && row.status !== "done")
      .length;
  });
}

function formKey(entry: Record<string, unknown>): string {
  return `${String(entry["subjectKind"])}/${String(entry["subjectId"])}/${String(entry["derivationType"])}`;
}

async function send(sdk: Lhc, filePath: string, batch: readonly MessageEventInput[]): Promise<void> {
  const result = await sdk.intakeStream.messageEvents({ filePath }, batch);
  if (!result.ok) throw new Error(`batch failed: ${result.error.reason}`);
}

describe("EPIC-02-BLOCK-001: a manual instance never auto-drains", () => {
  test("queued work stays pending until an explicit drain runs it", async () => {
    const manual = serviceFixture({ mode: "manual" });
    const { filePath, threadId } = await manual.createThread();

    const queued = await manual.sdk.intakeStream.messageEvents({ filePath }, [validEvent("user_prompt")]);
    expect(queued.ok).toBe(true);

    // No drain was scheduled and the work is still queued.
    const status = await manual.sdk.work.status({ filePath });
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.value.queued).toBe(1);
    expect(status.value.drainScheduled).toBe(false);
    expect((await readForms(manual, threadId)).map((form) => form["state"])).toEqual(["pending"]);
    expect(await liveCount(manual, threadId)).toBe(1);

    // A second background instance on a different instance id cannot touch this
    // one (isolation is per componentInstanceId, not a process-global seam).
    const background = serviceFixture({ mode: "background" });
    expect(background.sdk.scheduler.mode).toBe("background");
    expect(await liveCount(manual, threadId)).toBe(1);

    // The explicit drain finally runs the manual instance's accumulated work.
    const report = await manual.sdk.work.drain({ filePath });
    expect(report.ok).toBe(true);
    expect(await liveCount(manual, threadId)).toBe(0);
    expect((await readForms(manual, threadId)).map((form) => form["state"])).toEqual(["ready"]);
  });
});

describe("EPIC-02-BLOCK-002: the call/result pair is a source dependency", () => {
  async function toolRunThread(fixture: ServiceFixture): Promise<{ filePath: string; threadId: string }> {
    const { filePath, threadId } = await fixture.createThread();
    await send(fixture.sdk, filePath, [
      validEvent("user_prompt"),
      validEvent("tool_call"),
      validEvent("tool_result"),
      validEvent("assistant_text"),
      validEvent("turn_end"),
    ]);
    const drained = await fixture.sdk.work.drain({ filePath });
    expect(drained.ok).toBe(true);
    return { filePath, threadId };
  }

  test("deleting a tool_result drops only its tool-result summary", async () => {
    const fixture = serviceFixture({ guards: { detailedTurnCompression: { tinyTurnTokens: 1 } } });
    const { filePath, threadId } = await toolRunThread(fixture);

    const before = await readForms(fixture, threadId);
    const resultBefore = before.find((f) => f["subject"] === "m3" && f["deriv"] === "tool_result_summary");
    expect(resultBefore?.["state"]).toBe("ready");
    const promptBefore = before.find((f) => f["subject"] === "m1" && f["deriv"] === "smoothed_prompt");

    const result = await fixture.sdk.messages.remove({ filePath }, { messageId: "m3" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.dropped.map(formKey)).toEqual(["message/m3/tool_result_summary"]);

    const rebuild = await fixture.sdk.work.drain({ filePath });
    expect(rebuild.ok).toBe(true);
    const after = await readForms(fixture, threadId);

    // The unrelated prompt smoothing is byte-stable.
    const promptAfter = after.find((f) => f["subject"] === "m1" && f["deriv"] === "smoothed_prompt");
    expect(promptAfter).toEqual(promptBefore);
    expect(await liveCount(fixture, threadId)).toBe(0);
  });
});

describe("FIX-2: consecutive tool activity groups into run parts", () => {
  async function turnRendering(fixture: ServiceFixture, thread: string): Promise<Record<string, unknown> | undefined> {
    const forms = await readForms(fixture, thread);
    return forms.find((f) => f["subject"] === "t1" && f["deriv"] === "turn_rendering");
  }

  test("prompt, call, result, call, result, text, call, result → exactly two run parts (sizes 2 and 1)", async () => {
    const fixture = serviceFixture();
    const { filePath, threadId } = await fixture.createThread();
    const call = (id: string) =>
      validEvent("tool_call", { payload: { toolCallId: id, toolName: "run_cmd", arguments: { id } } });
    const toolResult = (id: string) =>
      validEvent("tool_result", { payload: { toolCallId: id, content: `out ${id}`, isError: false } });

    await send(fixture.sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "do work" } }),
      call("a"),
      toolResult("a"),
      call("b"),
      toolResult("b"),
      validEvent("assistant_text", { payload: { text: "mid-turn note" } }),
      call("c"),
      toolResult("c"),
      validEvent("turn_end"),
    ]);
    expect((await fixture.sdk.work.drain({ filePath })).ok).toBe(true);

    const rendering = await turnRendering(fixture, threadId);
    const runText = String(rendering?.["content"] ?? "");
    const runHeaders = [...runText.matchAll(/\[tool run · [^\]]+\]/g)].map((match) => match[0]);
    expect(runHeaders).toHaveLength(2);
    expect(runHeaders[0]).toContain("2 calls");
    expect(runHeaders[1]).toContain("1 call");
    expect(rendering?.["metadata"]).toBeUndefined();
  });

  test("a mixed-outcome run stays explicit and names the failure", async () => {
    const fixture = serviceFixture();
    const { filePath, threadId } = await fixture.createThread();
    await send(fixture.sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "edit two" } }),
      validEvent("tool_call", { payload: { toolCallId: "ok", toolName: "edit_file", arguments: { path: "ok.txt" } } }),
      validEvent("tool_result", { payload: { toolCallId: "ok", content: "edited ok.txt", isError: false } }),
      validEvent("tool_call", { payload: { toolCallId: "bad", toolName: "edit_file", arguments: { path: "ro.txt" } } }),
      validEvent("tool_result", { payload: { toolCallId: "bad", content: "permission denied", isError: true } }),
      validEvent("turn_end"),
    ]);
    expect((await fixture.sdk.work.drain({ filePath })).ok).toBe(true);

    const rendering = await turnRendering(fixture, threadId);
    const runText = String(rendering?.["content"] ?? "");
    expect(runText).toContain("[tool run · edit_file · 2 calls · 1 succeeded, 1 failed]");
    expect(rendering?.["metadata"]).toBeUndefined();
  });
});

describe("FIX-3.3: a claimed summary for a deleted message discards on completion", () => {
  test.skip("completing the straggler after the delete discards as stale_discarded (in-flight claim seam is substrate)", () => {});
});
