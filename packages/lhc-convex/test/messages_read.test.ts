// Story 1 (Epic 04): TC-3.1-3.3 — the message read surface. Bounded listing
// in source-event-order coordinates (DD-3), show returning the canonical
// record (full blocks, never view-shortened) composed with the owner report's
// form entries (DD-2), and the deleted-audit contract (excluded by default,
// listable flagged on request, show never not-found). Plus the
// architecture-risk legs: every read leaves observable state unchanged
// (read-only delta, DD-6) and calls no model.
import { describe, expect, test } from "vitest";
import type { Lhc, MessageEventInput } from "../src/client/index.js";
import { capturedCalls, resetCapturedCalls } from "./convex/model.js";
import { type ServiceFixture, serviceFixture, validEvent } from "./fixtures/index.js";

// Long enough that any view-form shortening would be visible: show must
// return this verbatim (AC-3.2's record-not-view contract).
const TOOL_RESULT_CONTENT = [
  "contents of notes.txt — full record content:",
  "line 1: the quick brown fox jumps over the lazy dog",
  "line 2: detailed tool output that a boundary-shortened form would drop",
  "line 3: trailing detail proving the record came back complete",
].join("\n");

interface ReadFixture extends ServiceFixture {
  filePath: string;
  threadId: string;
}

async function send(sdk: Lhc, filePath: string, batch: readonly MessageEventInput[]): Promise<void> {
  const sent = await sdk.intakeStream.messageEvents({ filePath }, batch);
  if (!sent.ok) throw new Error(`fixture batch failed: ${sent.error.reason}`);
}

// Two closed turns through real intake, fully drained so m1's smoothing and
// m3/m4's tool summaries sit ready with mechanically stamped outcome metadata.
// Messages: m1 prompt, m2 text, m3 call, m4 result (turn 1; turn_end is event
// 5, no message); m6 prompt, m7 text (turn 2). Source event orders 1,2,3,4,6,7.
async function readFixture(): Promise<ReadFixture> {
  const fixture = serviceFixture();
  const { filePath, threadId } = await fixture.createThread();
  await send(fixture.sdk, filePath, [
    validEvent("user_prompt", { payload: { text: "please read notes.txt" } }),
    validEvent("assistant_text", { payload: { text: "reading it now" } }),
    validEvent("tool_call", {
      payload: { toolCallId: "call-read-1", toolName: "read_file", arguments: { path: "notes.txt" } },
    }),
    validEvent("tool_result", { payload: { toolCallId: "call-read-1", content: TOOL_RESULT_CONTENT, isError: false } }),
    validEvent("turn_end"),
  ]);
  await send(fixture.sdk, filePath, [
    validEvent("user_prompt", { payload: { text: "summarize what you read" } }),
    validEvent("assistant_text", { payload: { text: "here is the summary" } }),
    validEvent("turn_end"),
  ]);
  const drained = await fixture.sdk.work.drain({ filePath });
  if (!drained.ok) throw new Error(`fixture drain failed: ${drained.error.reason}`);
  if (drained.value.remaining !== 0) throw new Error(`fixture drain left ${drained.value.remaining} items behind`);
  return { ...fixture, filePath, threadId };
}

function idsOf(result: { ok: boolean }): string[] {
  if (!result.ok) throw new Error("expected an ok list result");
  return (result as { ok: true; value: Array<{ messageId: string }> }).value.map((record) => record.messageId);
}

async function liveWork(fixture: ServiceFixture, thread: string): Promise<unknown[]> {
  return await fixture.test.run(async (ctx) => {
    const rows = await ctx.db.query("workItems").collect();
    return rows
      .filter((row) => row.instance === fixture.instance && row.thread === thread)
      .map(({ _id, _creationTime, ...rest }) => rest)
      .sort((a, b) => a.seq - b.seq);
  });
}

async function derivedForms(fixture: ServiceFixture, thread: string): Promise<unknown[]> {
  return await fixture.test.run(async (ctx) => {
    const rows = await ctx.db.query("derivations").collect();
    return rows
      .filter((row) => row.instance === fixture.instance && row.thread === thread)
      .map(({ _id, _creationTime, ...rest }) => rest)
      .sort((a, b) => `${a.scope}/${a.subject}/${a.deriv}`.localeCompare(`${b.scope}/${b.subject}/${b.deriv}`));
  });
}

// The DD-6 observable-state snapshot: queued work, the view boundary/zone
// through status, derived-form rows, and the event log. A read that mutates
// any of these fails the before/after deep-equal.
async function observableState(fixture: ReadFixture): Promise<Record<string, unknown>> {
  return {
    events: await fixture.sdk.intakeStream.listEvents({ filePath: fixture.filePath }),
    work: await liveWork(fixture, fixture.threadId),
    viewStatus: await fixture.sdk.threadView.status({ filePath: fixture.filePath }),
    derivations: await derivedForms(fixture, fixture.threadId),
  };
}

