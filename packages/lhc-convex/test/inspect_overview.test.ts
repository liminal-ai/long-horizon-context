// Story 2 (Epic 04): TC-1.1-1.3 — the inspect overview. One read-only call
// composing thread identity, event/message/turn/chunk counts, derivation
// states, view summary, and visibility from the other domains' surfaces.
// Every thread shape returns the FULL shape with absent pieces as zeros/nulls
// (AC-1.3); counts honor the deleted contract (AC-1.2); the read is pure
// (AC-1.4) — asserted as absence of delta and zero model calls. The frozen
// "throwing inference callback" structural proof has no analog here: inspect
// reads are Convex queries and cannot reach the model-call action at all, so
// the zero-model guarantee is proven through the shared host's captured calls.
import { describe, expect, test } from "vitest";
import type { InspectOverview, Lhc, MessageEventInput } from "../src/client/index.js";
import { capturedCalls, resetCapturedCalls } from "./convex/model.js";
import { derivedThreadFixture, type ServiceFixture, serviceFixture, validEvent } from "./fixtures/index.js";

async function send(sdk: Lhc, filePath: string, batch: readonly MessageEventInput[]): Promise<void> {
  const sent = await sdk.intakeStream.messageEvents({ filePath }, batch);
  if (!sent.ok) throw new Error(`fixture batch failed: ${sent.error.reason}`);
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

async function rawBoundary(fixture: ServiceFixture): Promise<number | null> {
  return await fixture.test.run(async (ctx) => {
    const rows = await ctx.db.query("viewBoundaries").collect();
    const row = rows.find((candidate) => candidate.instance === fixture.instance);
    return row === undefined ? null : row.position;
  });
}

function overviewValue(result: { ok: boolean }): InspectOverview {
  if (!result.ok) throw new Error(`expected ok overview: ${JSON.stringify(result)}`);
  return (result as { ok: true; value: InspectOverview }).value;
}

const ZERO_DERIVATION = { ready: 0, pending: 0, failed: 0, blocked: 0 };

interface SmallThread extends ServiceFixture {
  filePath: string;
  threadId: string;
}

// Two closed turns through real intake, fully drained: m1 prompt, m2 text,
// m3 call, m4 result (t1; turn_end is event 5), m6 prompt, m7 text (t2;
// turn_end is event 8). Never compacted.
async function twoTurnThread(): Promise<SmallThread> {
  const fixture = serviceFixture();
  const { filePath, threadId } = await fixture.createThread("overview-two-turn", { title: "overview fixture" });
  await send(fixture.sdk, filePath, [
    validEvent("user_prompt", { payload: { text: "please read notes.txt" } }),
    validEvent("assistant_text", { payload: { text: "reading it now" } }),
    validEvent("tool_call", {
      payload: { toolCallId: "call-ov-1", toolName: "read_file", arguments: { path: "notes.txt" } },
    }),
    validEvent("tool_result", {
      payload: { toolCallId: "call-ov-1", content: "contents of notes.txt", isError: false },
    }),
    validEvent("turn_end"),
  ]);
  await send(fixture.sdk, filePath, [
    validEvent("user_prompt", { payload: { text: "summarize what you read" } }),
    validEvent("assistant_text", { payload: { text: "here is the summary" } }),
    validEvent("turn_end"),
  ]);
  const drained = await fixture.sdk.work.drain({ filePath });
  if (!drained.ok || drained.value.remaining !== 0) throw new Error("fixture drain left work behind");
  return { ...fixture, filePath, threadId };
}

// The tool-heavy 12-turn fixture with the two scripted tool_result_summary
// failures reached through real terminal state, then compacted.
async function compactedFailedFixture() {
  const fixture = await derivedThreadFixture();
  await fixture.test.run(async (ctx) => {
    const rows = await ctx.db.query("derivations").collect();
    const summaries = rows.filter(
      (row) =>
        row.instance === fixture.instance &&
        row.thread === fixture.threadId &&
        row.scope === "message" &&
        row.deriv === "tool_result_summary",
    );
    for (const index of [2, 4]) {
      const target = summaries[index];
      if (target === undefined) throw new Error("fixture tool summaries missing");
      await ctx.db.patch("derivations", target._id, {
        state: "failed",
        content: undefined,
        reason: "rate_limit: scripted failure (fixture)",
        metadata: undefined,
        derivedAt: "2026-01-01T00:00:00.000Z",
      });
    }
  });
  const compacted = await fixture.sdk.threadView.compact({ filePath: fixture.filePath }, {});
  if (!compacted.ok) throw new Error(`fixture compact failed: ${compacted.error.reason}`);
  return { ...fixture, compactReceipt: compacted.value };
}

// The mutation-in-flight variant: the tool-heavy thread (no failures)
// compacted, then ONE edit applied through the production mutation path with
// the drain NOT run — the cascade's cleared-pending states and queued work
// are real production states.
async function mutationInFlightVariant() {
  const fixture = await derivedThreadFixture();
  const compacted = await fixture.sdk.threadView.compact({ filePath: fixture.filePath }, {});
  if (!compacted.ok) throw new Error(`fixture compact failed: ${compacted.error.reason}`);
  const listed = await fixture.sdk.messages.list({ filePath: fixture.filePath });
  if (!listed.ok) throw new Error(`fixture list failed: ${listed.error.reason}`);
  const target = listed.value.find((record) => record.kind === "user_prompt" && record.turnId === "t2");
  if (target === undefined) throw new Error("fixture invariant: turn 2 carries no prompt message");
  const edited = await fixture.sdk.messages.edit(
    { filePath: fixture.filePath },
    { messageId: target.messageId, content: "turn 2 revised: investigate area 2 again" },
  );
  if (!edited.ok) throw new Error(`fixture edit failed: ${edited.error.reason}`);
  return { ...fixture, compactReceipt: compacted.value, editedMessageId: target.messageId, mutation: edited.value };
}

describe("TC-1.1 / AC-1.1, AC-1.3: full overview shape across thread shapes", () => {
  test("fresh-empty: full shape with zeros and nulls, never omitted fields", async () => {
    const fixture = serviceFixture();
    const { threadId } = await fixture.createThread("overview-empty");

    const overview = overviewValue(await fixture.sdk.inspect.overview({ filePath: "overview-empty" }));
    expect(overview.thread.id).toBe(threadId);
    expect(typeof overview.thread.createdAt).toBe("string");
    expect(overview.events).toEqual({ count: 0, span: null });
    expect(overview.messages).toEqual({ visible: 0, byKind: {}, deleted: 0, visibleTokens: 0 });
    expect(overview.turns).toEqual({ open: 1, closed: 0 });
    expect(overview.chunks).toEqual({ count: 0, unchunkedTurns: 0 });
    expect(overview.derivation).toEqual(ZERO_DERIVATION);
    expect(overview.view).toBeNull();
    expect(overview.visibility).toEqual({ boundaryPosition: 0, zoneTokens: 0 });
  });

  test("mid-first-turn: open turn, queued derivation, no view — full shape", async () => {
    const fixture = serviceFixture();
    await fixture.createThread("overview-mid");
    await send(fixture.sdk, "overview-mid", [
      validEvent("user_prompt", { payload: { text: "first prompt, turn still open" } }),
      validEvent("assistant_thinking", { payload: { text: "thinking about it" } }),
    ]);

    const overview = overviewValue(await fixture.sdk.inspect.overview({ filePath: "overview-mid" }));
    expect(overview.events).toEqual({ count: 2, span: { first: 1, last: 2 } });
    expect(overview.messages.visible).toBe(2);
    expect(overview.messages.byKind).toEqual({ user_prompt: 1, assistant_thinking: 1 });
    expect(overview.messages.deleted).toBe(0);
    expect(overview.messages.visibleTokens).toBeGreaterThan(0);
    expect(overview.turns).toEqual({ open: 1, closed: 0 });
    expect(overview.chunks).toEqual({ count: 0, unchunkedTurns: 0 });
    // The prompt's smoothing sits queued, never attempted: pending.
    expect(overview.derivation).toEqual({ ...ZERO_DERIVATION, pending: 1 });
    expect(overview.view).toBeNull();
    expect(overview.visibility.boundaryPosition).toBe(0);
  });

  test("never-compacted-with-record: real counts, view null", async () => {
    const { filePath, threadId, sdk } = await twoTurnThread();
    const overview = overviewValue(await sdk.inspect.overview({ filePath }));
    expect(overview.thread.id).toBe(threadId);
    expect(overview.events).toEqual({ count: 8, span: { first: 1, last: 8 } });
    expect(overview.messages.visible).toBe(6);
    expect(overview.messages.byKind).toEqual({ user_prompt: 2, assistant_text: 2, tool_call: 1, tool_result: 1 });
    expect(overview.messages.deleted).toBe(0);
    expect(overview.turns).toEqual({ open: 1, closed: 2 });
    // Both closed turns placed by their derivations into the one open chunk.
    expect(overview.chunks).toEqual({ count: 1, unchunkedTurns: 0 });
    // 2 smoothings + 1 result summary + 2 turns × 3 forms.
    expect(overview.derivation).toEqual({ ...ZERO_DERIVATION, ready: 9 });
    expect(overview.view).toBeNull();
  });

  test("compacted tool-heavy fixture: exact counts in every section", async () => {
    const fixture = await compactedFailedFixture();
    const { filePath, sdk, compactReceipt } = fixture;

    const overview = overviewValue(await sdk.inspect.overview({ filePath }));
    expect(overview.events).toEqual({ count: 64, span: { first: 1, last: 64 } });
    expect(overview.messages.visible).toBe(52);
    expect(overview.messages.byKind).toEqual({
      user_prompt: 12,
      assistant_thinking: 12,
      assistant_text: 12,
      tool_call: 8,
      tool_result: 8,
    });
    expect(overview.messages.deleted).toBe(0);
    expect(overview.messages.visibleTokens).toBeGreaterThan(0);
    expect(overview.turns).toEqual({ open: 1, closed: 12 });
    expect(overview.chunks).toEqual({ count: 4, unchunkedTurns: 0 });
    // 12 smoothings + 6 ready result summaries + 36 turn forms + 6 chunk
    // summaries ready; the two scripted failures stay failed.
    expect(overview.derivation).toEqual({ ...ZERO_DERIVATION, ready: 60, failed: 2 });
    expect(overview.view).toEqual({
      viewId: compactReceipt.viewId,
      createdAt: expect.any(String),
      compactPoint: compactReceipt.compactPoint,
      coveredFrom: compactReceipt.coveredFrom,
    });
    // Visibility mirrors the durable boundary position and the zone sum status
    // computes live.
    const boundary = await rawBoundary(fixture);
    const status = await sdk.threadView.status({ filePath });
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(overview.visibility).toEqual({ boundaryPosition: boundary, zoneTokens: status.value.visibility.zoneTokens });
  });

  test("mid-rebuild: cleared cascade pending, view summary intact — full shape", async () => {
    const fixture = await mutationInFlightVariant();
    const overview = overviewValue(await fixture.sdk.inspect.overview({ filePath: fixture.filePath }));
    // The edit cleared exactly the cascade set — its own smoothing, t2's three
    // turn forms, c1's two chunk summaries — all pending, drain not run.
    expect(fixture.mutation.cleared).toHaveLength(6);
    expect(overview.derivation).toEqual({ ...ZERO_DERIVATION, ready: 56, pending: 6 });
    expect(overview.turns).toEqual({ open: 1, closed: 12 });
    expect(overview.chunks).toEqual({ count: 4, unchunkedTurns: 0 });
    // The view is the pre-edit compact's snapshot, untouched by the mutation.
    expect(overview.view).toEqual({
      viewId: fixture.compactReceipt.viewId,
      createdAt: expect.any(String),
      compactPoint: fixture.compactReceipt.compactPoint,
      coveredFrom: fixture.compactReceipt.coveredFrom,
    });
    expect(overview.events.count).toBe(64);
    expect(overview.messages.visible).toBe(52);
  });
});

describe("TC-1.2 / AC-1.2: deleted accounting", () => {
  test("deleting one message drops visible/kind/token counts, raises deleted, leaves events alone", async () => {
    const { filePath, sdk } = await twoTurnThread();
    const before = overviewValue(await sdk.inspect.overview({ filePath }));

    const listed = await sdk.messages.list({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const target = listed.value.find((record) => record.messageId === "m2");
    expect(target?.kind).toBe("assistant_text");
    if (target === undefined) return;

    const deleted = await sdk.messages.remove({ filePath }, { messageId: "m2" });
    expect(deleted.ok).toBe(true);

    const after = overviewValue(await sdk.inspect.overview({ filePath }));
    expect(after.messages.visible).toBe(before.messages.visible - 1);
    expect(after.messages.deleted).toBe(1);
    expect(after.messages.byKind).toEqual({
      ...before.messages.byKind,
      assistant_text: (before.messages.byKind["assistant_text"] ?? 0) - 1,
    });
    expect(after.messages.visibleTokens).toBe(before.messages.visibleTokens - target.tokenEstimate);
    // The record retains everything: event count and span are unaffected.
    expect(after.events).toEqual(before.events);
  });
});

describe("TC-1.3 / AC-1.4: overview is a pure read", () => {
  test("repeated calls are deep-equal, leave no delta, create no work, call no model", async () => {
    const fixture = await mutationInFlightVariant();
    const { filePath, sdk, threadId } = fixture;
    resetCapturedCalls();

    const observe = async () => ({
      events: await sdk.intakeStream.listEvents({ filePath }),
      work: await liveWork(fixture, threadId),
      viewStatus: await sdk.threadView.status({ filePath }),
      describe: await sdk.threadView.describe({ filePath }),
      derivations: await derivedForms(fixture, threadId),
    });

    const beforeState = await observe();
    const first = await sdk.inspect.overview({ filePath });
    const afterFirst = await observe();
    const second = await sdk.inspect.overview({ filePath });
    const afterSecond = await observe();

    expect(first.ok && second.ok).toBe(true);
    expect(second).toEqual(first);
    expect(afterFirst).toEqual(beforeState);
    expect(afterSecond).toEqual(beforeState);
    expect(capturedCalls).toHaveLength(0);
  });

  test("overview on a missing thread is thread_not_found, not a shape error", async () => {
    const fixture = serviceFixture();
    const missing = await fixture.sdk.inspect.overview({ filePath: "overview-missing" });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.errorClass).toBe("caller_error");
    expect(missing.error.code).toBe("thread_not_found");
  });
});