describe("TC-3.1 / AC-3.1: listing order, fields, and bounds", () => {
  test("returns messages in record order with kind, token estimate, and turn membership", async () => {
    const fixture = await readFixture();
    const listed = await fixture.sdk.messages.list({ filePath: fixture.filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.map((m) => m.messageId)).toEqual(["m1", "m2", "m3", "m4", "m6", "m7"]);
    expect(listed.value.map((m) => m.sourceEventOrder)).toEqual([1, 2, 3, 4, 6, 7]);
    expect(listed.value.map((m) => m.kind)).toEqual([
      "user_prompt",
      "assistant_text",
      "tool_call",
      "tool_result",
      "user_prompt",
      "assistant_text",
    ]);
    expect(listed.value.map((m) => m.turnId)).toEqual(["t1", "t1", "t1", "t1", "t2", "t2"]);
    for (const record of listed.value) {
      expect(record.tokenEstimate).toBeGreaterThan(0);
      expect(record.deleted).toBeUndefined();
    }
  });

  test("honors from/to/limit windows exactly in source-event-order coordinates", async () => {
    const fixture = await readFixture();
    const windows: Array<[{ from?: number; to?: number; limit?: number }, string[]]> = [
      [{ from: 2, to: 4 }, ["m2", "m3", "m4"]],
      [{ from: 6 }, ["m6", "m7"]],
      [{ to: 2 }, ["m1", "m2"]],
      [{ limit: 3 }, ["m1", "m2", "m3"]],
      [{ from: 2, limit: 2 }, ["m2", "m3"]],
      [{ from: 4, to: 4 }, ["m4"]],
      [{ from: 5, to: 5 }, []], // the turn_end order: an event, never a message
    ];
    for (const [opts, expected] of windows) {
      expect(idsOf(await fixture.sdk.messages.list({ filePath: fixture.filePath }, opts))).toEqual(expected);
    }
  });

  test("refuses bad bounds as caller errors and returns no partial window", async () => {
    const fixture = await readFixture();
    const badBounds = [{ from: 5, to: 2 }, { limit: 0 }, { limit: -1 }, { from: 1.5 }];
    for (const opts of badBounds) {
      const refused = await fixture.sdk.messages.list({ filePath: fixture.filePath }, opts);
      expect(refused.ok).toBe(false);
      if (refused.ok) continue;
      expect(refused.error.errorClass).toBe("caller_error");
      expect(refused.error.code).toBe("invalid_bounds");
    }
  });
});

describe("TC-3.2 / AC-3.2: show returns the full record with owner-reported forms", () => {
  test("a drained tool-result message comes back with full content, form states, and outcome metadata", async () => {
    const fixture = await readFixture();
    const shown = await fixture.sdk.messages.show({ filePath: fixture.filePath }, "m4");
    expect(shown.ok).toBe(true);
    if (!shown.ok) return;
    const detail = shown.value;
    expect(detail.messageId).toBe("m4");
    expect(detail.kind).toBe("tool_result");
    expect(detail.turnId).toBe("t1");
    expect(detail.deleted).toBe(false);
    expect(detail.tokenEstimate).toBeGreaterThan(0);
    // The record, not the view: the complete original tool result verbatim.
    expect(detail.blocks).toHaveLength(1);
    expect(detail.blocks[0]?.blockType).toBe("tool_result");
    expect(detail.blocks[0]?.content["content"]).toBe(TOOL_RESULT_CONTENT);
    expect(detail.blocks[0]?.content["toolCallId"]).toBe("call-read-1");
    // Forms with states and tool-outcome metadata, joined from the owner.
    expect(detail.derivations).toHaveLength(1);
    const summary = detail.derivations[0];
    expect(summary?.derivationType).toBe("tool_result_summary");
    expect(summary?.state).toBe("ready");
    expect(summary?.content).toBeDefined();
    expect(summary?.metadata?.outcome).toBe("succeeded");
    // Anti-shim: the forms ARE the owner report's entries for this message,
    // never a synthesized join (DD-2).
    const report = await fixture.sdk.messages.report({ filePath: fixture.filePath }, { messageId: "m4" });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(detail.derivations).toEqual(report.value);
  });

  test("a drained prompt shows its smoothing form alongside the full record", async () => {
    const fixture = await readFixture();
    const shown = await fixture.sdk.messages.show({ filePath: fixture.filePath }, "m1");
    expect(shown.ok).toBe(true);
    if (!shown.ok) return;
    expect(shown.value.blocks[0]?.content["text"]).toBe("please read notes.txt");
    expect(shown.value.derivations.map((form) => [form.derivationType, form.state])).toEqual([
      ["smoothed_prompt", "ready"],
    ]);
  });
});

describe("TC-3.3 / AC-3.3: deleted messages are audit-visible, never silently mixed", () => {
  test("default list excludes a deleted message; include-deleted lists it marked; show returns it flagged", async () => {
    const fixture = await readFixture();
    const deleted = await fixture.sdk.messages.remove({ filePath: fixture.filePath }, { messageId: "m2" });
    expect(deleted.ok).toBe(true);

    const defaultList = await fixture.sdk.messages.list({ filePath: fixture.filePath });
    expect(idsOf(defaultList)).toEqual(["m1", "m3", "m4", "m6", "m7"]);

    const audited = await fixture.sdk.messages.list({ filePath: fixture.filePath }, { includeDeleted: true });
    expect(audited.ok).toBe(true);
    if (!audited.ok) return;
    expect(audited.value.map((m) => m.messageId)).toEqual(["m1", "m2", "m3", "m4", "m6", "m7"]);
    for (const record of audited.value) {
      if (record.messageId === "m2") expect(record.deleted).toBe(true);
      else expect(record.deleted).toBeUndefined();
    }

    // Show on the deleted message is the audit read: the record, flagged —
    // never a not-found.
    const shown = await fixture.sdk.messages.show({ filePath: fixture.filePath }, "m2");
    expect(shown.ok).toBe(true);
    if (!shown.ok) return;
    expect(shown.value.deleted).toBe(true);
    expect(shown.value.blocks[0]?.content["text"]).toBe("reading it now");
  });

  test("show on a missing id is message_not_found", async () => {
    const fixture = await readFixture();
    const missing = await fixture.sdk.messages.show({ filePath: fixture.filePath }, "m99");
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.errorClass).toBe("caller_error");
    expect(missing.error.code).toBe("message_not_found");
  });
});

describe("architecture risk: reads are read-only and inference-free (DD-6)", () => {
  test("list and show leave observable state unchanged and call no model", async () => {
    const fixture = await readFixture();
    resetCapturedCalls();
    const before = await observableState(fixture);

    await fixture.sdk.messages.list({ filePath: fixture.filePath });
    await fixture.sdk.messages.list({ filePath: fixture.filePath }, { from: 2, to: 4, limit: 2 });
    await fixture.sdk.messages.list({ filePath: fixture.filePath }, { includeDeleted: true });
    await fixture.sdk.messages.list({ filePath: fixture.filePath }, { from: 9, to: 1 }); // refused, must not write
    await fixture.sdk.messages.show({ filePath: fixture.filePath }, "m4");
    await fixture.sdk.messages.show({ filePath: fixture.filePath }, "m99"); // not-found, must not write

    const after = await observableState(fixture);
    expect(after).toEqual(before);
    expect(capturedCalls).toHaveLength(0);
  });
});

// A thread with live, undrained work: one tool turn through a manual SDK
// (never drained), leaving pending forms and their queue rows. Reads against
// it must return the pending records without advancing any form or calling a
// model — the read surface is a set of pure Convex queries that can schedule
// no catch-up work.
async function pendingWorkThread(): Promise<ReadFixture> {
  const fixture = serviceFixture();
  const { filePath, threadId } = await fixture.createThread();
  await send(fixture.sdk, filePath, [
    validEvent("user_prompt", { payload: { text: "background prompt" } }),
    validEvent("tool_call", {
      payload: { toolCallId: "call-bg-1", toolName: "read_file", arguments: { path: "bg.txt" } },
    }),
    validEvent("tool_result", { payload: { toolCallId: "call-bg-1", content: "background output", isError: false } }),
    validEvent("assistant_text", { payload: { text: "background answer" } }),
    validEvent("turn_end"),
  ]);
  return { ...fixture, filePath, threadId };
}

describe("architecture risk: reads over undrained work advance nothing and call no model (DD-6)", () => {
  test("list and show against pending work call no model and move no form or work-item row", async () => {
    const fixture = await pendingWorkThread();
    resetCapturedCalls();
    const beforeWork = await liveWork(fixture, fixture.threadId);
    const beforeForms = await derivedForms(fixture, fixture.threadId);

    const listed = await fixture.sdk.messages.list({ filePath: fixture.filePath });
    await fixture.sdk.messages.list({ filePath: fixture.filePath }, { limit: 1 });
    const shown = await fixture.sdk.messages.show({ filePath: fixture.filePath }, "m1");
    expect(listed.ok && shown.ok).toBe(true);
    if (!listed.ok || !shown.ok) return;

    // The reads ran against the live, undrained queue — the records carry
    // their pending forms — so this is no vacuous pass on an empty thread.
    const listedForms = listed.value.flatMap((m) => m.derivations ?? []);
    expect(listedForms.length).toBeGreaterThan(0);
    expect(listedForms.every((form) => form.state === "pending")).toBe(true);
    expect(shown.value.derivations.map((form) => form.state)).toEqual(["pending"]);

    // Reads only: every work-item and form row is exactly as before, and no
    // model call fired.
    expect(await liveWork(fixture, fixture.threadId)).toEqual(beforeWork);
    expect(await derivedForms(fixture, fixture.threadId)).toEqual(beforeForms);
    expect(capturedCalls).toHaveLength(0);
  });
});
